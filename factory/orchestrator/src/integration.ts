import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { SmithError } from './errors.js';
import {
  appendEvent,
  type EventOpts,
  readLineageEvents,
  type StoredEvent,
  validateEventEnvelope,
} from './events.js';
import type { EventContext } from './findings.js';
import type { DepsCheck } from './gate.js';
import { runGit as git, runGitRaw } from './git.js';
import { pidIsAlive } from './heavyLock.js';
import { WORK_ROOT } from './paths.js';
import {
  CHECK_TIERS,
  type CheckCommand,
  type CheckEnvironment,
  type CheckResult,
  type CheckTier,
  checkDigest,
  checkTier,
  type EnvironmentSources,
  isNotRun,
  maskCommandCredentials,
  run,
  selectTier,
  sleptFailedChecks,
} from './testgate.js';
import {
  epicBranchPrefix,
  integrationBranchName,
  parseWorktreePorcelain,
  RESERVED_TASK_ID,
} from './worktree.js';

/**
 * D-42/P9-26, second half. Moving the worktrees outside the project root
 * (worktree.ts) fixes the tool that went red; it does not fix the reason
 * nobody noticed for six tasks. Every check this factory runs — schema,
 * tests, lint, review — runs inside a task worktree, so every quality claim
 * it makes is a claim about a worktree. The assembled integration branch had
 * never had one command run against it when the epic was declared shippable.
 * The run that caught D-42 took eleven seconds and happened because a human
 * typed it.
 *
 * This module is that run, as a logged fact: the full check suite, executed
 * at the project root while the integration branch is checked out, recorded
 * as an `integration-check` event that epic.ts's verdict gate then requires.
 *
 * It REFUSES rather than acts in the two cases where acting would be worse
 * than stopping — a project that isn't on the integration branch (checking
 * it out would be a destructive git op on the operator's own clone) and a
 * dirty working tree (the checks would certify something that is not the
 * branch). Both are one operator command away from fixed, and both are
 * silent corruption of the record if guessed at.
 */
export class IntegrationCheckError extends SmithError {}

export const INTEGRATION_CHECK_EVENT = 'integration-check';

/** One recorded run of the check suite against an epic's assembled branch. */
export interface IntegrationCheckRecord {
  epicId: string;
  branch: string;
  /** The commit the checks actually ran against — what makes a record stale or current. */
  headSha: string;
  pass: boolean;
  results: CheckResult[];
  eventId: string;
  ts: string;
  /** Set by `runIntegrationCheck` to what it wrote; the readers below never set them. */
  tiers?: CheckTier[];
  tiersPresent?: CheckTier[];
  treeSha?: string;
  notRun?: string[];
  probeOf?: string;
  environment?: CheckEnvironment[];
  errorClass?: 'execution.env-failure';
  environmentEvidence?: CheckEnvironment[];
}

/** Resolve symlinks where the path exists (macOS tmp is `/var` -> `/private/var`). */
function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The work-root prefix (`.blacksmith/`) relative to `projectDir`, or null when
 * the work root is the project itself or lies outside it (a clone, `BS_HOME`).
 */
function workRootPrefix(projectDir: string, workRoot: string): string | null {
  const rel = path.relative(realOrResolved(projectDir), realOrResolved(workRoot));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return `${rel.split(path.sep).join('/')}/`;
}

/**
 * Status entries that make the tree dirty for a check run. Untracked files
 * under the work root are declarations the operator has yet to commit (`bs
 * init` ignores only state/, workspaces/ and .env there); they cannot change
 * what a check runs. Tracked changes anywhere, and untracked files elsewhere,
 * still count. `--untracked-files=all` explicitly: see D-178 at the call site.
 */
function dirtyEntries(projectDir: string, workRoot: string): string[] {
  const prefix = workRootPrefix(projectDir, workRoot);
  const fields = runGitRaw(projectDir, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]).split('\0');
  const entries: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    if (field.length < 4) continue;
    // A rename or copy carries its source path as the next NUL field.
    if (field[0] === 'R' || field[0] === 'C') i++;
    if (prefix !== null && field.startsWith('?? ') && field.slice(3).startsWith(prefix)) continue;
    entries.push(field);
  }
  return entries;
}

