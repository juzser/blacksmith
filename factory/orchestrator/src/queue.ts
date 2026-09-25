import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { claimsOverlap, collectCommittedChanges, touchesSerializeAlways } from './claims.js';
import { type CommitBlockReason, certifyCommit, UNCOMMITTED_WORK_CODE } from './commit.js';
import { SmithError } from './errors.js';
import type { EventOpts } from './events.js';
import { runGit, runGitRaw, writeMergeTree } from './git.js';
import { type DependencyEdge, topoSort } from './graph.js';
import { buildSymbolGraph, collectSources } from './symbols.js';
import { emitTaskBlocked, emitWaveMerged, type TaskEventContext } from './taskEvents.js';
import { projectCommandEnv } from './testgate.js';
import { renderSelectedTestCmd, selectTests, type TestSelectStatus } from './testSelect.js';
import { integrationBranchName } from './worktree.js';

export class QueueError extends SmithError {}

export interface QueueTaskRef {
  task_id: string;
}

/**
 * Admission order for a serial merge queue: topological by dependency
 * edges, tie-broken by task id. Does not select which tasks to run — only
 * orders whatever set the caller passes in.
 */
export function admit(tasks: QueueTaskRef[], edges: DependencyEdge[] = []): string[] {
  const result = topoSort(
    tasks.map((t) => t.task_id),
    edges,
  );
  if (!result.ok) {
    throw new QueueError(
      'queue.cyclic-dependency',
      `Cannot admit tasks with a cyclic dependency: ${result.cycle.join(', ')}.`,
      { cycle: result.cycle },
    );
  }
  return result.order;
}

/** A task as the grouping function needs to see it — nothing about how it runs. */
export interface BatchGroupableTask {
  taskId: string;
  /** Undefined or empty means "claims unknown" — the task is grouped alone. */
  claims?: string[];
}

/**
 * Split an admitted order into maximal runs of consecutive tasks a batch
 * step can stack into one candidate and test once (roadmap `merge-lanes`;
 * the batching idea is Zuul's shared-queue gating and Mergify's batch/bisect,
 * https://zuul-ci.org/docs/zuul/latest/gating.html,
 * https://docs.mergify.com/merge-queue/batches/).
 *
 * Greedy, left to right, one open group at a time: a task joins the open
 * group when its claims are disjoint from every member already in it and it
 * does not depend_on one of them; otherwise the open group closes and the
 * task starts the next one. Three conditions never even get a chance to
 * join a group — they close whatever is open and are appended as a group of
 * one, closed immediately, so a task after them starts fresh rather than
 * silently inheriting their neighbours:
 *   - no claims at all (nothing to prove disjoint, so nothing to batch with);
 *   - a claim a serialize-always glob covers (worktree.yml already refuses to
 *     run these concurrently; batching would silently defeat that refusal);
 *   - depends_on a task that is anywhere in the walk before it — conservative
 *     on purpose: batching a dependency chain has not been proven safe here,
 *     even though the chain would still test together inside one group.
 */
