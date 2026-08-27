import { execFileSync } from 'node:child_process';
import { collectCommittedChanges } from './claims.js';
import { type CommitBlockReason, certifyCommit, UNCOMMITTED_WORK_CODE } from './commit.js';
import { SmithError } from './errors.js';
import type { EventOpts } from './events.js';
import { runGit } from './git.js';
import { type DependencyEdge, topoSort } from './graph.js';
import { buildSymbolGraph, collectSources } from './symbols.js';
import { emitTaskBlocked, emitWaveMerged, type TaskEventContext } from './taskEvents.js';
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
    };

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
  const logBlocked = async (error: string, detail: string): Promise<void> => {
    if (!events) return;
    const { ctx, ...opt } = events;
    await emitTaskBlocked(task.taskId, { error, severity: 'S2-major', detail }, ctx, opt);
  };

  // Before the rebase, because a rebase, a test run and a merge all "succeed"
  // against a branch that carries nothing: certify that there is a commit to
  // merge at all (D-30/P9-8). A task that merges nothing is a bug, not a pass.
  const commit = certifyCommit(task.worktreeDir, { baseRef: integrationBranch });
  if (!commit.certified) {
    const reason = commit.reason as CommitBlockReason;
    await logBlocked(
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
      'integration.merge-conflict-textual',
      `Rebase onto ${integrationBranch} conflicted in: ${files.join(', ')}`,
    );
    return { outcome: 'rebase-conflict', taskId: task.taskId, conflictingFiles: files };
  }

  const plan = planTestRun(task.worktreeDir, opts);
  const testOutcome = runTestCmd(plan.cmd, task.worktreeDir);
  if (!testOutcome.passed) {
    const outputTail = tailLines(testOutcome.output, OUTPUT_TAIL_LINES);
    await logBlocked('execution.test-failure', outputTail);
    return {
      outcome: 'tests-failed',
      taskId: task.taskId,
      outputTail,
      ...(plan.report ? { tests: plan.report } : {}),
    };
  }

  execFileSync('git', ['checkout', integrationBranch], { cwd: opts.projectDir, stdio: 'pipe' });
  execFileSync(
    'git',
    ['merge', '--no-ff', task.branch, '-m', `Merge ${task.taskId} into ${integrationBranch}`],
    { cwd: opts.projectDir, stdio: 'pipe' },
  );

  if (events) {
    const { ctx, ...opt } = events;
    await emitWaveMerged(task.taskId, ctx, opt, mergedFiles(opts.projectDir));
  }

  return { outcome: 'merged', taskId: task.taskId, ...(plan.report ? { tests: plan.report } : {}) };
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
    const output = execFileSync(testCmd, { cwd, shell: true, encoding: 'utf8', stdio: 'pipe' });
    return { passed: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message;
    return { passed: false, output };
  }
}
