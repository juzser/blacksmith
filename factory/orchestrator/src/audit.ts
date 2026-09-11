/**
 * `/bs audit` — the store, the fold and the two keys.
 *
 * `docs/specs/audit-command-scope.md` is the contract; this file implements
 * §3 (the two keys and the ranking) and §4 (the findings store). The parts
 * that are judgment rather than mechanism — which axis prompt to write, which
 * cluster is really one defect, which finding becomes epic scope — live in
 * `.claude/skills/bs/audit.md` and stop in front of the operator.
 *
 * Three things about this module are deliberate and easy to undo by accident:
 *
 * - **It is not `findings.ts`.** `factory/specs/schema/finding.schema.json`
 *   requires `task_id`, and an audit finding is project-shaped: it is about a
 *   file in somebody else's repo, raised before any task exists to own it. So
 *   the audit keeps its own store and never calls `smith findings raise`
 *   (spec §4.2). What it does reuse, unchanged, is `computeFingerprint` and
 *   `normalizeFilePath` — a second normalizer is a second implementation that
 *   is allowed to disagree with the one the fingerprints were built with.
 *
 * - **Status is a line, never an edit** (spec §4.3). The store is append-only
 *   JSONL and every view of it comes from a replay. A `fixed` finding whose
 *   fingerprint comes back is a regression, and the history has to be able to
 *   show both.
 *
 * - **The dedupe key and the convergence key are different instruments**
 *   (spec §3.1). The fingerprint answers "did I already raise this?"; it
 *   cannot answer "did two axes find the same defect?", because two axes
 *   describing one defect write two different summaries. Convergence keys on
 *   the normalized file path, produces a *candidate* cluster, and hands it
 *   over to be judged. Nothing here merges anything.
 */

import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { SmithError } from './errors.js';
import { appendEvent, type EventOpts, type StoredEvent } from './events.js';
import { computeFingerprint, type EventContext, normalizeFilePath } from './findings.js';
import { runGit } from './git.js';
import {
  checkWorktreeImmutable,
  fingerprintWorktree,
  type WorktreeDrift,
  type WorktreeFingerprint,
} from './immutability.js';
import { loadTaxonomy } from './taxonomy.js';

export class AuditError extends SmithError {}

/**
 * Four, fixed, and not operator-selectable in v1 (spec §2.1). A fifth axis is
 * a spec change, not a flag: the whole design rests on four returns whose
 * overlap is meaningful.
 */
export const AUDIT_AXES = ['performance', 'code-quality', 'architecture', 'security'] as const;
export type AuditAxis = (typeof AUDIT_AXES)[number];

/** Spec §4.3's table, in the order that table is written. */
export const AUDIT_STATUSES = ['raised', 'merged', 'accepted', 'declined', 'fixed'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

/** Spec §4.4. Applied when the store is folded, not by a sweeper. */
export const DECLINE_EXPIRY_DAYS = 90;

const STORE_DIR = '.blacksmith';
const STORE_FILE = 'findings.jsonl';

/**
 * Fields the store mints and the fold owns. An axis that supplies one of them
 * is claiming an identity it cannot know — the mirror of
 * `findings.evidence-carries-identity`, and refused for the same reason.
 */
const EVIDENCE_IDENTITY_FIELDS = [
  'fingerprint',
  'status',
  'axis',
  'audit_id',
  'ts',
  'epic',
  'same_as',
] as const;

export interface AuditFailureScenario {
  inputs: string;
  expected: string;
  actual: string;
}

/** What an axis reports, before the store has given it an identity. */
export interface AuditEvidenceItem {
  file_path: string;
  severity: string;
  summary: string;
  failure_scenario: AuditFailureScenario;
  confidence: number;
  [key: string]: unknown;
}

/** The body a `raised` line carries; decision lines carry none of it. */
export interface AuditFindingBody {
  axis: AuditAxis;
  severity: string;
  file_path: string;
  summary: string;
  failure_scenario: AuditFailureScenario;
  confidence: number;
}

/** One line of `<project>/.blacksmith/findings.jsonl`. */
export interface AuditLine extends Partial<AuditFindingBody> {
  fingerprint: string;
  status: AuditStatus;
  ts: string;
  audit_id?: string;
  session_id?: string;
  event_id?: string;
  /** Required by `merge`, refused by the other decisions (spec §6). */
  same_as?: string;
  /** Written by `audit cut` and `audit resolve`. */
  epic?: string;
  note?: string;
}

/** One fingerprint's whole story, replayed. */
export interface FoldedFinding extends AuditFindingBody {
  fingerprint: string;
  status: AuditStatus;
  statusTs: string;
  /**
   * A decline older than 90 days. Kept separate from `status` on purpose: the
   * line still says `declined` and the history must keep saying so. Only the
   * suppression it bought has run out (spec §4.4).
   */
  expired: boolean;
  /**
   * Whether an axis reporting this fingerprint again should be dropped.
   * Derived rather than read off `status`, because two statuses answer it
   * conditionally: `declined` suppresses only until it expires, and `fixed`
   * never suppresses at all — a fingerprint that returns after its epic
   * closed is a regression, and silently dropping it would hide exactly the
   * event worth seeing.
   */
  suppressesReraise: boolean;
  sameAs?: string;
  epic?: string;
  history: AuditLine[];
}

export interface PathCluster {
  filePath: string;
  /** Everything still standing on this path. A merged member is not here. */
  members: FoldedFinding[];
  /** What the operator already merged away, kept so the fold stays auditable. */
  mergedInto: { fingerprint: string; sameAs: string }[];
  /** Distinct axes among `members`. One axis, however many findings, is 1. */
  convergence: number;
  /** The most severe member's severity — a cluster is as bad as its worst. */
  severity: string;
  confidence: number;
}

export interface FoldOptions {
  now?: Date;
}

let cachedSeverities: readonly string[] | undefined;

function severities(): readonly string[] {
  if (cachedSeverities === undefined) {
    const declared = loadTaxonomy().dimensions.severity;
    if (declared === undefined || declared.length === 0) {
      throw new AuditError(
        'audit.no-severity-vocabulary',
        'factory/policies/taxonomy.yml declares no `severity` dimension to rank against',
      );
    }
    cachedSeverities = declared;
  }
  return cachedSeverities;
}

/** Index in the taxonomy list, which is written most-severe-first. */
function severityRank(severity: string): number {
  const rank = severities().indexOf(severity);
  return rank === -1 ? severities().length : rank;
}

function mostSevere(values: readonly string[]): string {
  const [worst] = [...values].sort((a, b) => severityRank(a) - severityRank(b));
  if (worst === undefined) {
    throw new AuditError(
      'audit.empty-cluster',
      'a cluster with no members has no severity to report',
      {},
    );
  }
  return worst;
}

/** `<project>/.blacksmith/findings.jsonl`, absolute (spec §4). */
export function auditStorePath(projectDir: string): string {
  return path.join(path.resolve(projectDir), STORE_DIR, STORE_FILE);
}

export function readAuditStore(projectDir: string): AuditLine[] {
  const storePath = auditStorePath(projectDir);
  if (!existsSync(storePath)) return [];
  const lines: AuditLine[] = [];
  const text = readFileSync(storePath, 'utf8');
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return;
    try {
      lines.push(JSON.parse(raw) as AuditLine);
    } catch (error) {
      throw new AuditError(
        'audit.store-unparseable',
        `${storePath}:${index + 1} is not JSON: ${(error as Error).message}`,
        { storePath, line: index + 1 },
      );
    }
  });
  return lines;
}