export function groupForBatch(
  tasks: BatchGroupableTask[],
  edges: DependencyEdge[] = [],
  serializeAlwaysGlobs: string[] = [],
): string[][] {
  const dependsOn = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!dependsOn.has(edge.task)) dependsOn.set(edge.task, new Set());
    (dependsOn.get(edge.task) as Set<string>).add(edge.dependsOn);
  }
  const byId = new Map(tasks.map((t) => [t.taskId, t]));

  const groups: string[][] = [];
  let current: string[] = [];

  for (const task of tasks) {
    const claims = task.claims ?? [];
    const hasClaims = claims.length > 0;
    const isSerializeAlways = hasClaims && touchesSerializeAlways({ claims }, serializeAlwaysGlobs).length > 0;

    if (!hasClaims || isSerializeAlways) {
      if (current.length > 0) groups.push(current);
      groups.push([task.taskId]);
      current = [];
      continue;
    }

    const deps = dependsOn.get(task.taskId);
    const dependsOnGroupMember = deps !== undefined && current.some((id) => deps.has(id));
    const overlapsGroupMember = current.some((id) => {
      const member = byId.get(id);
      const memberClaims = member?.claims ?? [];
      return memberClaims.length > 0 && claimsOverlap({ claims }, { claims: memberClaims }).overlaps;
    });

    if (dependsOnGroupMember || overlapsGroupMember) {
      groups.push(current);
      current = [task.taskId];
    } else {
      current.push(task.taskId);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export interface QueueTask {
  taskId: string;
  branch: string;
  worktreeDir: string;
}

export interface StepOptions {
  projectDir: string;
  epic: string;
  testCmd: string;
  /**
   * Optional narrowed test command carrying a `{files}` placeholder. When set,
   * the queue runs only the tests reachable from this task's diff, and falls
   * back to `testCmd` whenever the symbol graph cannot prove that safe. The
   * template is validated by the caller — `step` will not narrow a run it
   * cannot render.
   */
  selectTestCmd?: string;
  /**
   * Where to write this step's outcome (D-46/P9-29). Omit and the step runs
   * exactly as before, silently — kept optional because a dry run and the
   * unit tests have no session to write into, not because logging is a
   * nice-to-have. `queue run` always passes it.
   */
  events?: EventOpts & { ctx: TaskEventContext };
}

/**
 * How the task was tested, so a reader of the queue's output can tell a full
 * run from a narrowed one without re-deriving it. `mode: 'full'` with no other
 * field means no selection was ever attempted.
 */
export interface TestRunReport {
  mode: TestSelectStatus;
  /** The tests actually run. Only set when the run was narrowed. */
  ran?: string[];
  /** How many test files the symbol graph knew. Only set when selection ran. */
  known?: number;
  /** Why the narrowing was refused. Only set on a fallback to the full command. */
  reasons?: string[];
}

export type StepOutcome =
  /** `tests` is present only when `--select-test-cmd` asked for a selection. */
  | { outcome: 'merged'; taskId: string; tests?: TestRunReport }
  | {
      outcome: 'rebase-conflict';
      taskId: string;
      conflictingFiles: string[];
      /** No test ran: the rebase failed first. */
      tests?: undefined;
    }
  | { outcome: 'tests-failed'; taskId: string; outputTail: string; tests?: TestRunReport }
  /** The task has no commit for the queue to merge — see the guard in `step` (D-30). */
  | {
      outcome: 'nothing-to-merge';
      taskId: string;
      reason: CommitBlockReason;
      dirty: string[];
      /** No test ran: there was nothing to test. */
      tests?: undefined;
    }
  /**
   * The worktree that has the integration branch checked out carries
   * uncommitted tracked changes, so the queue would not merge into it. The
   * tests ran and passed; nothing landed.
   */
  | {
      outcome: 'integration-dirty';
      taskId: string;
      worktree: string;
      dirty: string[];
      tests?: TestRunReport;
    }
  /**
   * Batch-only (`batchStep`): the candidate's suite passed, but
   * `smith/<epic>/integration` had moved to a different commit by the time
   * the batch tried to land it — the same compare-and-swap race
   * `mergeWithoutWorktree` guards against for a single task (a `branch` that
   * moved during the merge throws there), now reachable with a whole group
   * under test at once instead of one task. Reusing `rebase-conflict` or
   * `nothing-to-merge` here would misreport the cause — the branch was fine
   * and the tests passed — so this gets its own outcome rather than an
   * uncaught throw: the caller can re-admit the group and it rebases onto
   * wherever the branch actually is.
   */
  | { outcome: 'integration-moved'; taskId: string; tests?: undefined };

const OUTPUT_TAIL_LINES = 50;

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function conflictingFiles(worktreeDir: string): string[] {
  const out = runGit(worktreeDir, ['diff', '--name-only', '--diff-filter=U']);
  return out
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/** The two ways `certifyAndRebase` can refuse a task before any test runs. */
type EarlyOutcome = Extract<StepOutcome, { outcome: 'nothing-to-merge' | 'rebase-conflict' }>;

/**
 * Certify there is a commit to merge (D-30/P9-8) and rebase the task's
 * branch onto the current integration head. Returns the blocked outcome when
 * either refuses, or null when the branch is ready to test — shared by
 * `step` and the batch path (`runGroup`) so a task that cannot even be
 * rebased fails exactly the same way whether it is running alone or as part
 * of a group.
 */
async function certifyAndRebase(
  task: QueueTask,
  integrationBranch: string,
  logBlocked: (taskId: string, error: string, detail: string) => Promise<void>,
): Promise<EarlyOutcome | null> {
  // Before the rebase, because a rebase, a test run and a merge all "succeed"
  // against a branch that carries nothing: certify that there is a commit to
  // merge at all (D-30/P9-8). A task that merges nothing is a bug, not a pass.
  const commit = certifyCommit(task.worktreeDir, { baseRef: integrationBranch });
  if (!commit.certified) {
    const reason = commit.reason as CommitBlockReason;
    await logBlocked(
      task.taskId,
      reason === 'not-a-git-worktree' ? 'execution.env-failure' : UNCOMMITTED_WORK_CODE,
      commit.dirty.length > 0
        ? `${task.branch} has uncommitted work: ${commit.dirty.join(', ')}`
        : `${task.branch} has nothing to merge into ${integrationBranch} (${reason}).`,
    );
    return { outcome: 'nothing-to-merge', taskId: task.taskId, reason, dirty: commit.dirty };
  }

  try {
    execFileSync('git', ['rebase', integrationBranch], {
      cwd: task.worktreeDir,
      stdio: 'pipe',
    });
  } catch {
    const files = conflictingFiles(task.worktreeDir);
    execFileSync('git', ['rebase', '--abort'], { cwd: task.worktreeDir, stdio: 'pipe' });
    await logBlocked(
      task.taskId,
      'integration.merge-conflict-textual',
      `Rebase onto ${integrationBranch} conflicted in: ${files.join(', ')}`,
    );
    return { outcome: 'rebase-conflict', taskId: task.taskId, conflictingFiles: files };
  }

  return null;
}

/**
 * Serial merge-queue admission step for one task: rebase its branch onto the
 * current epic integration head, run the epic's test command, then
 * merge --no-ff into the integration branch. Never auto-resolves a conflict
 * and never touches main — the caller decides what happens next on a
 * non-merged outcome.
 */
export async function step(task: QueueTask, opts: StepOptions): Promise<StepOutcome> {
  const integrationBranch = integrationBranchName(opts.epic);
  const events = opts.events;

  /**
   * Log the outcome the queue just observed — a refusal it has already decided
   * on, or a failure it has already seen. Never a prediction about work still
   * ahead of it: an event written before the merge that the merge then
   * falsifies is exactly the phantom row D-46 is about.
   */
  const logBlocked = async (taskId: string, error: string, detail: string): Promise<void> => {
    if (!events) return;
    const { ctx, ...opt } = events;
    await emitTaskBlocked(taskId, { error, severity: 'S2-major', detail }, ctx, opt);
  };

  const early = await certifyAndRebase(task, integrationBranch, logBlocked);
  if (early) return early;

  const plan = planTestRun(task.worktreeDir, opts);
  const testOutcome = runTestCmd(plan.cmd, task.worktreeDir);
  if (!testOutcome.passed) {
    const outputTail = tailLines(testOutcome.output, OUTPUT_TAIL_LINES);
    await logBlocked(task.taskId, 'execution.test-failure', outputTail);
    return {
      outcome: 'tests-failed',
      taskId: task.taskId,
      outputTail,
      ...(plan.report ? { tests: plan.report } : {}),
    };
  }

  // Merge where the integration branch already lives, or with no working tree
  // at all — never by `git checkout` in the project directory, which moved
  // the operator's own clone off the branch they were using.
  const message = `Merge ${task.taskId} into ${integrationBranch}`;
  const holder = worktreeHolding(opts.projectDir, integrationBranch);
  if (holder === null) {
    mergeWithoutWorktree(opts.projectDir, integrationBranch, task.branch, message);
  } else {
    // A merge into a worktree with edits in it either stops half-way or folds
    // someone's unfinished work into the merge's checkout; neither is ours.
    const dirty = trackedChanges(holder);
    if (dirty.length > 0) {
      await logBlocked(
        task.taskId,
        'execution.env-failure',
        `${integrationBranch} is checked out in ${holder}, which has uncommitted changes: ${dirty.join(', ')}`,
      );
      return {
        outcome: 'integration-dirty',
        taskId: task.taskId,
        worktree: holder,
        dirty,
        ...(plan.report ? { tests: plan.report } : {}),
      };
    }
    execFileSync('git', ['merge', '--no-ff', task.branch, '-m', message], {
      cwd: holder,
      stdio: 'pipe',
    });
  }

  if (events) {
    const { ctx, ...opt } = events;
    await emitWaveMerged(task.taskId, ctx, opt, mergedFiles(opts.projectDir, integrationBranch));
  }

  return { outcome: 'merged', taskId: task.taskId, ...(plan.report ? { tests: plan.report } : {}) };
}

/**
 * The worktree (the main one or any linked one) that has `branch` checked
 * out, or null when none does. git refuses to check a branch out in two
 * worktrees at once, so there is at most one. An entry git marks `prunable`
 * — its directory is gone — holds nothing: there is no checkout to merge in,
 * and moving the branch under it harms nothing. It is not pruned here either;
 * the operator's worktree registrations are theirs (architecture §18 rule 10).
 */
function worktreeHolding(projectDir: string, branch: string): string | null {
  const ref = `branch refs/heads/${branch}`;
  const records = runGitRaw(projectDir, ['worktree', 'list', '--porcelain', '-z']).split('\0\0');
  for (const record of records) {
    const lines = record.split('\0');
    const dir = lines.find((l) => l.startsWith('worktree '));
    if (dir === undefined || !lines.includes(ref)) continue;
    if (lines.some((l) => l === 'prunable' || l.startsWith('prunable '))) continue;
    return dir.slice('worktree '.length);
  }
  return null;
}

/** Tracked paths with staged or unstaged changes. Untracked files never block a merge. */
function trackedChanges(worktreeDir: string): string[] {
  const fields = runGitRaw(worktreeDir, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=no',
  ]).split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    if (field.length < 4) continue;
    paths.push(field.slice(3));
    // A rename or copy carries its source path as the next NUL field.
    if (field[0] === 'R' || field[0] === 'C') i++;
  }
  return paths;
}

/**
 * Merge `source` into `branch` with plumbing alone, for when no worktree has
 * `branch` checked out: `merge-tree --write-tree` builds the merged tree,
 * `commit-tree` makes the two-parent merge commit (author and committer from
 * git config, as `git merge` would), and `update-ref` moves `branch` only if
 * it still points where the merge started.
 *
 * No working tree means no commit hook runs — deliberately: the queue is
 * plumbing, and the gate runs the suite. It also means nothing is added to,
 * removed from or pruned out of the repository's worktree list.
 *
 * A conflict throws, and so does a `branch` that moved during the merge;
 * either way `branch` is left where it was.
 */
/** `merge-tree --write-tree` + `commit-tree`, the two-parent merge commit
 * alone — no ref touched. Shared by `mergeWithoutWorktree` (one task, lands
 * immediately) and `attemptCandidate` (N tasks, chained, lands only once at
 * the end). */
function buildMergeCommit(projectDir: string, base: string, head: string, message: string): string {
  const tree = writeMergeTree(projectDir, base, head);
  return runGit(projectDir, ['commit-tree', tree, '-p', base, '-p', head, '-m', message]);
}

function mergeWithoutWorktree(
  projectDir: string,
  branch: string,
  source: string,
  message: string,
): void {
  const base = runGit(projectDir, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  const head = runGit(projectDir, ['rev-parse', '--verify', `${source}^{commit}`]);
  const commit = buildMergeCommit(projectDir, base, head, message);
  runGit(projectDir, ['update-ref', '-m', message, `refs/heads/${branch}`, commit, base]);
}

/**
 * Land an already-built candidate commit onto `integrationBranch`, the same
 * way `step` decides where to merge (worktreeHolding), reused here so a
 * batch candidate never bypasses that check the way the bare `update-ref`
 * CAS used to. No worktree holds the branch: land with the CAS `update-ref`
 * plumbing alone, exactly as before. A worktree holds it and carries
 * uncommitted tracked changes: land nothing, the same `integration-dirty`
 * refusal `step` reports. A clean holder: fast-forward its checkout onto
 * `candidate` — safe because every caller built `candidate` with `base` as
 * an ancestor — so the working tree follows the ref instead of drifting
 * from under whoever has it checked out.
 */
type LandOutcome =
  | { outcome: 'landed' }
  | { outcome: 'integration-dirty'; worktree: string; dirty: string[] }
  | { outcome: 'integration-moved' };

function landCandidate(
  projectDir: string,
  integrationBranch: string,
  base: string,
  candidate: string,
  message: string,
): LandOutcome {
  const holder = worktreeHolding(projectDir, integrationBranch);
  if (holder === null) {
    try {
      runGit(projectDir, [
        'update-ref',
        '-m',
        message,
        `refs/heads/${integrationBranch}`,
        candidate,
        base,
      ]);
    } catch {
      return { outcome: 'integration-moved' };
    }
    return { outcome: 'landed' };
  }

  const dirty = trackedChanges(holder);
  if (dirty.length > 0) {
    return { outcome: 'integration-dirty', worktree: holder, dirty };
  }

  try {
    execFileSync('git', ['merge', '--ff-only', candidate], { cwd: holder, stdio: 'pipe' });
  } catch {
    return { outcome: 'integration-moved' };
  }
  return { outcome: 'landed' };
}

/**
 * A scratch worktree for testing a batch candidate before anything lands —
 * a sibling of the project, the same convention `taskWorktreeDir` uses, but
 * named so it can never collide with a real task id or the reserved
 * `integration` one: nothing outside this function should ever address it.
 */
function batchCandidateWorktreeDir(projectDir: string): string {
  const project = path.resolve(projectDir);
  return path.join(path.dirname(project), '.wt', path.basename(project), `batch-${randomUUID()}`);
}

/**
 * Fold `readyTasks` onto the current integration head with git plumbing
 * alone (no worktree, no branch touched until the very end), test the result
 * once in a throwaway detached worktree, and either land it with one
 * compare-and-swap or bisect it. `readyTasks` have already been certified and
 * rebased by the caller (`runGroup`) — this only builds, tests and lands.
 */
async function attemptCandidate(
  readyTasks: QueueTask[],
  opts: StepOptions,
  integrationBranch: string,
  logBlocked: (taskId: string, error: string, detail: string) => Promise<void>,
): Promise<{ outcomes: StepOutcome[]; suiteRuns: number }> {
  const projectDir = opts.projectDir;
  const base = runGit(projectDir, ['rev-parse', '--verify', `refs/heads/${integrationBranch}^{commit}`]);

  // Chain each task's merge onto the last, exactly like `mergeWithoutWorktree`
  // does for one task — `merge-tree` computes its own merge-base from the two
  // commits it is given, and since every task was rebased onto `base` (not
  // onto each other), that merge-base is `base` at every step. Claim-disjoint
  // tasks (groupForBatch's contract) fold without conflict; a fold that does
  // conflict anyway throws, same as a single-task merge conflict would.
  let head = base;
  const foldCommits = new Map<string, string>();
  for (const task of readyTasks) {
    const source = runGit(projectDir, ['rev-parse', '--verify', `${task.branch}^{commit}`]);
    const message = `Merge ${task.taskId} into ${integrationBranch}`;
    head = buildMergeCommit(projectDir, head, source, message);
    foldCommits.set(task.taskId, head);
  }
  const candidate = head;

  const worktreeDir = batchCandidateWorktreeDir(projectDir);
  runGit(projectDir, ['worktree', 'add', '--detach', worktreeDir, candidate]);
  let testOutcome: { passed: boolean; output: string };
  try {
    testOutcome = runTestCmd(opts.testCmd, worktreeDir);
  } finally {
    // Always removed, including on error — this worktree exists only to run
    // one suite once and has no meaning once that suite has an answer.
    runGit(projectDir, ['worktree', 'remove', '--force', worktreeDir]);
  }

  if (testOutcome.passed) {
    const message = `Batch-merge ${readyTasks.map((t) => t.taskId).join(', ')} into ${integrationBranch}`;
    const landing = landCandidate(projectDir, integrationBranch, base, candidate, message);

    if (landing.outcome === 'integration-dirty') {
      // Mirrors `step`'s own refusal: a worktree holds the integration
      // branch and carries uncommitted tracked changes, so merging into it
      // either stops half-way or folds someone's unfinished work in. The
      // tests already ran and passed; nothing landed.
      const outcomes: StepOutcome[] = [];
      for (const task of readyTasks) {
        await logBlocked(
          task.taskId,
          'execution.env-failure',
          `${integrationBranch} is checked out in ${landing.worktree}, which has uncommitted changes: ${landing.dirty.join(', ')}`,
        );
        outcomes.push({
          outcome: 'integration-dirty',
          taskId: task.taskId,
          worktree: landing.worktree,
          dirty: landing.dirty,
        });
      }
      return { outcomes, suiteRuns: 1 };
    }

    if (landing.outcome === 'integration-moved') {
      // The ref moved under the batch between the candidate's build and its
      // land — D-46's compare-and-swap race, the same one a single task's
      // `mergeWithoutWorktree` throws on, just reachable here with a whole
      // group under test at once. Nothing landed, so every ready task
      // reports it rather than one throw swallowing the rest of the group.
      const outcomes: StepOutcome[] = [];
      for (const task of readyTasks) {
        await logBlocked(
          task.taskId,
          'execution.env-failure',
          `${integrationBranch} moved to a different commit while this batch was testing; nothing landed.`,
        );
        outcomes.push({ outcome: 'integration-moved', taskId: task.taskId });
      }
      return { outcomes, suiteRuns: 1 };
    }

    const outcomes: StepOutcome[] = [];
    for (const task of readyTasks) {
      const commit = foldCommits.get(task.taskId) as string;
      if (opts.events) {
        const { ctx, ...opt } = opts.events;
        // This task's own merge commit against its own first parent — not
        // the integration tip, which by now carries every task in the batch.
        await emitWaveMerged(task.taskId, ctx, opt, mergedFiles(projectDir, commit));
      }
      outcomes.push({ outcome: 'merged', taskId: task.taskId });
    }
    return { outcomes, suiteRuns: 1 };
  }

  // Red. A lone task's failure is a genuine test failure, reported exactly as
  // `step` reports one. Two or more: bisect — Zuul's shared-queue gating and
  // Mergify's batch/bisect (cited at groupForBatch) — rather than fail every
  // task in the group for one task's sake: split, recurse on the left half,
  // then recurse on the right half. `runGroup` re-certifies and re-rebases
  // each half against whatever the integration head is when its turn comes,
  // which is what makes "land the innocent half, then retest the guilty one
  // rebuilt on the new head" and "the left half was itself red, so it
  // recursed, and only then did the right half get its own turn" the same
  // code path: the right half's `runGroup` call sees the left half's result
  // simply because it starts after the left half's `await` returns.
  if (readyTasks.length === 1) {
    const task = readyTasks[0] as QueueTask;
    const outputTail = tailLines(testOutcome.output, OUTPUT_TAIL_LINES);
    await logBlocked(task.taskId, 'execution.test-failure', outputTail);
    return { outcomes: [{ outcome: 'tests-failed', taskId: task.taskId, outputTail }], suiteRuns: 1 };
  }

  const mid = Math.ceil(readyTasks.length / 2);
  const left = await runGroup(readyTasks.slice(0, mid), opts, integrationBranch, logBlocked);
  const right = await runGroup(readyTasks.slice(mid), opts, integrationBranch, logBlocked);
  return {
    outcomes: [...left.outcomes, ...right.outcomes],
    suiteRuns: 1 + left.suiteRuns + right.suiteRuns,
  };
}

/**
 * Certify and rebase every task in the group, then fold whatever survives
 * into one candidate via `attemptCandidate` — recursing through
 * `attemptCandidate` on a red candidate. Order-preserving: a task's outcome
 * lands at its own position in the returned array no matter which half of a
 * bisection (or neither — a certify/rebase refusal) produced it, so the
 * caller can print outcomes in admitted order the same way `step` does.
 */
async function runGroup(
  tasks: QueueTask[],
  opts: StepOptions,
  integrationBranch: string,
  logBlocked: (taskId: string, error: string, detail: string) => Promise<void>,
): Promise<{ outcomes: StepOutcome[]; suiteRuns: number }> {
  if (tasks.length === 0) return { outcomes: [], suiteRuns: 0 };

  const byTaskId = new Map<string, StepOutcome>();
  const ready: QueueTask[] = [];
  for (const task of tasks) {
    const early = await certifyAndRebase(task, integrationBranch, logBlocked);
    if (early) byTaskId.set(task.taskId, early);
    else ready.push(task);
  }

  let suiteRuns = 0;
  if (ready.length > 0) {
    const result = await attemptCandidate(ready, opts, integrationBranch, logBlocked);
    suiteRuns = result.suiteRuns;
    for (const outcome of result.outcomes) byTaskId.set(outcome.taskId, outcome);
  }

  return { outcomes: tasks.map((t) => byTaskId.get(t.taskId) as StepOutcome), suiteRuns };
}

export interface BatchStepResult {
  outcomes: StepOutcome[];
  suiteRuns: number;
}

/**
 * The batch equivalent of `step`, for a group of two or more claim-disjoint
 * tasks (`groupForBatch` decides the grouping; a group of one should just
 * call `step`). Rebases each task in its own worktree exactly as `step`
 * does, stacks the survivors into one candidate with git plumbing alone (no
 * worktree touches the project checkout, no branch moves until the end), and
 * runs the test command once against it. Green lands the whole candidate
 * with one compare-and-swap; red bisects (see `attemptCandidate`) instead of
 * failing every task in the group for one task's sake.
 */
export async function batchStep(tasks: QueueTask[], opts: StepOptions): Promise<BatchStepResult> {
  const integrationBranch = integrationBranchName(opts.epic);
  const events = opts.events;
  const logBlocked = async (taskId: string, error: string, detail: string): Promise<void> => {
    if (!events) return;
    const { ctx, ...opt } = events;
    await emitTaskBlocked(taskId, { error, severity: 'S2-major', detail }, ctx, opt);
  };
  return runGroup(tasks, opts, integrationBranch, logBlocked);
}

export type AdoptTask = Omit<QueueTask, 'worktreeDir'>;

export interface AdoptOptions {
  projectDir: string;
  epic: string;
  /** The merge commit the operator claims landed this task. Any rev git resolves. */
  mergeCommit: string;
  /** Where to write the `wave-merged`. Omit to verify the claim without logging it. */
  events?: EventOpts & { ctx: TaskEventContext };
}

export interface AdoptOutcome {
  outcome: 'adopted';
  taskId: string;
  /** The full sha of the verified merge — `mergeCommit` may have been abbreviated. */
  mergeCommit: string;
  filesChanged: string[];
}

/** The commit `ref` names, or null when it names nothing (or nothing committish). */
function resolveCommit(projectDir: string, ref: string): string | null {
  try {
    return runGit(projectDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

function isAncestor(projectDir: string, ancestor: string, descendant: string): boolean {
  try {
    runGit(projectDir, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a merge that landed outside the queue — after verifying it did (D-137).
 *
 * `queue run` refuses to log a merge under an id the plan does not contain, and
 * that guard is right. What it left was a hole with no floor: `envkit-mcp-followup`
 * was merged by hand, so four tasks were genuinely on the integration branch and
 * the log held zero `wave-merged` events — the only event db/projector.ts folds to
 * `completed`. The epic could not be closed by any honest means, which is a
 * standing invitation to `event append` one by hand.
 *
 * So this verb takes the claim and checks it against the repository, in the order
 * a reader would: the branch and the commit exist, the commit is a merge, the
 * merge is on the integration branch, the branch head is one of its parents, and
 * the branch carried something the merge could have landed. Only then does it
 * write the same `wave-merged` the queue would have written.
 *
 * Refusals throw. They deliberately do NOT log an `error-logged`: a
 * non-coordination one folds the task to `blocked`, and a task whose adopt
 * command was mistyped is not blocked — that would put a wrong status in the
 * table to record a wrong command line.
 */
export async function adopt(task: AdoptTask, opts: AdoptOptions): Promise<AdoptOutcome> {
  const { projectDir } = opts;
  const integrationBranch = integrationBranchName(opts.epic);

  for (const ref of [integrationBranch, task.branch]) {
    if (!resolveCommit(projectDir, ref)) {
      throw new QueueError(
        'queue.adopt-unknown-branch',
        `Branch "${ref}" does not exist in ${projectDir} — there is nothing to adopt against.`,
        { branch: ref, taskId: task.taskId },
      );
    }
  }
  const branchHead = resolveCommit(projectDir, task.branch) as string;

  const merge = resolveCommit(projectDir, opts.mergeCommit);
  if (!merge) {
    throw new QueueError(
      'queue.adopt-unknown-commit',
      `"${opts.mergeCommit}" does not name a commit in ${projectDir}.`,
      { mergeCommit: opts.mergeCommit, taskId: task.taskId },
    );
  }

  // `rev-list --parents -n 1 <sha>` prints the commit then its parents.
  const parents = runGit(projectDir, ['rev-list', '--parents', '-n', '1', merge])
    .split(/\s+/)
    .slice(1)
    .filter((p) => p.length > 0);
  if (parents.length < 2) {
    throw new QueueError(
      'queue.adopt-not-a-merge',
      `Commit ${merge} has ${parents.length} parent(s), so it is not a merge. Name the merge commit that brought "${task.branch}" onto ${integrationBranch}.`,
      { mergeCommit: merge, taskId: task.taskId },
    );
  }

  if (!isAncestor(projectDir, merge, integrationBranch)) {
    throw new QueueError(
      'queue.adopt-not-on-integration',
      `Merge ${merge} is not reachable from ${integrationBranch}. A merge the epic's integration branch does not contain landed nothing for this epic.`,
      { mergeCommit: merge, integrationBranch, taskId: task.taskId },
    );
  }

  // Parent identity, not ancestry, and on purpose: a branch that grew after the
  // hand-merge did not land everything it now carries, and adopting it would
  // mark work completed that is not on the integration branch at all.
  if (!parents.includes(branchHead)) {
    throw new QueueError(
      'queue.adopt-branch-not-merged',
      `Merge ${merge} has no parent equal to the head of "${task.branch}" (${branchHead}). Either the merge did not bring in this branch, or the branch has moved on since — in which case what it carries now has not landed.`,
      { mergeCommit: merge, branch: task.branch, branchHead, parents, taskId: task.taskId },
    );
  }

  // D-30 restated for the merge commit: a branch cut and never committed to is
  // the first parent of every merge made after it, so "is a parent" on its own
  // would adopt a task that landed nothing.
  const landed = Number(
    runGit(projectDir, ['rev-list', '--count', `${parents[0]}..${branchHead}`]),
  );
  if (!landed) {
    throw new QueueError(
      'queue.adopt-nothing-landed',
      `"${task.branch}" carries no commit that merge ${merge} could have landed — it is that merge's own base. A task that merged nothing did not finish (D-30).`,
      { mergeCommit: merge, branch: task.branch, taskId: task.taskId },
    );
  }

  const filesChanged = mergedFiles(projectDir, merge);
  if (opts.events) {
    const { ctx, ...opt } = opts.events;
    await emitWaveMerged(task.taskId, ctx, opt, filesChanged);
  }

  return {
    outcome: 'adopted',
    taskId: task.taskId,
    mergeCommit: merge,
    filesChanged: filesChanged ?? [],
  };
}

/**
 * The files the merge brought in, read off the merge commit itself (P9-15): the
 * queue is the only component that knows which files a landed branch actually
 * rewrote, and an open finding anchored to one of them is evidence about code
 * that no longer exists.
 *
 * `<merge>^1..<merge>` — the first parent is the integration branch as it was a
 * moment before, so this is exactly "what this merge changed" and not "what the
 * task branch diverged by". A failure returns undefined rather than throwing:
 * the merge has already landed, and losing the file list degrades the
 * staleness check to its claims fallback instead of failing a queue step.
 */
function mergedFiles(projectDir: string, merge = 'HEAD'): string[] | undefined {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${merge}^1`, merge], {
      cwd: projectDir,
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  } catch {
    return undefined;
  }
}

/**
 * Decide what to run. Any failure to build the graph — an unreadable worktree,
 * a git call that did not answer — falls back to the operator's full command
 * with the reason attached, because a test gate that skips on error is not a
 * gate.
 */
function planTestRun(
  worktreeDir: string,
  opts: StepOptions,
): { cmd: string; report?: TestRunReport } {
  const template = opts.selectTestCmd;
  // No template means selection was never asked for, so there is nothing to
  // report: `tests` present in a result means selection ran, and its absence
  // means the operator's full command was the only command there ever was.
  if (template === undefined) return { cmd: opts.testCmd };

  try {
    const changed = collectCommittedChanges(worktreeDir);
    const graph = buildSymbolGraph(collectSources(worktreeDir));
    const selection = selectTests(graph, changed);
    if (selection.status === 'selected') {
      return {
        cmd: renderSelectedTestCmd(template, selection.tests),
        report: { mode: 'selected', ran: selection.tests, known: selection.allTests.length },
      };
    }
    return {
      cmd: opts.testCmd,
      report: { mode: 'full', known: selection.allTests.length, reasons: selection.reasons },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      cmd: opts.testCmd,
      report: { mode: 'full', reasons: [`selection failed: ${message}`] },
    };
  }
}

function runTestCmd(testCmd: string, cwd: string): { passed: boolean; output: string } {
  try {
    const output = execFileSync(testCmd, {
      cwd,
      shell: true,
      encoding: 'utf8',
      stdio: 'pipe',
      env: projectCommandEnv(process.env),
    });
    return { passed: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message;
    return { passed: false, output };
  }
}