export interface IntegrationCheckInput {
  epicId: string;
  projectDir: string;
  checks: CheckCommand[];
  /**
   * Default TRUE, unlike the per-task gate. A task gate short-circuits
   * because the coder only needs the first thing to fix; the operator
   * closing an epic wants the whole picture of the assembled branch in one
   * pass.
   */
  runAll?: boolean;
  timeoutMs?: number;
  /** A tier, `all`, or `remaining` (the checks `certifyChecks` does not certify at the target commit). */
  tier?: CheckTier | 'all' | 'remaining';
  /**
   * The work root whose untracked files do not count as a dirty tree. Default
   * `WORK_ROOT`; ignored unless it is a strict subdirectory of `projectDir`.
   */
  workRoot?: string;
  /** Default `clone`: the project root, on the integration branch, clean. `scratch` needs `commit`. */
  workspace?: 'clone' | 'scratch';
  /** The commit a scratch run checks; resolved in the clone. */
  commit?: string;
  /** Scratch only: runs first in the scratch worktree; its result is never a check. */
  setupCmd?: string;
  /** Marks the record a probe: it never certifies anything. */
  probeOf?: string;
  environmentSources?: EnvironmentSources;
}

function branchHead(projectDir: string, branch: string): string | null {
  try {
    return git(projectDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) || null;
  } catch {
    return null;
  }
}

/**
 * The current head of `<prefix>/<epic>/integration` (`bs/` for a new epic,
 * `smith/` for one that already integrates there — epicBranchPrefix decides
 * which), or null when the epic has no integration branch (never planned,
 * never dispatched, wrong --epic). Read here rather than inside epic.ts so
 * the verdict stays git-free and purely a fold over events — the CLI passes
 * the sha in.
 */
export function integrationHeadSha(projectDir: string, epicId: string): string | null {
  return branchHead(
    projectDir,
    integrationBranchName(epicId, epicBranchPrefix(projectDir, epicId)),
  );
}