export function appendAuditLines(projectDir: string, lines: readonly AuditLine[]): void {
  if (lines.length === 0) return;
  const storePath = auditStorePath(projectDir);
  mkdirSync(path.dirname(storePath), { recursive: true });
  appendFileSync(storePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
}

function requireString(item: AuditEvidenceItem, field: string, index: number): string {
  const value = item[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuditError('audit.evidence-incomplete', `evidence[${index}] has no \`${field}\``, {
      index,
      field,
    });
  }
  return value;
}

/** A body with the identity the store will append it under. */
export interface NormalizedEvidence extends AuditFindingBody {
  fingerprint: string;
}

/**
 * Validate one axis's evidence and give each item its identity. Pure: it
 * touches no store, so `audit record` can fingerprint first and consult the
 * fold second.
 */
export function normalizeEvidence(
  axis: AuditAxis,
  evidence: readonly AuditEvidenceItem[],
): NormalizedEvidence[] {
  if (!AUDIT_AXES.includes(axis)) {
    throw new AuditError('audit.unknown-axis', `\`${axis}\` is not one of the four audit axes`, {
      axis,
      axes: [...AUDIT_AXES],
    });
  }
  return evidence.map((item, index) => {
    for (const field of EVIDENCE_IDENTITY_FIELDS) {
      if (item[field] !== undefined) {
        throw new AuditError(
          'audit.evidence-carries-identity',
          `evidence[${index}] sets \`${field}\`, which the store mints — an axis reports what it saw, not what it is`,
          { index, field },
        );
      }
    }
    const filePath = normalizeFilePath(requireString(item, 'file_path', index));
    const summary = requireString(item, 'summary', index);
    const severity = requireString(item, 'severity', index);
    if (!severities().includes(severity)) {
      throw new AuditError(
        'audit.unknown-severity',
        `evidence[${index}] grades \`${severity}\`, which taxonomy.yml does not declare`,
        { index, severity, severities: [...severities()] },
      );
    }
    const scenario = item.failure_scenario as Partial<AuditFailureScenario> | undefined;
    if (scenario === undefined || typeof scenario !== 'object') {
      throw new AuditError(
        'audit.evidence-incomplete',
        `evidence[${index}] has no \`failure_scenario\` — a finding with no failure to point at is an opinion`,
        { index, field: 'failure_scenario' },
      );
    }
    for (const leg of ['inputs', 'expected', 'actual'] as const) {
      if (typeof scenario?.[leg] !== 'string' || scenario[leg].trim() === '') {
        throw new AuditError(
          'audit.evidence-incomplete',
          `evidence[${index}] has no \`failure_scenario.${leg}\` — a finding with no failure to point at is an opinion`,
          { index, field: `failure_scenario.${leg}` },
        );
      }
    }
    const confidence = item.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
      throw new AuditError(
        'audit.evidence-incomplete',
        `evidence[${index}] has no numeric \`confidence\``,
        { index, field: 'confidence' },
      );
    }
    if (confidence < 0 || confidence > 1) {
      throw new AuditError(
        'audit.confidence-out-of-range',
        `evidence[${index}] reports confidence ${confidence}; the field is 0..1`,
        { index, confidence },
      );
    }
    const body: AuditFindingBody = {
      axis,
      severity,
      file_path: filePath,
      summary,
      failure_scenario: {
        inputs: scenario.inputs as string,
        expected: scenario.expected as string,
        actual: scenario.actual as string,
      },
      confidence,
    };
    return { fingerprint: fingerprintOf(body), ...body };
  });
}

