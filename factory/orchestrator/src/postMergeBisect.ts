import { inFlightTasks } from './admission.js';
import { SmithError } from './errors.js';
import type { EventOpts, StoredEvent } from './events.js';
import type { EventContext } from './findings.js';
import { runGit as git } from './git.js';
import type { DependencyEdge } from './graph.js';
import {
  certifyChecks,
  IntegrationCheckError,
  integrationHeadSha,
  runIntegrationCheck,
} from './integration.js';
import { taskIdsMatch } from './taskId.js';
import { HELD_OPEN_BY_AN_OPERATOR } from './taskStatus.js';
import {
  type CheckCommand,
  checkDigest,
  isNotRun,
  selectTier,
  sleptDuringCheck,
} from './testgate.js';
import { detectDefaultBranch, epicBranchPrefix, integrationBranchName } from './worktree.js';

/**
 * The post-merge batch: when it is due, what it certifies, and which task a
 * red that reproduces belongs to. Read-and-probe only. It never moves a ref,
 * never checks a branch out and never writes `wave-reverted`; the verb that
 * calls it (task-12) does the reverting.
 */
export class PostMergeError extends SmithError {}

/**
 * Task merges since the base that make a batch due on their own. Spec D4's
 * batch arm: the number is the spec's, not a tuning knob.
 */
export const POST_MERGE_BATCH = 4;

/** A task merge on the integration branch: `Merge <task-id> into <branch>`. */
export interface TaskMerge {
  task: string;
  merge_sha: string;
}

export interface RangeCommit {
  sha: string;
  message: string;
}

export interface IntegrationRefs {
  branch: string;
  defaultBranch: string;
  head: string;
  forkPoint: string;
}

/**
 * The only ref this module reads is `<prefix>/<epic>/integration`, and it is
 * never the default branch. Raised before any worktree exists.
 */
export function assertIntegrationBranch(
  projectDir: string,
  epicId: string,
): { branch: string; defaultBranch: string } {
  const branch = integrationBranchName(epicId, epicBranchPrefix(projectDir, epicId));
  const defaultBranch = detectDefaultBranch(projectDir);
  const parts = branch.split('/');
  const shaped = parts.length === 3 && parts[1] === epicId && parts[2] === 'integration';
  if (!shaped || branch === defaultBranch) {
    throw new PostMergeError(
      'postmerge.not-integration-branch',
      `"${branch}" is ${shaped ? `the default branch of ${projectDir}` : 'not shaped <prefix>/<epic>/integration'}; the post-merge batch reads, probes and moves only an epic's integration branch.`,
      { epicId, branch, defaultBranch },
    );
  }
  return { branch, defaultBranch };
}

function integrationRefs(projectDir: string, epicId: string): IntegrationRefs {
  const { branch, defaultBranch } = assertIntegrationBranch(projectDir, epicId);
  const head = integrationHeadSha(projectDir, epicId);
  if (head === null) {
    throw new PostMergeError(
      'postmerge.branch-missing',
      `Epic "${epicId}" has no integration branch (${branch}) in ${projectDir}.`,
      { epicId, branch, projectDir },
    );
  }
  return {
    branch,
    defaultBranch,
    head,
    forkPoint: git(projectDir, ['merge-base', defaultBranch, branch]),
  };
}

/** First-parent commits in `from..to`, oldest first, each with its full message. */
function rangeCommits(projectDir: string, from: string, to: string): RangeCommit[] {
  const out = git(projectDir, [
    'log',
    '--first-parent',
    '--reverse',
    '--format=%H%x1f%B%x1e',
    `${from}..${to}`,
  ]);
  return out
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [sha = '', message = ''] = entry.split('\x1f');
      return { sha, message: message.trim() };
    });
}

/** A bs revert commit names what it reverts in a `Bs-Revert-Of` trailer (task-16 validates all four). */
export function isBsRevertCommit(message: string): boolean {
  const paragraphs = message.trim().split(/\n\s*\n/);
  const trailers = paragraphs.length > 1 ? (paragraphs.at(-1) ?? '') : '';
  return trailers.split('\n').some((line) => /^Bs-Revert-Of:/.test(line));
}