/** Last-wins fold: the most recent recorded check for this epic, or null. */
export function latestIntegrationCheck(
  events: readonly StoredEvent[],
  epicId: string,
): IntegrationCheckRecord | null {
  let latest: IntegrationCheckRecord | null = null;
  for (const event of events) {
    if (event.record.event_type !== INTEGRATION_CHECK_EVENT) continue;
    const payload = event.record.payload as Record<string, unknown>;
    if (payload.epic_id !== epicId) continue;
    latest = {
      epicId,
      branch: String(payload.branch ?? ''),
      headSha: String(payload.head_sha ?? ''),
      pass: payload.pass === true,
      results: (payload.results ?? []) as CheckResult[],
      eventId: event.event_id,
      ts: event.record.ts,
    };
  }
  return latest;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The payload of an `integration-check` event of this epic, or null for any other event. */
function integrationPayload(event: StoredEvent, epicId: string): Record<string, unknown> | null {
  if (event.record.event_type !== INTEGRATION_CHECK_EVENT) return null;
  const payload = event.record.payload as Record<string, unknown>;
  return payload.epic_id === epicId ? payload : null;
}

/**
 * The last non-probe record at `commit`, in the order given, projected as
 * `latestIntegrationCheck` projects a record; null when none is at the commit.
 */
export function latestIntegrationCheckAt(
  events: readonly StoredEvent[],
  epicId: string,
  commit: string,
): IntegrationCheckRecord | null {
  let latest: IntegrationCheckRecord | null = null;
  for (const event of events) {
    const payload = integrationPayload(event, epicId);
    if (payload === null || 'probe_of' in payload || payload.head_sha !== commit) continue;
    latest = {
      epicId,
      branch: String(payload.branch ?? ''),
      headSha: String(payload.head_sha ?? ''),
      pass: payload.pass === true,
      results: (payload.results ?? []) as CheckResult[],
      eventId: event.event_id,
      ts: event.record.ts,
    };
  }
  return latest;
}

/** Only `['pre-merge']` (a record from before tiers, or an unlabelled project) is not tiered. */
const isPlainTiers = (v: unknown): boolean =>
  Array.isArray(v) && v.length > 0 && v.every((t) => t === 'pre-merge');

/**
 * The id of the last record of this epic that uses tiers: a probe, or one
 * whose `tiers` or `tiers_present` is anything but `['pre-merge']`. A malformed
 * value counts, so this fails closed.
 */
export function lastTieredRecordId(events: readonly StoredEvent[], epicId: string): string | null {
  let id: string | null = null;
  for (const event of events) {
    const payload = integrationPayload(event, epicId);
    if (payload === null) continue;
    const tiered =
      'probe_of' in payload ||
      ('tiers' in payload && !isPlainTiers(payload.tiers)) ||
      ('tiers_present' in payload && !isPlainTiers(payload.tiers_present));
    if (tiered) id = event.event_id;
  }
  return id;
}

export type CertificationReason = 'failed' | 'not-run' | 'changed' | 'no-result';

export interface CertificationQuery {
  name: string;
  checkSha256: string;
}

export interface CheckCertification {
  certified: boolean;
  reason: CertificationReason | null;
  recordId: string | null;
  result: CheckResult | null;
}

/**
 * The one definition of "this check is certified at this commit". A check is
 * certified when the last result for its name and `check_sha256`, in the
 * events as given (never sorted by `ts`), at `commit` in a non-probe record of
 * this epic, passed and ran. Certification is per check, so a later record
 * naming other checks displaces nothing, and a tier move (which leaves the
 * digest alone) keeps a result. Every field is read for its type: a malformed
 * record or element can withhold certification and never grant it.
 */
export function certifyChecks(
  events: readonly StoredEvent[],
  epicId: string,
  commit: string,
  checks: readonly CertificationQuery[],
): CheckCertification[] {
  const evidence: { recordId: string; notRun: unknown; result: Record<string, unknown> }[] = [];
  for (const event of events) {
    const payload = integrationPayload(event, epicId);
    if (payload === null || 'probe_of' in payload || payload.head_sha !== commit) continue;
    if (!Array.isArray(payload.results)) continue;
    for (const result of payload.results as unknown[]) {
      if (isObject(result) && typeof result.name === 'string') {
        evidence.push({ recordId: event.event_id, notRun: payload.not_run, result });
      }
    }
  }
  return checks.map((query): CheckCertification => {
    const named = evidence.filter((e) => e.result.name === query.name);
    const decided = named.filter((e) => e.result.check_sha256 === query.checkSha256).at(-1);
    if (decided === undefined) {
      const changed = named.some((e) => typeof e.result.check_sha256 === 'string');
      return {
        certified: false,
        reason: changed ? 'changed' : 'no-result',
        recordId: null,
        result: null,
      };
    }
    const result = decided.result as unknown as CheckResult;
    const notRun =
      isNotRun(result) || (Array.isArray(decided.notRun) && decided.notRun.includes(result.name));
    const certified = result.pass === true && !notRun;
    return {
      certified,
      reason: certified ? null : notRun ? 'not-run' : 'failed',
      recordId: decided.recordId,
      result,
    };
  });
}

export interface RunChecksAtOptions {
  setupCmd?: string;
  timeoutMs?: number;
  runAll?: boolean;
  environmentSources?: EnvironmentSources;
}

export interface RunChecksAtResult {
  setupFailed: boolean;
  setup: CheckResult | null;
  deps: DepsCheck | null;
  results: CheckResult[];
  environment: CheckEnvironment[];
  pass: boolean;
}

const SCRATCH_NAME = /^scratch-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The `.wt/<project>/` root queue.ts puts batch candidates under. */
function scratchRoot(projectDir: string): string {
  const project = path.resolve(projectDir);
  return path.join(path.dirname(project), '.wt', path.basename(project));
}

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Remove detached `scratch-<pid>-<uuid>` worktrees under `root` whose pid is dead, then prune. */
function sweepDeadScratch(projectDir: string, root: string): void {
  const realRoot = realOrSelf(root);
  for (const entry of parseWorktreePorcelain(
    git(projectDir, ['worktree', 'list', '--porcelain']),
  )) {
    const match = SCRATCH_NAME.exec(path.basename(entry.worktree));
    if (!entry.detached || match === null || realOrSelf(path.dirname(entry.worktree)) !== realRoot)
      continue;
    if (pidIsAlive(Number(match[1]))) continue;
    try {
      git(projectDir, ['worktree', 'remove', '--force', entry.worktree]);
    } catch {
      // A concurrent run may have removed it first; the run carries on.
    }
  }
  git(projectDir, ['worktree', 'prune']);
}

/**
 * Run `checks` at `commit` in a detached scratch worktree that is always
 * removed. The clone's branch, index and tree are never read or changed. A
 * failing setup command or a deps block returns `setupFailed` and runs no check.
 */
export async function runChecksAt(
  projectDir: string,
  commit: string,
  checks: readonly CheckCommand[],
  opts: RunChecksAtOptions = {},
): Promise<RunChecksAtResult> {
  const root = scratchRoot(projectDir);
  sweepDeadScratch(projectDir, root);
  const dir = path.join(root, `scratch-${process.pid}-${randomUUID()}`);
  git(projectDir, ['worktree', 'add', '--detach', dir, commit]);
  const runOpts = {
    cwd: dir,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.environmentSources === undefined
      ? {}
      : { environmentSources: opts.environmentSources }),
  };
  const setupFailed = (setup: CheckResult | null, deps: DepsCheck | null): RunChecksAtResult => ({
    setupFailed: true,
    setup,
    deps,
    results: [],
    environment: [],
    pass: false,
  });
  try {
    let setup: CheckResult | null = null;
    if (opts.setupCmd !== undefined) {
      const out = await run([{ name: 'setup', cmd: opts.setupCmd, heavy: false }], runOpts);
      setup = { ...(out.results[0] as CheckResult), cmd: maskCommandCredentials(opts.setupCmd) };
      if (!setup.pass) return setupFailed(setup, null);
    }
    // Loaded here, not at the top: gate.ts reaches the database layer, which
    // cliBoot.test.ts keeps out of every invocation's boot.
    const { checkWorktreeDeps } = await import('./gate.js');
    const deps = checkWorktreeDeps(dir);
    if (!deps.ok) return setupFailed(setup, deps);
    const outcome = await run([...checks], { ...runOpts, runAll: opts.runAll ?? true });
    return {
      setupFailed: false,
      setup,
      deps,
      results: outcome.results,
      environment: outcome.environment ?? [],
      pass: outcome.pass,
    };
  } finally {
    try {
      git(projectDir, ['worktree', 'remove', '--force', dir]);
    } catch {
      // Whatever is left is swept by the next run once this pid is gone.
    }
  }
}