/** The identity `audit record` appends a normalized body under. */
export function fingerprintOf(body: AuditFindingBody): string {
  return computeFingerprint({
    filePath: body.file_path,
    // The axis stands where a task finding's `finding_category` would. The
    // audit record has no category of its own, and the axis is the honest
    // mapping: two axes describing one file are meant to fingerprint apart,
    // because §3.1's convergence is what joins them, not the dedupe key.
    category: body.axis,
    summary: body.summary,
  });
}

function ageInDays(from: string, now: Date): number {
  const then = Date.parse(from);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then) / 86_400_000;
}

/** Replay the store. Spec §4.3 and §4.4 are both decided here and nowhere else. */
export function foldAuditStore(
  lines: readonly AuditLine[],
  opts: FoldOptions = {},
): FoldedFinding[] {
  const now = opts.now ?? new Date();
  const order: string[] = [];
  const histories = new Map<string, AuditLine[]>();
  for (const line of lines) {
    let history = histories.get(line.fingerprint);
    if (history === undefined) {
      history = [];
      histories.set(line.fingerprint, history);
      order.push(line.fingerprint);
    }
    history.push(line);
  }

  return order.map((fingerprint) => {
    const history = histories.get(fingerprint) as AuditLine[];
    const bodyLine = [...history].reverse().find((line) => line.status === 'raised');
    if (bodyLine === undefined) {
      throw new AuditError(
        'audit.decision-without-finding',
        `${fingerprint} carries decisions but no raised line to hang them off`,
        { fingerprint, statuses: history.map((line) => line.status) },
      );
    }
    const last = history[history.length - 1];
    if (last === undefined) {
      throw new AuditError(
        'audit.decision-without-finding',
        `${fingerprint} folded to an empty history`,
        { fingerprint },
      );
    }
    const expired = last.status === 'declined' && ageInDays(last.ts, now) > DECLINE_EXPIRY_DAYS;
    const suppressesReraise = last.status === 'declined' ? !expired : last.status !== 'fixed';
    const sameAs = [...history].reverse().find((line) => line.same_as !== undefined)?.same_as;
    const epic = [...history].reverse().find((line) => line.epic !== undefined)?.epic;
    return {
      fingerprint,
      axis: bodyLine.axis as AuditAxis,
      severity: bodyLine.severity as string,
      file_path: bodyLine.file_path as string,
      summary: bodyLine.summary as string,
      failure_scenario: bodyLine.failure_scenario as AuditFailureScenario,
      confidence: bodyLine.confidence as number,
      status: last.status,
      statusTs: last.ts,
      expired,
      suppressesReraise,
      ...(sameAs === undefined ? {} : { sameAs }),
      ...(epic === undefined ? {} : { epic }),
      history,
    };
  });
}

/**
 * The fingerprints an axis may not raise again. This is the whole of the
 * dedupe half of §3.1 — `audit record` drops what this names and appends the
 * rest.
 */
export function suppressedFingerprints(
  lines: readonly AuditLine[],
  opts: FoldOptions = {},
): Set<string> {
  return new Set(
    foldAuditStore(lines, opts)
      .filter((finding) => finding.suppressesReraise)
      .map((finding) => finding.fingerprint),
  );
}

function clusterOf(filePath: string, findings: readonly FoldedFinding[]): PathCluster {
  const members = findings.filter((finding) => finding.status !== 'merged');
  const mergedInto = findings
    .filter((finding) => finding.status === 'merged')
    .map((finding) => ({ fingerprint: finding.fingerprint, sameAs: finding.sameAs ?? '' }));
  const ranked = members.length > 0 ? members : findings;
  return {
    filePath,
    members,
    mergedInto,
    convergence: new Set(members.map((finding) => finding.axis)).size,
    severity: mostSevere(ranked.map((finding) => finding.severity)),
    confidence: Math.max(...ranked.map((finding) => finding.confidence)),
  };
}

/**
 * §3.1's convergence half. Groups on the normalized file path and hands the
 * clusters over — it does not merge them, and a cluster nobody merges stays
 * several findings.
 */
export function clusterByPath(findings: readonly FoldedFinding[]): PathCluster[] {
  const byPath = new Map<string, FoldedFinding[]>();
  for (const finding of findings) {
    const bucket = byPath.get(finding.file_path);
    if (bucket === undefined) byPath.set(finding.file_path, [finding]);
    else bucket.push(finding);
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([filePath, bucket]) => clusterOf(filePath, bucket));
}

