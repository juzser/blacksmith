import path from 'node:path';
import { SmithError } from './errors.js';
import { runGit as git } from './git.js';

export class WorktreeError extends SmithError {}

/** The task-id segment reserved for an epic's integration branch (smith/<epic>/integration) —
 * never a real task. Exported for db/projector.ts's foldTasks() guard and epic.ts's
 * runEpicVerdict(), both of which need to recognise `<epic>/integration` as non-task. */
export const RESERVED_TASK_ID = 'integration';

function localBranchExists(projectDir: string, branch: string): boolean {
  try {
    git(projectDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort default-branch detection: origin/HEAD symbolic ref first (the
 * normal case after a clone), then whatever branch is currently checked out,
 * then the conventional main/master names.
 */
function detectDefaultBranch(projectDir: string): string {
  try {
    const ref = git(projectDir, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const name = ref.replace(/^refs\/remotes\/origin\//, '');
    if (name && name !== ref) return name;
  } catch {
    // no origin/HEAD — fall through
  }

  try {
    const current = git(projectDir, ['branch', '--show-current']);
    if (current) return current;
  } catch {
    // detached or no commits yet — fall through
  }

  for (const candidate of ['main', 'master']) {
    if (localBranchExists(projectDir, candidate)) return candidate;
  }

  throw new WorktreeError(
    'worktree.default-branch-not-found',
    `Could not detect a default branch in ${projectDir}.`,
    { projectDir },
  );
}

/**
 * A task id without its own epic prefix: `epic-7/task-142` under epic-7 is
 * `task-142`, and the same string under a *different* epic is left alone —
 * the leading segment belongs to the id then, not to this epic.
 *
 * D-177: the branch name applied this strip and the directory did not, so one
 * task id addressed one branch but two directories, and which one you got
 * depended on how the operator happened to spell the id. Every shipped spec
 * writes the qualified form; `listStale` derives the id it prints from the
 * branch, so it always prints the bare form — and `worktree rm`, the verb the
 * operator guide pairs it with, computed a path that did not exist for any
 * worktree created from the qualified spelling. Four envkit worktrees sat on
 * disk unreachable by the only verb meant to remove them.
 *
 * Deliberately not taskId.ts's single-argument `bareTaskId`, which drops the
 * first segment whether or not it matches: a task id whose leading segment is
 * some *other* epic keeps it, here and in the branch alike.
 */
function bareTaskId(epic: string, taskId: string): string {
  return taskId.startsWith(`${epic}/`) ? taskId.slice(epic.length + 1) : taskId;
}

/**
 * Where a task's worktree lives: `<parent>/.wt/<project>/<bare-task-id>`, a
 * SIBLING of the project rather than a child of it. Takes the epic for the
 * same reason `taskBranchName` does — so both spellings of one id land in one
 * place (D-177).
 *
 * D-42/P9-26: this used to be `path.join(projectDir, 'wt', taskId)`, and the
 * cost was an epic whose six per-task lint gates were all green while
 * `pnpm lint` at the integration root exited 1 without reading a source file.
 * Every worktree is a full checkout carrying the project's own `biome.json`,
 * so a tool that walks down from the project root found seven root configs
 * and refused to run. From inside a worktree the siblings are not
 * descendants, so no task gate could ever see the condition. Placing them
 * outside the root kills the class outright: no root-walking tool can reach
 * a path it would have to climb *up* to find, whatever tool comes next.
 *
 * D-40: absolute, always. `git worktree add` resolves a relative path against
 * the git cwd — which is `projectDir` — so a relative `projectDir` used to
 * put the checkout at `<root>/envkit/<root>/envkit/wt/<task>` while
 * the returned path claimed otherwise. Resolving up front means the string
 * this module returns is the string on disk.
 */
export function taskWorktreeDir(projectDir: string, epic: string, taskId: string): string {
  const project = path.resolve(projectDir);
  return path.join(path.dirname(project), '.wt', path.basename(project), bareTaskId(epic, taskId));
}

/** `smith/<epic>/integration` — the one branch an epic assembles onto. Exported for
 * integration.ts, which runs the check suite against it (D-42/P9-26). */
export function integrationBranchName(epic: string): string {
  return `smith/${epic}/integration`;
}

/**
 * `smith/<epic>/<bare-task-id>` — the branch convention, defined once.
 *
 * D-23/P9-12: exported because three places need to agree on it — this module
 * (which creates the branch), taskEvents.ts's `task-added` (which declares it
 * so the board can link to it before any worktree exists), and
 * db/projector.ts's fallback for events logged before that payload field.
 * Three hand-written copies of one string convention is one copy too many.
 *
 * A task_id already embeds its epic ("epic-7/task-142", findings.ts's
 * convention) so strip that prefix before rejoining — concatenating epic +
 * full task_id double-embeds it (smith/epic-7/epic-7/task-142). The CLI hands
 * this whatever the operator typed, so both shapes really do arrive.
 */
export function taskBranchName(epic: string, taskId: string): string {
  return `smith/${epic}/${bareTaskId(epic, taskId)}`;
}

function ensureIntegrationBranch(projectDir: string, epic: string): string {
  const branch = integrationBranchName(epic);
  if (!localBranchExists(projectDir, branch)) {
    const defaultBranch = detectDefaultBranch(projectDir);
    git(projectDir, ['branch', branch, defaultBranch]);
  }
  return branch;
}

export interface TaskWorktree {
  worktreeDir: string;
  branch: string;
  epic: string;
  taskId: string;
}

/**
 * Create a task worktree at `<projects root>/.wt/<project>/<task-id>` — a
 * sibling of whatever directory the project was handed as, never a path of
 * this module's own choosing, so a project outside this clone keeps its
 * worktrees outside it too (see taskWorktreeDir)
 * on branch smith/<epic>/<task-id>, cut from the CURRENT head of
 * smith/<epic>/integration (creating the integration branch from the default
 * branch first if it doesn't exist yet).
 */
export function createTaskWorktree(projectDir: string, epic: string, taskId: string): TaskWorktree {
  if (taskId === RESERVED_TASK_ID) {
    throw new WorktreeError(
      'worktree.reserved-task-id',
      `Task id "${RESERVED_TASK_ID}" is reserved for the integration branch itself.`,
      { taskId },
    );
  }

  const integrationBranch = ensureIntegrationBranch(projectDir, epic);
  const branch = taskBranchName(epic, taskId);
  const worktreeDir = taskWorktreeDir(projectDir, epic, taskId);

  git(projectDir, ['worktree', 'add', '-b', branch, worktreeDir, integrationBranch]);

  return { worktreeDir, branch, epic, taskId };
}

/** Remove a task's worktree and its local branch after it has merged. */
export function removeTaskWorktree(projectDir: string, epic: string, taskId: string): void {
  const worktreeDir = taskWorktreeDir(projectDir, epic, taskId);
  const branch = taskBranchName(epic, taskId);

  try {
    git(projectDir, ['worktree', 'remove', worktreeDir]);
  } catch (err) {
    throw new WorktreeError(
      'worktree.remove-failed',
      `Failed to remove worktree at ${worktreeDir}: ${err instanceof Error ? err.message : String(err)}`,
      { worktreeDir },
    );
  }

  try {
    git(projectDir, ['branch', '-d', branch]);
  } catch (err) {
    throw new WorktreeError(
      'worktree.branch-delete-failed',
      `Failed to delete branch ${branch} (not fully merged?): ${err instanceof Error ? err.message : String(err)}`,
      { branch },
    );
  }
}

export interface StaleWorktree {
  worktreeDir: string;
  branch: string;
  taskId: string;
}

interface PorcelainEntry {
  worktree: string;
  branch: string | null;
}

function parseWorktreePorcelain(output: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  let current: Partial<PorcelainEntry> | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current?.worktree)
        entries.push({ worktree: current.worktree, branch: current.branch ?? null });
      current = { worktree: line.slice('worktree '.length), branch: null };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === '' && current?.worktree) {
      entries.push({ worktree: current.worktree, branch: current.branch ?? null });
      current = null;
    }
  }
  if (current?.worktree)
    entries.push({ worktree: current.worktree, branch: current.branch ?? null });

  return entries;
}

/**
 * List task worktrees whose branch is fully merged into smith/<epic>/integration.
 * Reports only — never deletes.
 */
export function listStale(projectDir: string, epic: string): StaleWorktree[] {
  const integrationBranch = integrationBranchName(epic);
  const prefix = `smith/${epic}/`;

  const porcelain = git(projectDir, ['worktree', 'list', '--porcelain']);
  const entries = parseWorktreePorcelain(porcelain);

  const stale: StaleWorktree[] = [];
  for (const entry of entries) {
    if (!entry.branch?.startsWith(prefix)) continue;
    const taskId = entry.branch.slice(prefix.length);
    if (taskId === RESERVED_TASK_ID) continue;

    try {
      git(projectDir, ['merge-base', '--is-ancestor', entry.branch, integrationBranch]);
      stale.push({ worktreeDir: entry.worktree, branch: entry.branch, taskId });
    } catch {
      // not an ancestor -> not merged yet, not stale
    }
  }
  return stale;
}