const revertsIn = (refs: IntegrationRefs, projectDir: string): RangeCommit[] =>
  rangeCommits(projectDir, refs.forkPoint, refs.head).filter((c) => isBsRevertCommit(c.message));

/**
 * Spec D4's one scan: every first-parent commit from the integration branch's
 * fork point from the default branch to the head that carries a `Bs-Revert-Of`
 * trailer, oldest first. Never bounded by the base, so a revert whose own
 * records made it the base is still found.
 */
export function landedBsReverts(projectDir: string, epicId: string): RangeCommit[] {
  return revertsIn(integrationRefs(projectDir, epicId), projectDir);
}

export interface PlanTaskRef {
  task_id: string;
  task_status: string;
  [key: string]: unknown;
}

export interface BaseInput {
  epicId: string;
  projectDir: string;
  /** The effective checks, tiers resolved. */
  checks: readonly CheckCommand[];
  /** The epic's event lineage, in log order. */
  events: readonly StoredEvent[];
}

export interface PostMergeBase {
  branch: string;
  head: string;
  forkPoint: string;
  base: string;
  /** False when no commit is certified and `base` is the fork point. */
  observed: boolean;
  /** Task merges since the base, oldest first: the uncertified merges. */
  merges: TaskMerge[];
  /** Every first-parent commit since the base, oldest first. */
  commits: RangeCommit[];
}

const MERGE_SUBJECT = /^Merge (\S+) into (.+)$/;

function taskMerges(branch: string, commits: readonly RangeCommit[]): TaskMerge[] {
  return commits.flatMap((c) => {
    const match = MERGE_SUBJECT.exec(c.message.split('\n')[0] ?? '');
    return match !== null && match[2] === branch
      ? [{ task: match[1] as string, merge_sha: c.sha }]
      : [];
  });
}

function baseOf(refs: IntegrationRefs, input: BaseInput): PostMergeBase {
  const { projectDir, epicId } = input;
  const queries = selectTier(input.checks, 'post-merge').map((c) => ({
    name: c.name,
    checkSha256: checkDigest(c),
  }));
  const newestFirst = git(projectDir, [
    'rev-list',
    '--first-parent',
    `${refs.forkPoint}..${refs.head}`,
  ])
    .split('\n')
    .filter(Boolean);
  const certified = [...newestFirst, refs.forkPoint].find((sha) =>
    certifyChecks(input.events, epicId, sha, queries).every((c) => c.certified),
  );
  const base = certified ?? refs.forkPoint;
  const commits = rangeCommits(projectDir, base, refs.head);
  return {
    branch: refs.branch,
    head: refs.head,
    forkPoint: refs.forkPoint,
    base,
    observed: certified !== undefined,
    merges: taskMerges(refs.branch, commits),
    commits,
  };
}

/**
 * Spec D4's base: the latest ancestor of the head certified for every current
 * post-merge check (each by name and `check_sha256`), else the fork point,
 * flagged unobserved. The head itself certified means nothing is new.
 */
export function postMergeBase(input: BaseInput): PostMergeBase {
  return baseOf(integrationRefs(input.projectDir, input.epicId), input);
}

export interface HeldInput {
  tasks: readonly PlanTaskRef[];
  edges: readonly DependencyEdge[];
  statusOf: (taskId: string) => string;
  uncertifiedMerges: readonly TaskMerge[];
  hasPostMergeChecks: boolean;
}

/**
 * Every `todo` or `ready` plan task with a plan dependency on an uncertified
 * merge, each with the merged task ids it waits on. It is both the dependency
 * arm of the trigger and the admission hold, so the two cannot disagree. An
 * unlabelled project (no post-merge entry) holds nothing.
 */
export function heldByPostMerge(input: HeldInput): Map<string, string[]> {
  const held = new Map<string, string[]>();
  if (!input.hasPostMergeChecks) return held;
  for (const task of input.tasks) {
    const status = input.statusOf(task.task_id);
    if (status !== 'todo' && status !== 'ready') continue;
    const waitsOn = input.uncertifiedMerges
      .filter((m) =>
        input.edges.some(
          (e) => taskIdsMatch(e.task, task.task_id) && taskIdsMatch(e.dependsOn, m.task),
        ),
      )
      .map((m) => m.task);
    if (waitsOn.length > 0) held.set(task.task_id, waitsOn);
  }
  return held;
}

