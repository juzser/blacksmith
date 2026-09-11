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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SmithError } from './errors.js';
import { computeFingerprint, normalizeFilePath } from './findings.js';
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