/**
 * §3.2. Severity first, then convergence, then confidence — a high-confidence
 * S4 must never outrank a two-axis S2. The fourth key is the representative
 * fingerprint, so a full tie ranks the same way on every run rather than
 * inheriting the order the store happened to be written in.
 *
 * Only undecided findings are offered: a cluster whose members are all
 * accepted, declined, merged or fixed has already been answered, and putting
 * it back in front of the operator would read as a new question.
 */
export function rankClusters(clusters: readonly PathCluster[]): PathCluster[] {
  return clusters
    .map((cluster) => {
      const live = cluster.members.filter((finding) => finding.status === 'raised');
      if (live.length === 0) return undefined;
      return {
        ...cluster,
        members: live,
        convergence: new Set(live.map((finding) => finding.axis)).size,
        severity: mostSevere(live.map((finding) => finding.severity)),
        confidence: Math.max(...live.map((finding) => finding.confidence)),
      };
    })
    .filter((cluster): cluster is PathCluster => cluster !== undefined)
    .sort((a, b) => {
      const bySeverity = severityRank(a.severity) - severityRank(b.severity);
      if (bySeverity !== 0) return bySeverity;
      if (a.convergence !== b.convergence) return b.convergence - a.convergence;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      const left = representative(a);
      const right = representative(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

function representative(cluster: PathCluster): string {
  return [...cluster.members.map((finding) => finding.fingerprint)].sort()[0] ?? cluster.filePath;
}

// ---------------------------------------------------------------------------
// §6 — the verbs.
//
// Every verb takes the project directory as its positional and nothing reads a
// cwd. The one piece of state between verbs is `<project>/.blacksmith/audit.json`,
// the manifest of the open audit: `open` writes it, `record` reads the audit id
// off it, `close` reads its baseline fingerprint and deletes it. It lives under
// `.blacksmith/` because that is state (spec §1.3), and it is one file rather
// than a "current audit" pointer because a project has at most one worktree at
// the fixed audit path, so it has at most one open audit.
// ---------------------------------------------------------------------------

const MANIFEST_FILE = 'audit.json';

/** The worktree's name under `<parent>/.wt/<project>/`, beside the task worktrees. */
const AUDIT_WORKTREE_NAME = 'audit';

export const AUDIT_DECISIONS = ['accept', 'decline', 'merge'] as const;
export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

const STATUS_OF_DECISION: Record<AuditDecision, AuditStatus> = {
  accept: 'accepted',
  decline: 'declined',
  merge: 'merged',
};

/** `<project>/.blacksmith/audit.json`. */
export interface AuditManifest {
  audit_id: string;
  project: string;
  worktree: string;
  head: string | null;
  /** `fingerprintWorktree` at open; `close` verifies against it (spec §2.2). */
  fingerprint: WorktreeFingerprint;
  opened_at: string;
  session_id: string;
  event_id: string;
}

export function auditManifestPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), STORE_DIR, MANIFEST_FILE);
}

/**
 * Mirrors `taskWorktreeDir`: beside the clone, never inside it, so a project
 * outside this repo keeps its audit worktree outside it too.
 */
export function auditWorktreeDir(projectDir: string): string {
  const project = path.resolve(projectDir);
  return path.join(path.dirname(project), '.wt', path.basename(project), AUDIT_WORKTREE_NAME);
}

export function readAuditManifest(projectDir: string): AuditManifest | undefined {
  const manifestPath = auditManifestPath(projectDir);
  if (!existsSync(manifestPath)) return undefined;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as AuditManifest;
  } catch (error) {
    throw new AuditError(
      'audit.manifest-unparseable',
      `${manifestPath} is not JSON: ${(error as Error).message}`,
      { manifestPath },
    );
  }
}

function requireOpenAudit(projectDir: string): AuditManifest {
  const manifest = readAuditManifest(projectDir);
  if (manifest === undefined) {
    throw new AuditError(
      'audit.not-open',
      `no audit is open on ${path.resolve(projectDir)}: run \`smith audit open\` first`,
      { projectDir: path.resolve(projectDir), manifestPath: auditManifestPath(projectDir) },
    );
  }
  return manifest;
}

function requireGitProject(projectDir: string): string {
  const project = path.resolve(projectDir);
  if (!existsSync(project)) {
    throw new AuditError('audit.project-missing', `${project} does not exist`, { project });
  }
  try {
    runGit(project, ['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    throw new AuditError(
      'audit.not-a-git-repository',
      `${project} is not a git repository: ${(error as Error).message}`,
      { project },
    );
  }
  return project;
}

/** `<YYYYMMDD>-<8 hex>`: sortable by day, unique enough to name a worktree by. */
function mintAuditId(now: Date): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `${day}-${randomBytes(4).toString('hex')}`;
}

/**
 * The audit's events are ordinary events on the operator's session, stamped
 * with the project's name so the multi-project timeline can tell whose audit
 * this was (events.ts `project`). The actor defaults to `operator` for the
 * same reason `recordUserPrompt` defaults to `user`: every verb here is one
 * the operator runs, and a judge never writes the store.
 */