export type PostMergeOutcome =
  | 'no-checks-in-tier'
  | 'no-new-merges'
  | 'batch-not-ready'
  | 'setup-failed'
  | 'green'
  | 'lock-timeout'
  | 'env-failure'
  | 'not-reproduced'
  | 'red-at-base'
  | 'batch-has-foreign-commit'
  | 'revert-has-dependents'
  | 'culprit-found';

export type ProbeStep = 'head' | 'reproduce' | 'base' | 'bisect';

export interface Culprit {
  task: string;
  merge_sha: string;
  failing_checks: string[];
  red_record_event_id: string;
}

export interface PostMergeResult {
  outcome: PostMergeOutcome;
  /** The task merges since the base. */
  merges: TaskMerge[];
  /** Every record and probe event id written, in order. */
  recordIds: string[];
  base?: string;
  baseObserved?: boolean;
  head?: string;
  culprit?: Culprit;
  /** `revert-has-dependents`: the later merges that depend on the culprit, in merge order. */
  dependents?: string[];
  /** `setup-failed`: which run's preparation failed, and at which commit. */
  step?: ProbeStep;
  commit?: string;
  /** `batch-has-foreign-commit`: the commits that are neither task merges nor bs reverts. */
  foreign?: string[];
  /** `red-at-base` on a revert-only red: the landed bs revert shas after the last task merge, oldest first. */
  redAfterRevert?: string[];
}

export interface PostMergeInput extends BaseInput {
  tasks: readonly PlanTaskRef[];
  edges: readonly DependencyEdge[];
  final?: boolean;
  setupCmd?: string;
  /** Default `runIntegrationCheck`; always called with `workspace: 'scratch'`. */
  runner?: typeof runIntegrationCheck;
  /** The status of a task; default the folded status of the epic's event lineage. */
  statusOf?: (taskId: string) => string;
}

/**
 * The status the epic's event lineage folds to, as `bs wave admit` reads it. A
 * task the lineage has no row for yet has only its plan record's initial status.
 * Imported here so the db layer stays out of the graph a bare `bs` run loads.
 */
async function foldedStatusOf(input: PostMergeInput): Promise<(taskId: string) => string> {
  const { foldTasks } = await import('./db/projector.js');
  const rows = foldTasks(input.events);
  return (id) =>
    rows.find((r) => taskIdsMatch(r.taskId, id))?.taskStatus ??
    input.tasks.find((t) => taskIdsMatch(t.task_id, id))?.task_status ??
    '';
}

/** Ends the call with an outcome from anywhere inside it. */
class Stop extends Error {
  constructor(
    readonly outcome: PostMergeOutcome,
    readonly extra: Partial<PostMergeResult> = {},
  ) {
    super(outcome);
  }
}

/**
 * Run the post-merge tier at the head and, on a red that ran and reproduces,
 * bisect the batch's task merges to the one that broke it.
 */
