import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { type ArtifactCheck, type ArtifactDecl, checkArtifacts } from './artifacts.js';
import { type CommitCertificate, certifyCommit } from './commit.js';
import type { EventOpts } from './events.js';
// Type-only: gate.ts imports this module at runtime, so the reverse edge must not exist.
import type { DepsCheck } from './gate.js';
import { foldJudgeTurns, type JudgeTurn, outstandingJudges } from './judges.js';
import { readLineage } from './lineageSnapshot.js';
import {
  type CompiledSchemaSet,
  compileSchemas,
  type ValidationIssue,
  validateRecord,
} from './schemas.js';
import { loadTaxonomy, type Taxonomy } from './taxonomy.js';
import { evaluateUiux, screenshotSetComplete, type UiuxBlockReason } from './uiuxGate.js';

// The gate's read-only pre-test checks, one pure function per stage. `runGate` calls them
// and emits its events around them; `checkPaperwork` calls the same functions for a
// preflight, so the two cannot disagree. Nothing here writes an event, a result file or a
// judge-turn close.

export type PaperworkRole = 'coder' | 'tester' | 'grader' | 'gate';

export type PaperworkStage =
  | 'schema'
  | 'artifacts'
  | 'commit'
  | 'deps'
  | 'judges'
  | 'uiux'
  | 'screenshots'
  | 'grader';

export type PaperworkReason =
  | 'schema-invalid'
  | 'artifacts-missing'
  | 'not-committed'
  | 'deps-missing'
  | 'judges-outstanding'
  | UiuxBlockReason
  | 'grader-invalid';

/** Evaluation and report order. `screenshots` is the tester's own and is not in the gate's set. */
const STAGE_ORDER: readonly PaperworkStage[] = [
  'schema',
  'artifacts',
  'commit',
  'deps',
  'judges',
  'uiux',
  'screenshots',
  'grader',
];