function emit(
  eventType: string,
  project: string,
  ctx: EventContext,
  opts: EventOpts,
  payload: Record<string, unknown>,
): Promise<StoredEvent> {
  return appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'operator',
      event_type: eventType,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      project: path.basename(project),
      payload,
    },
    opts,
  );
}

/** A folded finding without its replay, which is what a listing wants to print. */
export type AuditFindingView = Omit<FoldedFinding, 'history'>;

function view(finding: FoldedFinding): AuditFindingView {
  const { history: _history, ...rest } = finding;
  return rest;
}

export interface OpenAuditResult {
  audit_id: string;
  project: string;
  worktree: string;
  head: string | null;
  axes: readonly AuditAxis[];
  store: string;
  manifest: string;
  /** What the store already suppresses (spec §4.3) — the dedupe context. */
  live: AuditFindingView[];
  event_id: string;
}

/**
 * `audit open <project-dir>`. Resolves the project, creates `.blacksmith/`,
 * cuts the detached worktree at HEAD, fingerprints it, writes the manifest and
 * prints the axis manifest plus the store's live findings.
 *
 * The worktree is what every axis reads (spec §2.2): the project's own working
 * tree is never handed to a judge, so an audit cannot dirty it, and the
 * fingerprint taken here is what `close` verifies against.
 */