export async function findPostMergeCulprit(
  input: PostMergeInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<PostMergeResult> {
  const { epicId, projectDir } = input;
  const refs = integrationRefs(projectDir, epicId);
  const postChecks = selectTier(input.checks, 'post-merge');
  if (postChecks.length === 0) return { outcome: 'no-checks-in-tier', merges: [], recordIds: [] };

  const base = baseOf(refs, input);
  const recordIds: string[] = [];
  const done = (outcome: PostMergeOutcome, extra: Partial<PostMergeResult> = {}) => ({
    outcome,
    merges: base.merges,
    recordIds,
    base: base.base,
    baseObserved: base.observed,
    head: base.head,
    ...extra,
  });
  if (base.observed && base.base === base.head) return done('no-new-merges');

  const statusOf = input.statusOf ?? (await foldedStatusOf(input));
  if (!input.final) {
    const held = heldByPostMerge({
      tasks: input.tasks,
      edges: input.edges,
      statusOf,
      uncertifiedMerges: base.merges,
      hasPostMergeChecks: true,
    });
    const flying = inFlightTasks(input.events, { epicId, planVersion: ctx.planVersion });
    const idle = [...flying].every((id) => HELD_OPEN_BY_AN_OPERATOR.has(statusOf(id)));
    if (held.size === 0 && base.merges.length < POST_MERGE_BATCH && !idle) {
      return done('batch-not-ready');
    }
  }

  const runner = input.runner ?? runIntegrationCheck;
  const scratch = async (
    step: ProbeStep,
    commit: string,
    checks: CheckCommand[],
    probeOf?: string,
  ) => {
    try {
      const record = await runner(
        {
          epicId,
          projectDir,
          checks,
          workspace: 'scratch',
          commit,
          ...(input.setupCmd === undefined ? {} : { setupCmd: input.setupCmd }),
          ...(probeOf === undefined ? {} : { probeOf }),
        },
        ctx,
        opts,
      );
      recordIds.push(record.eventId);
      return record;
    } catch (error) {
      if (error instanceof IntegrationCheckError && error.code === 'integration.setup-failed') {
        throw new Stop('setup-failed', { step, commit });
      }
      throw error;
    }
  };

  try {
    const head = await scratch('head', base.head, postChecks);
    if (head.pass) return done('green');
    const failedAt = head.results.flatMap((r, i) => (r.pass ? [] : [i]));
    if (failedAt.some((i) => isNotRun(head.results[i] as never))) return done('lock-timeout');
    const slept = failedAt.every((i) => {
      const entry = head.environment?.[i];
      return entry !== undefined && sleptDuringCheck(entry);
    });
    if (slept) return done('env-failure');

    const failing = failedAt.map((i) => (head.results[i] as { name: string }).name);
    const rerun = postChecks.filter((c) => failing.includes(c.name));
    const probeRed = async (step: ProbeStep, commit: string): Promise<boolean> => {
      const probe = await scratch(step, commit, rerun, head.eventId);
      if (probe.results.some(isNotRun)) throw new Stop('lock-timeout');
      return !probe.pass;
    };

    const again = await scratch('reproduce', base.head, rerun, head.eventId);
    if (again.results.some((r) => r.pass)) return done('not-reproduced');
    if (again.results.some(isNotRun)) return done('lock-timeout');
    if (!base.observed && (await probeRed('base', base.base))) return done('red-at-base');

    const reverts = new Set(revertsIn(refs, projectDir).map((c) => c.sha));
    const merged = new Set(base.merges.map((m) => m.merge_sha));
    const foreign = base.commits.filter((c) => !merged.has(c.sha) && !reverts.has(c.sha));
    if (foreign.length > 0) {
      return done('batch-has-foreign-commit', { foreign: foreign.map((c) => c.sha) });
    }

    // Bisect: `lo` is the last prefix known green (-1 is the base), `hi` the first known red.
    const { merges } = base;
    let lo = -1;
    let hi = merges.at(-1)?.merge_sha === base.head ? merges.length - 1 : merges.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await probeRed('bisect', (merges[mid] as TaskMerge).merge_sha)) hi = mid;
      else lo = mid;
    }
    const culpritMerge = merges[hi];
    if (culpritMerge === undefined) {
      // Green at every task merge, red only at the head: a landed bs revert made it red, and
      // no task of this batch did. `red-at-base` is the nearest outcome that blames no task.
      const lastMerge = base.commits.findLastIndex((c) => merged.has(c.sha));
      const redAfterRevert = base.commits
        .slice(lastMerge + 1)
        .filter((c) => reverts.has(c.sha))
        .map((c) => c.sha);
      return done('red-at-base', { redAfterRevert });
    }
    const culprit: Culprit = {
      task: culpritMerge.task,
      merge_sha: culpritMerge.merge_sha,
      failing_checks: failing,
      red_record_event_id: head.eventId,
    };
    const dependents = merges
      .slice(hi + 1)
      .filter((m) =>
        input.edges.some(
          (e) => taskIdsMatch(e.task, m.task) && taskIdsMatch(e.dependsOn, culprit.task),
        ),
      )
      .map((m) => m.task);
    return dependents.length > 0
      ? done('revert-has-dependents', { culprit, dependents })
      : done('culprit-found', { culprit });
  } catch (error) {
    if (error instanceof Stop) return done(error.outcome, error.extra);
    throw error;
  }
}