function badInput(field: string, why: string): IntegrationCheckError {
  return new IntegrationCheckError('integration.bad-input', `\`${field}\` ${why}.`, { field });
}

/** The workspace-dependent fields, refused before anything runs or is written. */
function assertWorkspaceInput(input: IntegrationCheckInput): void {
  const { workspace, commit, setupCmd, probeOf } = input;
  if (workspace !== undefined && workspace !== 'clone' && workspace !== 'scratch') {
    throw badInput('workspace', 'must be "clone" or "scratch"');
  }
  if (workspace === 'scratch') {
    if (commit === undefined) throw badInput('commit', 'is required with workspace "scratch"');
  } else {
    if (commit !== undefined) throw badInput('commit', 'is accepted only with workspace "scratch"');
    if (setupCmd !== undefined) {
      throw badInput('setupCmd', 'is accepted only with workspace "scratch"');
    }
  }
  if (probeOf !== undefined && (typeof probeOf !== 'string' || probeOf === '')) {
    throw badInput('probeOf', 'must be a non-empty string when given');
  }
}

/** The full sha `commit` names in the clone, or `integration.unknown-commit`. */
function resolveCommit(projectDir: string, commit: string): string {
  try {
    // A leading dash would read as an option to rev-parse.
    if (commit.startsWith('-')) throw new Error('not a revision');
    return git(projectDir, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
  } catch {
    throw new IntegrationCheckError(
      'integration.unknown-commit',
      `"${commit}" does not name a commit in ${projectDir}.`,
      { commit, projectDir },
    );
  }
}

/**
 * Run the check suite at the project root against the epic's assembled
 * integration branch and record the outcome as an event.
 *
 * A FAILING suite is a recorded failure, not a throw — that is the whole
 * point of the record. A suite that could not honestly be run at all (no
 * checks, wrong branch, dirty tree, no branch) throws instead, because the
 * one thing this must never do is write down a pass that nothing earned.
 */
export async function runIntegrationCheck(
  input: IntegrationCheckInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<IntegrationCheckRecord> {
  // Refused before the check suite below spends a full run on it: a bad
  // --causal-parent used to surface only at the append this function makes
  // once the suite has already finished (D-42's shape, one level up — the
  // waste here is CPU time, not a git mutation, but the same envelope
  // `appendEvent` would refuse anyway, so refuse it first).
  await validateEventEnvelope(
    {
      session_id: ctx.sessionId,
      event_type: INTEGRATION_CHECK_EVENT,
      causal_parent: ctx.causalParent,
    },
    opts,
  );

  const { epicId, projectDir } = input;
  const scratch = input.workspace === 'scratch';
  assertWorkspaceInput(input);
  const branch = integrationBranchName(epicId, epicBranchPrefix(projectDir, epicId));

  // testgate.run([]) returns pass: true for an empty list — correct there
  // (a task claiming no checks has nothing to short-circuit), and a silent
  // forgery here. "No checks configured" must never read back as "the
  // assembled branch passed its checks".
  if (input.checks.length === 0) {
    throw new IntegrationCheckError(
      'integration.no-checks',
      `Refusing to certify epic "${epicId}" with an empty check list: an empty suite would record a pass nothing ran for.`,
      { epicId, branch },
    );
  }

  const headSha = branchHead(projectDir, branch);
  if (headSha === null) {
    throw new IntegrationCheckError(
      'integration.branch-missing',
      `Epic "${epicId}" has no integration branch (${branch}) in ${projectDir} — there is nothing assembled to check.`,
      { epicId, branch, projectDir },
    );
  }

  let targetSha = headSha;
  if (scratch) {
    targetSha = resolveCommit(projectDir, input.commit as string);
  } else {
    let currentBranch: string;
    try {
      currentBranch = git(projectDir, ['branch', '--show-current']);
    } catch (cause) {
      throw new IntegrationCheckError(
        'integration.not-a-repo',
        `Could not read the current branch in ${projectDir}: ${String(cause)}`,
        { projectDir },
      );
    }

    // The checks run against the working tree, so the working tree has to BE
    // the integration branch. Checking it out for the operator would be a
    // destructive git op on their own clone (guardrails.md) — refuse instead.
    if (currentBranch !== branch) {
      throw new IntegrationCheckError(
        'integration.wrong-branch',
        `${projectDir} is on "${currentBranch || '(detached HEAD)'}", not the integration branch "${branch}". Check it out first — this command will not move your working tree for you.`,
        { epicId, branch, currentBranch, projectDir },
      );
    }

    // `--untracked-files=all` explicitly: the mode is configurable, and a
    // `status.showUntrackedFiles = no` anywhere in git's config chain made an
    // untracked-only tree read back as clean — which is exactly the tree someone
    // forgot to commit, certified under a head it does not match (D-178).
    const dirty = dirtyEntries(projectDir, input.workRoot ?? WORK_ROOT);
    if (dirty.length > 0) {
      throw new IntegrationCheckError(
        'integration.dirty-tree',
        `${projectDir} has uncommitted changes; a check run against a dirty tree certifies something that is not ${branch} at ${headSha.slice(0, 8)}.`,
        { epicId, branch, projectDir, dirtyEntries: dirty.length },
      );
    }
  }

  const { tier } = input;
  let selected: CheckCommand[];
  if (tier === undefined || tier === 'all') {
    selected = input.checks;
  } else if (tier === 'remaining') {
    // Read once, through the same definition the close applies.
    const events = await readLineageEvents(ctx.sessionId, opts);
    const certs = certifyChecks(
      events,
      epicId,
      targetSha,
      input.checks.map((c) => ({ name: c.name, checkSha256: checkDigest(c) })),
    );
    selected = input.checks.filter((_, i) => certs[i]?.certified !== true);
    if (selected.length === 0) {
      throw new IntegrationCheckError(
        'integration.nothing-remaining',
        `Every check of epic "${epicId}" is already certified at ${targetSha}; there is nothing left to run.`,
        { epicId, branch, commit: targetSha },
      );
    }
  } else {
    selected = selectTier(input.checks, tier);
  }
  if (selected.length === 0) {
    throw new IntegrationCheckError(
      'integration.no-checks',
      `Refusing to certify epic "${epicId}": no check is in the ${tier} tier, and an empty selection would record a pass nothing ran for.`,
      { epicId, branch, tier },
    );
  }

  const timing = {
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.environmentSources === undefined
      ? {}
      : { environmentSources: input.environmentSources }),
  };
  let outcome: { results: CheckResult[]; pass: boolean; environment?: CheckEnvironment[] };
  if (scratch) {
    const at = await runChecksAt(projectDir, targetSha, selected, {
      ...timing,
      runAll: input.runAll ?? true,
      ...(input.setupCmd === undefined ? {} : { setupCmd: input.setupCmd }),
    });
    // Never a record, never a pass, never a red: the callers map this code to `setup-failed`.
    if (at.setupFailed) {
      throw new IntegrationCheckError(
        'integration.setup-failed',
        `Preparing the scratch worktree at ${targetSha} failed (${at.setup !== null ? 'the setup command' : 'the dependency check'}); no check ran.`,
        { epicId, commit: targetSha, setup: at.setup, deps: at.deps },
      );
    }
    outcome = at;
  } else {
    outcome = await run(selected, {
      cwd: projectDir,
      runAll: input.runAll ?? true,
      ...timing,
    });
  }

  // Store what each check ran beside how it exited. `run` returns results in
  // check order (and stops early only when runAll is off), so index pairs them;
  // integration.test.ts's "pairs each result with its own command when the run
  // stops early" guards that. The command is masked here, before the record is
  // written, so a credential typed inline never reaches the log or a reader.
  const results: CheckResult[] = outcome.results.map((r, i) => {
    const cmd = selected[i]?.cmd;
    return cmd === undefined ? r : { ...r, cmd: maskCommandCredentials(cmd) };
  });

  const tiersOf = (checks: readonly CheckCommand[]): CheckTier[] =>
    CHECK_TIERS.filter((t) => checks.some((c) => checkTier(c) === t));
  const environment = outcome.environment ?? [];
  const slept = sleptFailedChecks({ results, pass: outcome.pass, environment });
  const extra = {
    tiers: tiersOf(selected),
    tiers_present: tiersOf(input.checks),
    tree_sha: git(projectDir, ['rev-parse', `${targetSha}^{tree}`]),
    not_run: results.filter(isNotRun).map((r) => r.name),
    environment,
    ...(input.probeOf === undefined ? {} : { probe_of: input.probeOf }),
    ...(slept.length === 0
      ? {}
      : { error_class: 'execution.env-failure' as const, environment_evidence: slept }),
  };

  const stored = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: INTEGRATION_CHECK_EVENT,
      task_id: `${epicId}/${RESERVED_TASK_ID}`,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        epic_id: epicId,
        branch,
        head_sha: targetSha,
        pass: outcome.pass,
        results,
        ...extra,
      },
    },
    opts,
  );

  return {
    epicId,
    branch,
    headSha: targetSha,
    pass: outcome.pass,
    results,
    eventId: stored.event_id,
    ts: stored.record.ts,
    tiers: extra.tiers,
    tiersPresent: extra.tiers_present,
    treeSha: extra.tree_sha,
    notRun: extra.not_run,
    ...(input.probeOf === undefined ? {} : { probeOf: input.probeOf }),
    environment,
    ...(slept.length === 0 ? {} : { errorClass: extra.error_class, environmentEvidence: slept }),
  };
}