export async function openAudit(
  projectDir: string,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<OpenAuditResult> {
  const project = requireGitProject(projectDir);
  const existing = readAuditManifest(project);
  if (existing !== undefined) {
    throw new AuditError(
      'audit.already-open',
      `audit ${existing.audit_id} is already open on ${project} (worktree ${existing.worktree}): close it first`,
      { audit_id: existing.audit_id, worktree: existing.worktree },
    );
  }
  const worktree = auditWorktreeDir(project);
  if (existsSync(worktree)) {
    throw new AuditError(
      'audit.worktree-exists',
      `${worktree} already exists with no manifest naming it — a previous audit did not close; remove it with \`git worktree remove\` and retry`,
      { worktree },
    );
  }

  const now = new Date();
  const auditId = mintAuditId(now);
  mkdirSync(path.dirname(auditManifestPath(project)), { recursive: true });
  mkdirSync(path.dirname(worktree), { recursive: true });
  runGit(project, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  const head = runGit(worktree, ['rev-parse', 'HEAD']).trim();
  const fingerprint = fingerprintWorktree(worktree);

  const stored = await emit('audit-opened', project, ctx, opts, {
    audit_id: auditId,
    project,
    worktree,
    head,
    axes: [...AUDIT_AXES],
  });
  const manifest: AuditManifest = {
    audit_id: auditId,
    project,
    worktree,
    head,
    fingerprint,
    opened_at: now.toISOString(),
    session_id: ctx.sessionId,
    event_id: stored.event_id,
  };
  writeFileSync(auditManifestPath(project), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const live = foldAuditStore(readAuditStore(project), { now })
    .filter((finding) => finding.suppressesReraise)
    .map(view);
  return {
    audit_id: auditId,
    project,
    worktree,
    head,
    axes: AUDIT_AXES,
    store: auditStorePath(project),
    manifest: auditManifestPath(project),
    live,
    event_id: stored.event_id,
  };
}

export interface RecordAuditResult {
  audit_id: string;
  axis: AuditAxis;
  /** Fingerprints written as `raised`. */
  appended: string[];
  /** Fingerprints the fold already suppresses (spec §4.3), dropped unwritten. */
  suppressed: string[];
  event_id: string;
}

/**
 * `audit record <project-dir> --axis <axis> --evidence <file>`. Validates one
 * axis's evidence, fingerprints each item, drops what the fold suppresses and
 * appends the rest as `raised`. Two items in one file with one fingerprint are
 * one finding: the second is dropped too, or the store would carry a
 * duplicate the fold can never tell from a re-raise.
 */
export async function recordAudit(
  projectDir: string,
  axis: AuditAxis,
  evidence: unknown,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<RecordAuditResult> {
  const manifest = requireOpenAudit(projectDir);
  if (!Array.isArray(evidence)) {
    throw new AuditError(
      'audit.evidence-not-a-list',
      `an axis returns a JSON array of findings, not ${evidence === null ? 'null' : typeof evidence}`,
      { axis },
    );
  }
  const normalized = normalizeEvidence(axis, evidence as AuditEvidenceItem[]);
  const now = new Date();
  const suppressedSet = suppressedFingerprints(readAuditStore(projectDir), { now });
  const appended: NormalizedEvidence[] = [];
  const suppressed: string[] = [];
  const seen = new Set<string>();
  for (const item of normalized) {
    if (suppressedSet.has(item.fingerprint) || seen.has(item.fingerprint)) {
      suppressed.push(item.fingerprint);
      continue;
    }
    seen.add(item.fingerprint);
    appended.push(item);
  }

  const stored = await emit('audit-finding-raised', manifest.project, ctx, opts, {
    audit_id: manifest.audit_id,
    axis,
    appended: appended.length,
    suppressed: suppressed.length,
    fingerprints: appended.map((item) => item.fingerprint),
  });
  appendAuditLines(
    projectDir,
    appended.map((item) => ({
      ...item,
      status: 'raised' as const,
      ts: now.toISOString(),
      audit_id: manifest.audit_id,
      session_id: ctx.sessionId,
      event_id: stored.event_id,
    })),
  );
  return {
    audit_id: manifest.audit_id,
    axis,
    appended: appended.map((item) => item.fingerprint),
    suppressed,
    event_id: stored.event_id,
  };
}

export interface RankedCluster extends Omit<PathCluster, 'members'> {
  members: AuditFindingView[];
}

export interface ConsolidateAuditResult {
  project: string;
  store: string;
  /** Every fingerprint the store knows, by status, so the ranked list has a denominator. */
  counts: Record<AuditStatus, number>;
  clusters: RankedCluster[];
}

/**
 * `audit consolidate <project-dir>`. Pure read: fold, cluster by path, rank.
 * The clusters are candidates (spec §3.1) — the operator decides whether the
 * members of one are one defect, and `audit decide --decision merge` is how
 * that answer is recorded.
 */
export function consolidateAudit(
  projectDir: string,
  opts: FoldOptions = {},
): ConsolidateAuditResult {
  const project = path.resolve(projectDir);
  const findings = foldAuditStore(readAuditStore(project), opts);
  const counts = Object.fromEntries(AUDIT_STATUSES.map((status) => [status, 0])) as Record<
    AuditStatus,
    number
  >;
  for (const finding of findings) counts[finding.status] += 1;
  return {
    project,
    store: auditStorePath(project),
    counts,
    clusters: rankClusters(clusterByPath(findings)).map((cluster) => ({
      ...cluster,
      members: cluster.members.map(view),
    })),
  };
}

export interface DecideAuditInput {
  fingerprint: string;
  decision: AuditDecision;
  sameAs?: string;
  note?: string;
}

export interface DecideAuditResult {
  fingerprint: string;
  decision: AuditDecision;
  status: AuditStatus;
  same_as?: string;
  event_id: string;
}

/**
 * `audit decide`. Appends the operator's answer. A decision on a finding that
 * was already decided is allowed — the store is a history and the fold takes
 * the last word — but the finding must exist, `merge` must name a survivor,
 * and the other two must not.
 */
export async function decideAudit(
  projectDir: string,
  input: DecideAuditInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<DecideAuditResult> {
  const project = path.resolve(projectDir);
  if (!AUDIT_DECISIONS.includes(input.decision)) {
    throw new AuditError(
      'audit.unknown-decision',
      `\`${input.decision}\` is not a decision: accept, decline or merge`,
      { decision: input.decision, decisions: [...AUDIT_DECISIONS] },
    );
  }
  const findings = foldAuditStore(readAuditStore(project));
  const known = new Set(findings.map((finding) => finding.fingerprint));
  if (!known.has(input.fingerprint)) {
    throw new AuditError(
      'audit.unknown-finding',
      `no finding in ${auditStorePath(project)} has fingerprint ${input.fingerprint}`,
      { fingerprint: input.fingerprint },
    );
  }
  if (input.decision === 'merge') {
    if (input.sameAs === undefined) {
      throw new AuditError(
        'audit.merge-without-survivor',
        'merge needs --same-as: the fingerprint this finding is a duplicate of',
        { fingerprint: input.fingerprint },
      );
    }
    if (input.sameAs === input.fingerprint) {
      throw new AuditError(
        'audit.merge-into-self',
        `${input.fingerprint} cannot be merged into itself`,
        { fingerprint: input.fingerprint },
      );
    }
    if (!known.has(input.sameAs)) {
      throw new AuditError(
        'audit.unknown-survivor',
        `--same-as ${input.sameAs} names no finding in ${auditStorePath(project)}`,
        { fingerprint: input.fingerprint, same_as: input.sameAs },
      );
    }
  } else if (input.sameAs !== undefined) {
    throw new AuditError(
      'audit.same-as-refused',
      `--same-as belongs to merge; ${input.decision} names no other finding`,
      { fingerprint: input.fingerprint, decision: input.decision, same_as: input.sameAs },
    );
  }

  const status = STATUS_OF_DECISION[input.decision];
  const stored = await emit('audit-decision', project, ctx, opts, {
    fingerprint: input.fingerprint,
    decision: input.decision,
    status,
    ...(input.sameAs === undefined ? {} : { same_as: input.sameAs }),
    ...(input.note === undefined ? {} : { note: input.note }),
  });
  appendAuditLines(project, [
    {
      fingerprint: input.fingerprint,
      status,
      ts: new Date().toISOString(),
      session_id: ctx.sessionId,
      event_id: stored.event_id,
      ...(input.sameAs === undefined ? {} : { same_as: input.sameAs }),
      ...(input.note === undefined ? {} : { note: input.note }),
    },
  ]);
  return {
    fingerprint: input.fingerprint,
    decision: input.decision,
    status,
    ...(input.sameAs === undefined ? {} : { same_as: input.sameAs }),
    event_id: stored.event_id,
  };
}

export interface CutAuditInput {
  epicId: string;
  title: string;
}

export interface CutAuditResult {
  epic: string;
  project: string;
  findings: AuditFindingView[];
  /** A `factory/specs/roadmap.md` milestone block, ready to paste. */
  milestone: string;
  /** A `factory/specs/active/<epic>/epic-spec.md`, ready to write. */
  spec: string;
  event_id: string;
}

function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 8);
}

function severityCounts(findings: readonly AuditFindingBody[]): string {
  const counts = new Map<string, number>();
  for (const finding of findings)
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  return [...severities()]
    .filter((severity) => counts.has(severity))
    .map((severity) => `${counts.get(severity)} ${severity}`)
    .join(', ');
}

function auditIdsOf(findings: readonly FoldedFinding[]): string[] {
  const ids = new Set<string>();
  for (const finding of findings) {
    for (const line of finding.history) if (line.audit_id !== undefined) ids.add(line.audit_id);
  }
  return [...ids].sort();
}

/** One-line markdown for a finding, the way the roadmap goal and the spec table both cite it. */
function cite(finding: AuditFindingBody & { fingerprint: string }): string {
  return `**${shortFingerprint(finding.fingerprint)} (${finding.severity}, ${finding.axis})** \`${finding.file_path}\` — ${finding.summary}`;
}

function renderMilestone(
  input: CutAuditInput,
  project: string,
  findings: readonly FoldedFinding[],
): string {
  const audits = auditIdsOf(findings);
  const goal = [
    `Cut from audit ${audits.join(', ')} of \`${path.basename(project)}\` (${findings.length} accepted finding${findings.length === 1 ? '' : 's'}: ${severityCounts(findings)}).`,
    'Each finding below is one acceptance criterion; the plan decides the tasks.',
    ...findings.map((finding) => `${cite(finding)}.`),
  ].join(' ');
  return [
    `## ${input.title}`,
    `- id: ${input.epicId}`,
    '- status: planned',
    `- epics: [${input.epicId}]`,
    `- project: ${path.basename(project)}`,
    '- kind: product',
    `- goal: ${goal}`,
    '',
  ].join('\n');
}

function renderSpec(
  input: CutAuditInput,
  project: string,
  findings: readonly FoldedFinding[],
): string {
  const audits = auditIdsOf(findings);
  const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const table = [
    '| # | Finding | Sev | Axis | File | What is wrong |',
    '|---|---|---|---|---|---|',
    ...findings.map(
      (finding, index) =>
        `| ${index + 1} | \`${shortFingerprint(finding.fingerprint)}\` | ${finding.severity} | ${finding.axis} | \`${cell(finding.file_path)}\` | ${cell(finding.summary)} |`,
    ),
  ];
  const detail = findings.flatMap((finding) => [
    `### \`${shortFingerprint(finding.fingerprint)}\` — ${finding.summary}`,
    '',
    `- **Fingerprint** — \`${finding.fingerprint}\``,
    `- **Axis / severity / confidence** — ${finding.axis} / ${finding.severity} / ${finding.confidence}`,
    `- **File** — \`${finding.file_path}\``,
    `- **Inputs** — ${finding.failure_scenario.inputs}`,
    `- **Expected** — ${finding.failure_scenario.expected}`,
    `- **Actual** — ${finding.failure_scenario.actual}`,
    '',
  ]);
  return [
    `# Epic spec — \`${input.epicId}\``,
    '',
    `- **Epic id** — \`${input.epicId}\``,
    `- **Project** — \`${path.basename(project)}\` at \`${project}\`, and every worktree is placed beside that clone (\`AGENTS.md\` "Worktrees").`,
    `- **Roadmap milestone** — \`${input.epicId}\` in \`factory/specs/roadmap.md\`.`,
    `- **Provenance** — cut by \`smith audit cut\` from audit ${audits.join(', ')} (${findings.length} accepted finding${findings.length === 1 ? '' : 's'}: ${severityCounts(findings)}). Each finding carries this epic id in \`.blacksmith/findings.jsonl\`; \`smith audit resolve\` marks them fixed when the epic closes.`,
    '',
    '## What this epic is',
    '',
    `${input.title}. The findings below were raised by the audit's axes, consolidated by path, and accepted by the operator one by one; nothing here was inferred. Each row is one acceptance criterion: the finding's \`failure_scenario\` says what a passing build must no longer do.`,
    '',
    '## Acceptance criteria',
    '',
    ...table,
    '',
    '## Findings in full',
    '',
    ...detail,
  ].join('\n');
}

/**
 * `audit cut <project-dir> --epic <epic-id> --title <text>`. Renders the
 * roadmap milestone and the epic spec from the accepted findings and stamps
 * the epic id onto each of them. It renders rather than edits: the roadmap
 * belongs to the operator's clone of this factory, and where the milestone
 * goes in it is a judgment `/bs audit` makes in front of them (spec §5).
 *
 * An accepted finding already stamped with another epic is not offered — it is
 * that epic's scope. One stamped with this epic is offered again, so the cut
 * is repeatable.
 */
export async function cutAudit(
  projectDir: string,
  input: CutAuditInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<CutAuditResult> {
  const project = path.resolve(projectDir);
  const findings = foldAuditStore(readAuditStore(project)).filter(
    (finding) =>
      finding.status === 'accepted' &&
      (finding.epic === undefined || finding.epic === input.epicId),
  );
  if (findings.length === 0) {
    throw new AuditError(
      'audit.nothing-accepted',
      `no accepted finding in ${auditStorePath(project)} is free to cut: decide first, or every accepted one already belongs to another epic`,
      { epic: input.epicId },
    );
  }
  const stored = await emit('audit-cut', project, ctx, opts, {
    epic: input.epicId,
    title: input.title,
    fingerprints: findings.map((finding) => finding.fingerprint),
  });
  const ts = new Date().toISOString();
  appendAuditLines(
    project,
    findings
      .filter((finding) => finding.epic !== input.epicId)
      .map((finding) => ({
        fingerprint: finding.fingerprint,
        status: 'accepted' as const,
        ts,
        epic: input.epicId,
        session_id: ctx.sessionId,
        event_id: stored.event_id,
      })),
  );
  return {
    epic: input.epicId,
    project,
    findings: findings.map(view),
    milestone: renderMilestone(input, project, findings),
    spec: renderSpec(input, project, findings),
    event_id: stored.event_id,
  };
}

export interface ResolveAuditResult {
  epic: string;
  /** Fingerprints that got a `fixed` line now. */
  fixed: string[];
  /** Fingerprints the epic carried that were already fixed. */
  already: string[];
  event_id: string;
}

/**
 * `audit resolve <project-dir> --epic <epic-id>`. Appends a `fixed` line for
 * every finding the epic carried. Called from `/bs run`'s epic-close step, so
 * it is repeatable; an epic no finding carries is refused, because the likely
 * cause is a typo and a silent no-op would leave every finding open.
 */
export async function resolveAudit(
  projectDir: string,
  epicId: string,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<ResolveAuditResult> {
  const project = path.resolve(projectDir);
  const carried = foldAuditStore(readAuditStore(project)).filter(
    (finding) => finding.epic === epicId,
  );
  if (carried.length === 0) {
    throw new AuditError(
      'audit.unknown-epic',
      `no finding in ${auditStorePath(project)} carries epic ${epicId}: was it cut with \`smith audit cut\`?`,
      { epic: epicId },
    );
  }
  const open = carried.filter((finding) => finding.status !== 'fixed');
  const stored = await emit('audit-resolved', project, ctx, opts, {
    epic: epicId,
    fixed: open.map((finding) => finding.fingerprint),
  });
  const ts = new Date().toISOString();
  appendAuditLines(
    project,
    open.map((finding) => ({
      fingerprint: finding.fingerprint,
      status: 'fixed' as const,
      ts,
      epic: epicId,
      session_id: ctx.sessionId,
      event_id: stored.event_id,
    })),
  );
  return {
    epic: epicId,
    fixed: open.map((finding) => finding.fingerprint),
    already: carried
      .filter((finding) => finding.status === 'fixed')
      .map((finding) => finding.fingerprint),
    event_id: stored.event_id,
  };
}

export interface CloseAuditInput {
  /** Remove the worktree even though it moved. The drift is still reported. */
  force?: boolean;
}

export interface CloseAuditResult {
  audit_id: string;
  worktree: string;
  /** `false` when the worktree had already gone before close ran. */
  verified: boolean;
  unchanged: boolean;
  drift: WorktreeDrift[];
  event_id: string;
}

/**
 * `audit close <project-dir> [--force]`. Verifies the worktree against the
 * fingerprint `open` took, removes it, deletes the manifest and closes the
 * audit in the event log. A worktree that moved is refused (spec §2.2): the
 * findings recorded against it may describe a tree nobody audited, and the
 * operator decides whether that matters, not this verb.
 */
export async function closeAudit(
  projectDir: string,
  input: CloseAuditInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<CloseAuditResult> {
  const manifest = requireOpenAudit(projectDir);
  const present = existsSync(manifest.worktree);
  const check = present
    ? checkWorktreeImmutable(manifest.worktree, manifest.fingerprint)
    : { unchanged: true, drift: [] as WorktreeDrift[] };
  if (!check.unchanged && input.force !== true) {
    throw new AuditError(
      'audit.worktree-moved',
      `${manifest.worktree} is not the tree audit ${manifest.audit_id} opened: ${check.drift.map((d) => `${d.kind} ${d.path}`).join(', ')} — pass --force to close anyway`,
      { audit_id: manifest.audit_id, worktree: manifest.worktree, drift: check.drift },
    );
  }
  if (present) {
    runGit(manifest.project, [
      'worktree',
      'remove',
      ...(check.unchanged ? [] : ['--force']),
      manifest.worktree,
    ]);
  }
  const stored = await emit('audit-closed', manifest.project, ctx, opts, {
    audit_id: manifest.audit_id,
    worktree: manifest.worktree,
    verified: present,
    unchanged: check.unchanged,
    drift: check.drift,
    forced: input.force === true,
  });
  rmSync(auditManifestPath(manifest.project));
  return {
    audit_id: manifest.audit_id,
    worktree: manifest.worktree,
    verified: present,
    unchanged: check.unchanged,
    drift: check.drift,
    event_id: stored.event_id,
  };
}