/** What each hand-off can already satisfy; judge turns and the tester record exist only once the wave-runner has recorded them. */
export const STAGES_FOR_ROLE: Readonly<Record<PaperworkRole, readonly PaperworkStage[]>> = {
  coder: ['schema', 'artifacts', 'commit', 'deps'],
  tester: ['schema', 'artifacts', 'screenshots'],
  grader: ['grader'],
  gate: ['schema', 'artifacts', 'commit', 'deps', 'judges', 'uiux', 'grader'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- schema -----------------------------------------------------------------

let cachedTaxonomy: Taxonomy | undefined;
let cachedSchemas: CompiledSchemaSet | undefined;

export function resolveTaxonomyAndSchemas(opts: EventOpts): {
  taxonomy: Taxonomy;
  schemas: CompiledSchemaSet;
} {
  if (cachedTaxonomy === undefined) cachedTaxonomy = loadTaxonomy();
  if (cachedSchemas === undefined) cachedSchemas = compileSchemas(cachedTaxonomy);
  const taxonomy = opts.taxonomy ?? cachedTaxonomy;
  const schemas = opts.schemas ?? cachedSchemas;
  return { taxonomy, schemas };
}

export interface SchemaStage {
  ok: boolean;
  errors: ValidationIssue[];
  /** The `schema-check-result` payload. */
  payload: { valid: boolean; errors: ValidationIssue[] };
}

export function schemaStage(
  result: unknown,
  taxonomy: Taxonomy,
  schemas: CompiledSchemaSet,
): SchemaStage {
  const checked = validateRecord(schemas, taxonomy, 'result', result);
  const errors = checked.valid ? [] : checked.errors;
  return { ok: checked.valid, errors, payload: { valid: checked.valid, errors } };
}

// --- artifacts --------------------------------------------------------------

/**
 * The artifacts a result declares, or null when the document does not carry a
 * readable list: a stage that needs them is then skipped rather than guessed.
 */
export function declaredArtifacts(result: unknown): ArtifactDecl[] | null {
  if (!isRecord(result)) return null;
  const artifacts = result.artifacts;
  if (artifacts === undefined) return [];
  if (!Array.isArray(artifacts)) return null;
  return artifacts.every((a) => isRecord(a) && typeof a.path === 'string')
    ? (artifacts as ArtifactDecl[])
    : null;
}

export interface ArtifactsStage {
  ok: boolean;
  check: ArtifactCheck;
  /** The `artifact-check-result` payload. */
  payload: Pick<ArtifactCheck, 'ok' | 'checked' | 'home' | 'issues'>;
}

export function artifactsStage(
  artifacts: readonly ArtifactDecl[],
  opts: { taskId: string; artifactsDir?: string },
): ArtifactsStage {
  const check = checkArtifacts(artifacts, opts);
  return {
    ok: check.ok,
    check,
    payload: { ok: check.ok, checked: check.checked, home: check.home, issues: check.issues },
  };
}

/** `name-desktop-light.png` and the three siblings a visual pass has to cover. */
export const SCREENSHOT_RE = /-(desktop|mobile)-(light|dark)\.png$/;

export function screenshotsFromArtifacts(
  artifacts: readonly ArtifactDecl[],
): { path: string; viewport: string; theme: string }[] {
  const shots: { path: string; viewport: string; theme: string }[] = [];
  for (const a of artifacts) {
    const match = SCREENSHOT_RE.exec(a.path);
    const viewport = match?.[1];
    const theme = match?.[2];
    if (viewport !== undefined && theme !== undefined)
      shots.push({ path: a.path, viewport, theme });
  }
  return shots;
}

/** The tester's own check over the screenshots it declared: the same set test the gate's uiux stage applies to the tester's record. */
export function screenshotsStage(
  taskId: string,
  artifacts: readonly ArtifactDecl[],
  artifactsDir?: string,
): { ok: boolean; shots: { path: string; viewport: string; theme: string }[] } {
  const shots = screenshotsFromArtifacts(artifacts);
  return { ok: screenshotSetComplete(taskId, shots, artifactsDir), shots };
}

// --- commit -----------------------------------------------------------------

export interface CommitStage {
  ok: boolean;
  certificate: CommitCertificate;
  /** The `commit-check-result` payload. */
  payload: Record<string, unknown>;
}

export function commitStage(worktreeDir: string, baseRef?: string): CommitStage {
  const certificate = certifyCommit(worktreeDir, { ...(baseRef === undefined ? {} : { baseRef }) });
  return {
    ok: certificate.certified,
    certificate,
    payload: {
      certified: certificate.certified,
      reason: certificate.reason,
      head: certificate.head,
      branch: certificate.branch,
      dirty: certificate.dirty,
      base_ref: certificate.baseRef,
      base_sha: certificate.baseSha,
      commits_ahead: certificate.commitsAhead,
    },
  };
}

// --- deps -------------------------------------------------------------------

const BIN_DIR = path.join('node_modules', '.bin');

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** The body of gate.ts `checkWorktreeDeps`, which documents it. */
function inspectWorktreeDeps(worktreeDir: string): DepsCheck {
  let manifest: { dependencies?: unknown; devDependencies?: unknown };
  try {
    manifest = JSON.parse(readFileSync(path.join(worktreeDir, 'package.json'), 'utf8'));
  } catch (err) {
    // A malformed package.json is a real problem, but it is not THIS problem,
    // and blocking on it here would file a JSON syntax error under "you forgot
    // to install". The schema and test gates downstream get to say it.
    const why = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'has no' : 'has an unreadable';
    return {
      ok: true,
      declaresDependencies: false,
      detail: `${worktreeDir} ${why} package.json — nothing to install.`,
    };
  }

  const counts = (section: unknown): number =>
    typeof section === 'object' && section !== null ? Object.keys(section).length : 0;
  const declared = counts(manifest.dependencies) + counts(manifest.devDependencies);
  if (declared === 0) {
    return {
      ok: true,
      declaresDependencies: false,
      detail: 'package.json declares no dependencies — nothing to install.',
    };
  }

  if (isDirectory(path.join(worktreeDir, BIN_DIR))) {
    return {
      ok: true,
      declaresDependencies: true,
      detail: `${declared} dependencies declared and ${BIN_DIR} is present.`,
    };
  }

  return {
    ok: false,
    declaresDependencies: true,
    detail:
      `${declared} dependencies declared but ${BIN_DIR} is missing in ${worktreeDir}. ` +
      'Every check would resolve its binaries from a parent node_modules, so the ' +
      'result would describe some other tree. Run `pnpm install` in the worktree.',
  };
}

export interface DepsStage {
  ok: boolean;
  deps: DepsCheck;
  /** The `deps-check-result` payload. */
  payload: { ok: boolean; declares_dependencies: boolean; detail: string };
}

export function depsStage(worktreeDir: string): DepsStage {
  const deps = inspectWorktreeDeps(worktreeDir);
  return {
    ok: deps.ok,
    deps,
    payload: { ok: deps.ok, declares_dependencies: deps.declaresDependencies, detail: deps.detail },
  };
}

// --- judges -----------------------------------------------------------------

/** A judge turn the caller is about to close. `kind` is only meaningful for uiux. */
export interface AlsoReported {
  role: string;
  kind?: string | null;
}

export interface JudgesStage {
  ok: boolean;
  outstanding: JudgeTurn[];
  /** The `judges-outstanding` payload; emitted only when `ok` is false. */
  payload: { judges: { agent_role: string; round: number; declared_artifact: string }[] };
}

/** D-31 / P9-11: a judge still owed is an unknown. A turn in `alsoReported` counts as reported; nothing is closed. */
export function judgesStage(
  turns: readonly JudgeTurn[],
  alsoReported: readonly AlsoReported[] = [],
): JudgesStage {
  const outstanding = outstandingJudges(turns).filter(
    (t) => !alsoReported.some((r) => r.role === t.role && (r.kind ?? null) === t.kind),
  );
  return {
    ok: outstanding.length === 0,
    outstanding,
    payload: {
      judges: outstanding.map((j) => ({
        agent_role: j.role,
        round: j.round,
        declared_artifact: j.declaredArtifact,
      })),
    },
  };
}

// --- grader -----------------------------------------------------------------

/** One row of the grader's rubric, once it has validated. */
interface GradedCriterion {
  criterion: string;
  status: 'pass' | 'fail' | 'partial';
  evidence: string;
}

export interface GraderStage {
  /** Is the file shaped like a grader result at all? */
  shape: 'ok' | 'invalid';
  /** What the rubric says; null when the shape is invalid, so there is nothing to read. */
  rubric: 'met' | 'not-met' | 'not-graded' | null;
  /** The `grader-verdict` payload. */
  payload: Record<string, unknown>;
}

/**
 * The grader file's shape (`ok` or `invalid`) and its rubric verdict (D-34/P9-14). Only a bad
 * shape is a paperwork problem; the gate blocks a `not-met` or `not-graded` rubric as `grader-fail`.
 */
export function graderStage(
  verdictFile: unknown,
  taxonomy: Taxonomy,
  schemas: CompiledSchemaSet,
): GraderStage {
  const payloadOf = (extra: Record<string, unknown>): Record<string, unknown> => ({
    run_status: null,
    round: null,
    overall: null,
    failed_criteria: [],
    errors: [],
    ...extra,
  });

  if (!isRecord(verdictFile)) {
    return {
      shape: 'invalid',
      rubric: null,
      payload: payloadOf({
        verdict: 'invalid',
        errors: [{ path: '/', message: 'grader verdict file is not a JSON object' }],
      }),
    };
  }

  const runStatus = verdictFile.run_status;
  // `dead`: the task spec had no checkable acceptance criteria, not a missing structured_output.
  if (runStatus === 'dead') {
    return {
      shape: 'ok',
      rubric: 'not-graded',
      payload: payloadOf({ verdict: 'not-graded', run_status: runStatus }),
    };
  }

  const runStatusField = typeof runStatus === 'string' ? runStatus : null;
  const structured = verdictFile.structured_output;
  if (!isRecord(structured)) {
    return {
      shape: 'invalid',
      rubric: null,
      payload: payloadOf({
        verdict: 'invalid',
        run_status: runStatusField,
        errors: [
          {
            path: '/structured_output',
            message:
              'grader verdict must be at .structured_output (round, criteria, overall), per the grader Output contract',
          },
        ],
      }),
    };
  }

  const validation = validateRecord(schemas, taxonomy, 'grader-verdict', structured);
  if (!validation.valid) {
    return {
      shape: 'invalid',
      rubric: null,
      payload: payloadOf({
        verdict: 'invalid',
        run_status: runStatusField,
        errors: validation.errors,
      }),
    };
  }

  const criteria = structured.criteria as GradedCriterion[];
  // A fail or partial criterion under an overall pass: the per-criterion verdict carries the evidence.
  const failed = criteria.filter((c) => c.status !== 'pass');
  const met = structured.overall === 'pass' && failed.length === 0;

  return {
    shape: 'ok',
    rubric: met ? 'met' : 'not-met',
    payload: payloadOf({
      verdict: met ? 'met' : 'not-met',
      run_status: runStatusField,
      round: structured.round,
      overall: structured.overall,
      failed_criteria: failed,
      ...(Array.isArray(structured.gaps) ? { gaps: structured.gaps } : {}),
    }),
  };
}

// --- checkPaperwork ---------------------------------------------------------

export interface PaperworkInput {
  as: PaperworkRole;
  taskId: string;
  /** The complete result document, envelope stamped, as the gate takes it. */
  result: unknown;
  worktreeDir?: string;
  baseRef?: string;
  artifactsDir?: string;
  /** The whole grader file, as read off disk. */
  graderVerdict?: unknown;
  /** The plan's `ui_affecting` flag; absent means the plan could not resolve it. */
  uiAffecting?: boolean;
  /** Judge turns the caller is about to close: the judges and uiux stages count them as reported. */
  alsoReported?: readonly AlsoReported[];
}

export interface PaperworkProblem {
  stage: PaperworkStage;
  reason: PaperworkReason | 'screenshots-missing';
  /** The payload the gate emits for this stage. */
  detail: Record<string, unknown>;
}

export interface PaperworkSkip {
  stage: PaperworkStage;
  why: string;
}

export interface PaperworkResult {
  outcome: 'pass' | 'blocked';
  /** The first blocking reason, in the gate's stage order, among the role's stages. */
  reason?: PaperworkProblem['reason'];
  as: PaperworkRole;
  problems: PaperworkProblem[];
  skipped: PaperworkSkip[];
  /** A well-formed grader file's rubric verdict: reported, never blocking. */
  verdicts: { grader?: 'met' | 'fail' | 'not-graded' };
}

/**
 * Run the role's paperwork stages, read-only, and report every problem in the
 * gate's order. A stage outside the role's set is skipped as
 * `not-checked-for-<role>`; a stage whose input is absent is skipped as
 * `no-input`, and one whose input an earlier failure left unreadable as
 * `unreadable-input`. A skipped stage is never reported as passed.
 */
export async function checkPaperwork(
  input: PaperworkInput,
  ctx: { sessionId?: string },
  opts: EventOpts = {},
): Promise<PaperworkResult> {
  const { taxonomy, schemas } = resolveTaxonomyAndSchemas(opts);
  const inSet = new Set(STAGES_FOR_ROLE[input.as]);
  const problems: PaperworkProblem[] = [];
  const skipped: PaperworkSkip[] = [];
  const verdicts: PaperworkResult['verdicts'] = {};
  const skip = (stage: PaperworkStage, why: string) => skipped.push({ stage, why });
  const block = (
    stage: PaperworkStage,
    reason: PaperworkProblem['reason'],
    detail: Record<string, unknown>,
  ) => problems.push({ stage, reason, detail });

  const artifacts = declaredArtifacts(input.result);
  let head: string | undefined;
  let events: Awaited<ReturnType<typeof readLineage>> | undefined;
  const lineage = async () => {
    if (events === undefined) events = await readLineage(ctx.sessionId as string, opts);
    return events;
  };

  for (const stage of STAGE_ORDER) {
    if (!inSet.has(stage)) {
      skip(stage, `not-checked-for-${input.as}`);
      continue;
    }
    switch (stage) {
      case 'schema': {
        const r = schemaStage(input.result, taxonomy, schemas);
        if (!r.ok) block(stage, 'schema-invalid', r.payload);
        break;
      }
      case 'artifacts': {
        if (artifacts === null) {
          skip(stage, 'unreadable-input');
          break;
        }
        const r = artifactsStage(artifacts, {
          taskId: input.taskId,
          artifactsDir: input.artifactsDir,
        });
        if (!r.ok) block(stage, 'artifacts-missing', r.payload);
        break;
      }
      case 'commit': {
        if (input.worktreeDir === undefined) {
          skip(stage, 'no-input');
          break;
        }
        const r = commitStage(input.worktreeDir, input.baseRef);
        head = r.certificate.head ?? undefined;
        if (!r.ok) block(stage, 'not-committed', r.payload);
        break;
      }
      case 'deps': {
        if (input.worktreeDir === undefined) {
          skip(stage, 'no-input');
          break;
        }
        const r = depsStage(input.worktreeDir);
        if (!r.ok) block(stage, 'deps-missing', r.payload);
        break;
      }
      case 'judges': {
        if (ctx.sessionId === undefined) {
          skip(stage, 'no-input');
          break;
        }
        const turns = foldJudgeTurns(await lineage(), input.taskId);
        const r = judgesStage(turns, input.alsoReported);
        if (!r.ok) block(stage, 'judges-outstanding', r.payload);
        break;
      }
      case 'uiux': {
        if (ctx.sessionId === undefined || input.uiAffecting !== true) {
          skip(stage, 'no-input');
          break;
        }
        const r = evaluateUiux(
          await lineage(),
          {
            taskId: input.taskId,
            ...(head === undefined ? {} : { head }),
            artifactsDir: input.artifactsDir,
          },
          input.alsoReported,
        );
        if (r.outcome === 'blocked') block(stage, r.reason, {});
        break;
      }
      case 'screenshots': {
        if (artifacts === null) {
          skip(stage, 'unreadable-input');
          break;
        }
        // Only a ui-affecting task owes a screenshot set; the gate asks nothing of any other.
        if (input.uiAffecting !== true) {
          skip(stage, 'no-input');
          break;
        }
        const r = screenshotsStage(input.taskId, artifacts, input.artifactsDir);
        if (!r.ok) block(stage, 'screenshots-missing', { screenshots: r.shots });
        break;
      }
      case 'grader': {
        if (input.graderVerdict === undefined) {
          skip(stage, 'no-input');
          break;
        }
        const r = graderStage(input.graderVerdict, taxonomy, schemas);
        if (r.shape === 'invalid') {
          block(stage, 'grader-invalid', r.payload);
        } else if (r.rubric !== null) {
          verdicts.grader = r.rubric === 'not-met' ? 'fail' : r.rubric;
        }
        break;
      }
    }
  }

  const reason = problems[0]?.reason;
  return {
    outcome: reason === undefined ? 'pass' : 'blocked',
    ...(reason === undefined ? {} : { reason }),
    as: input.as,
    problems,
    skipped,
    verdicts,
  };
}
