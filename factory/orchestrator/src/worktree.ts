import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SmithError } from './errors.js';
import { runGit as git } from './git.js';

export class WorktreeError extends SmithError {}

/** The task-id segment reserved for an epic's integration branch (<prefix>/<epic>/integration) —
 * never a real task. Exported for db/projector.ts's foldTasks() guard and epic.ts's
 * runEpicVerdict(), both of which need to recognise `<epic>/integration` as non-task. */
export const RESERVED_TASK_ID = 'integration';

/**
 * Where the commit a task branch was cut from is recorded: `refs/bs/base/<branch>`.
 * A SHA, not a branch name, so moving the base branch afterwards does not move what
 * the task is judged against. The MCP manifest check of the gate reads it.
 */
export function taskBaseRef(branch: string): string {
  return `refs/bs/base/${branch}`;
}

function localBranchExists(projectDir: string, branch: string): boolean {
  try {
    git(projectDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a task's own branch (`taskBranchName`) already exists locally —
 * i.e. whether the task has already been cut. Exported for cli.ts's
 * `worktree create --from` guard: spec.ts's `successorChainPath` hands back
 * the bare hop ids between a `--from` predecessor and its target purely from
 * the event log, with no notion of git state; this is the git-aware
 * predicate the guard pairs it with to refuse skipping past a hop that was
 * already cut (`createTaskWorktree` branches straight off `--from`'s own
 * branch, so a cut hop's commits would otherwise vanish silently).
 */
export function taskBranchExists(projectDir: string, epic: string, taskId: string): boolean {
  return localBranchExists(
    projectDir,
    taskBranchName(epic, taskId, epicBranchPrefix(projectDir, epic)),
  );
}

/**
 * Default-branch detection: origin/HEAD symbolic ref first (the normal case
 * after a clone). Without a remote: the checked-out branch if it is main or
 * master; else the one of main/master that exists; if both exist,
 * `init.defaultBranch` (any config scope) breaks the tie, otherwise refused as
 * ambiguous; if neither exists, the checked-out branch — never a factory
 * branch (`bs/…`, legacy `smith/…`), where a session usually stands.
 */
export function detectDefaultBranch(projectDir: string): string {
  try {
    const ref = git(projectDir, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const name = ref.replace(/^refs\/remotes\/origin\//, '');
    if (name && name !== ref) return name;
  } catch {
    // no origin/HEAD — fall through
  }

  let current = '';
  try {
    current = git(projectDir, ['branch', '--show-current']);
  } catch {
    // detached or no commits yet — no checked-out branch to consult
  }

  const conventional = ['main', 'master'].filter((c) => localBranchExists(projectDir, c));
  if (conventional.includes(current)) return current;
  if (conventional.length === 1) return conventional[0] as string;
  if (conventional.length > 1) {
    try {
      const configured = git(projectDir, ['config', '--get', 'init.defaultBranch']);
      if (conventional.includes(configured)) return configured;
    } catch {
      // init.defaultBranch unset — ambiguous
    }
    throw new WorktreeError(
      'worktree.default-branch-ambiguous',
      `Both ${conventional.join(' and ')} exist in ${projectDir}; no remote, checked-out main/master or init.defaultBranch says which is the default branch.`,
      { projectDir, candidates: conventional },
    );
  }

  if (current && !isFactoryBranch(current)) return current;

  throw new WorktreeError(
    'worktree.default-branch-not-found',
    `Could not detect a default branch in ${projectDir}.`,
    { projectDir },
  );
}

function isFactoryBranch(branch: string): boolean {
  return [BRANCH_PREFIX, LEGACY_BRANCH_PREFIX].some((p) => branch.startsWith(`${p}/`));
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

/** The branch prefix every new epic gets (bs-rename operator decision 1). */
export const BRANCH_PREFIX = 'bs';

/** The prefix `BRANCH_PREFIX` replaced. Still recognised so an epic already
 * cut under it keeps landing new branches there (operator decision 3) rather
 * than splitting one epic's worktrees across two branch families. */
export const LEGACY_BRANCH_PREFIX = 'smith';

/**
 * Which prefix THIS epic's factory branches use: `smith` when
 * `smith/<epic>/integration` already exists locally, `bs` otherwise —
 * including for a brand-new epic, which has neither yet. Git-aware on
 * purpose: this is the one place that decides, so integrationBranchName and
 * taskBranchName can stay pure string joins driven by whatever prefix their
 * caller resolved (or hands the bs default straight through, for the
 * git-free callers — taskEvents.ts and db/projector.ts's fallback — that
 * have no projectDir to ask).
 */
export function epicBranchPrefix(projectDir: string, epic: string): string {
  return localBranchExists(projectDir, `${LEGACY_BRANCH_PREFIX}/${epic}/${RESERVED_TASK_ID}`)
    ? LEGACY_BRANCH_PREFIX
    : BRANCH_PREFIX;
}

/** `<prefix>/<epic>/integration` — the one branch an epic assembles onto.
 * `prefix` defaults to BRANCH_PREFIX (`bs`); a caller with a projectDir
 * passes `epicBranchPrefix(projectDir, epic)` to get the epic's actual
 * prefix, legacy `smith/` included. Exported for integration.ts, which runs
 * the check suite against it (D-42/P9-26). */
export function integrationBranchName(epic: string, prefix: string = BRANCH_PREFIX): string {
  return `${prefix}/${epic}/integration`;
}

/**
 * `<prefix>/<epic>/<bare-task-id>` — the branch convention, defined once.
 * `prefix` defaults to BRANCH_PREFIX (`bs`) for the same reason as
 * integrationBranchName above.
 *
 * D-23/P9-12: exported because three places need to agree on it — this module
 * (which creates the branch), taskEvents.ts's `task-added` (which declares it
 * so the board can link to it before any worktree exists), and
 * db/projector.ts's fallback for events logged before that payload field.
 * Three hand-written copies of one string convention is one copy too many.
 *
 * A task_id already embeds its epic ("epic-7/task-142", findings.ts's
 * convention) so strip that prefix before rejoining — concatenating epic +
 * full task_id double-embeds it (bs/epic-7/epic-7/task-142). The CLI hands
 * this whatever the operator typed, so both shapes really do arrive.
 */
export function taskBranchName(
  epic: string,
  taskId: string,
  prefix: string = BRANCH_PREFIX,
): string {
  return `${prefix}/${epic}/${bareTaskId(epic, taskId)}`;
}

function ensureIntegrationBranch(projectDir: string, epic: string): string {
  const branch = integrationBranchName(epic, epicBranchPrefix(projectDir, epic));
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
  /** Set only when a reopen had to record the base itself: a branch cut before bases were recorded. */
  baseRecorded?: { sha: string; from: 'merge-base' | 'integration-head' };
}

/** Point a task branch's recorded base at `sha`: after a rebase, the commit it now sits on. */
export function moveTaskBase(cwd: string, branch: string, sha: string): void {
  git(cwd, ['update-ref', taskBaseRef(branch), sha]);
}

function hasRecordedBase(projectDir: string, branch: string): boolean {
  try {
    git(projectDir, ['rev-parse', '--verify', '--quiet', `${taskBaseRef(branch)}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export interface CreateTaskWorktreeOpts {
  /**
   * A predecessor task id to branch from instead of the integration branch's
   * current head. Set only for a successor task minted by a re-scope
   * (`plan propose` -> `plan approve` recording `successors{old->new}`,
   * spec.ts's `taskSuccessors`): the whole point is that the successor keeps
   * the predecessor's commits rather than starting over from integration.
   * cli.ts is what checks the id is an actual logged successor before this
   * ever runs — this module just needs the branch to exist.
   */
  from?: string;
}

/**
 * Create a task worktree at `<projects root>/.wt/<project>/<task-id>` — a
 * sibling of whatever directory the project was handed as, never a path of
 * this module's own choosing, so a project outside this clone keeps its
 * worktrees outside it too (see taskWorktreeDir)
 * on branch <prefix>/<epic>/<task-id>, where <prefix> is epicBranchPrefix's
 * answer for this epic (`bs`, or `smith` for an epic already cut under it).
 *
 * Without `opts.from`, cut from the CURRENT head of <prefix>/<epic>/integration
 * (creating the integration branch from the default branch first if it
 * doesn't exist yet). With `opts.from`, cut from <prefix>/<epic>/<from> instead
 * — the predecessor's branch, commits and all — and integration is never
 * consulted.
 */
export function createTaskWorktree(
  projectDir: string,
  epic: string,
  taskId: string,
  opts: CreateTaskWorktreeOpts = {},
): TaskWorktree {
  if (taskId === RESERVED_TASK_ID) {
    throw new WorktreeError(
      'worktree.reserved-task-id',
      `Task id "${RESERVED_TASK_ID}" is reserved for the integration branch itself.`,
      { taskId },
    );
  }

  const prefix = epicBranchPrefix(projectDir, epic);
  const branch = taskBranchName(epic, taskId, prefix);
  const worktreeDir = taskWorktreeDir(projectDir, epic, taskId);

  let sourceBranch: string;
  if (opts.from !== undefined) {
    sourceBranch = taskBranchName(epic, opts.from, prefix);
    if (!localBranchExists(projectDir, sourceBranch)) {
      throw new WorktreeError(
        'worktree.from-missing',
        `Predecessor branch ${sourceBranch} does not exist; cannot cut ${taskId} from it.`,
        { epic, taskId, from: opts.from, branch: sourceBranch },
      );
    }
  } else {
    sourceBranch = ensureIntegrationBranch(projectDir, epic);
  }

  const baseSha = git(projectDir, ['rev-parse', '--verify', `${sourceBranch}^{commit}`]);
  git(projectDir, ['worktree', 'add', '-b', branch, worktreeDir, sourceBranch]);
  git(projectDir, ['update-ref', taskBaseRef(branch), baseSha]);

  return { worktreeDir, branch, epic, taskId };
}

/** Remove a task's worktree and its local branch after it has merged. */
export function removeTaskWorktree(projectDir: string, epic: string, taskId: string): void {
  const worktreeDir = taskWorktreeDir(projectDir, epic, taskId);
  const branch = taskBranchName(epic, taskId, epicBranchPrefix(projectDir, epic));

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

  try {
    git(projectDir, ['update-ref', '-d', taskBaseRef(branch)]);
  } catch {
    // No recorded base (a task cut before they were recorded): nothing to delete.
  }
}

export interface StaleWorktree {
  worktreeDir: string;
  branch: string;
  taskId: string;
}

/** One block of `git worktree list --porcelain`. */
export interface PorcelainEntry {
  worktree: string;
  branch: string | null;
  /** A `locked` line, bare or with a reason; the reason is free text. */
  locked: boolean;
  lockedReason: string | null;
  detached: boolean;
  /** A `prunable` line, bare or with a reason: `git worktree prune` owns the entry. */
  prunable: boolean;
  prunableReason: string | null;
}

/**
 * Parse `git worktree list --porcelain`, including the `locked`, `detached`
 * and `prunable` lines. Exported for cleanup.ts (epic bs-optimize criterion 14).
 */
export function parseWorktreePorcelain(output: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  let entry: PorcelainEntry | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (entry) entries.push(entry);
      entry = {
        worktree: line.slice('worktree '.length),
        branch: null,
        locked: false,
        lockedReason: null,
        detached: false,
        prunable: false,
        prunableReason: null,
      };
    } else if (entry === null) {
      // text before the first block
    } else if (line.startsWith('branch ')) {
      entry.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      entry.detached = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      entry.locked = true;
      entry.lockedReason = line.slice('locked'.length).trim() || null;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      entry.prunable = true;
      entry.prunableReason = line.slice('prunable'.length).trim() || null;
    }
  }
  if (entry) entries.push(entry);

  return entries;
}

/**
 * List task worktrees whose branch is fully merged into <prefix>/<epic>/integration.
 * Reports only — never deletes.
 */
export function listStale(projectDir: string, epic: string): StaleWorktree[] {
  const branchPrefix = epicBranchPrefix(projectDir, epic);
  const integrationBranch = integrationBranchName(epic, branchPrefix);
  const prefix = `${branchPrefix}/${epic}/`;

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

/** The `.wt/<project>/` root every scratch worktree (integration.ts, postMerge.ts) is named under. */
function scratchRoot(projectDir: string): string {
  const project = path.resolve(projectDir);
  return path.join(path.dirname(project), '.wt', path.basename(project));
}

function isAncestor(projectDir: string, ancestor: string, descendant: string): boolean {
  try {
    git(projectDir, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reopen a reverted task's branch (spec D1): the task branch fast-forwards to
 * the integration head and gains one commit, `git revert <revertSha>`, so the
 * original change returns as new history. Never a reset, a rebase or a force.
 *
 * Everything that can refuse is read from refs and the existing worktree's
 * status first; the revert is then built in a scratch worktree detached at the
 * head, so a conflict leaves no worktree, ref or commit behind. Only after the
 * commit exists is the task worktree reused or attached (no `-b` when the
 * branch exists) and the branch fast-forwarded to it. `opts.onScratch` is a
 * test seam called with the scratch worktree's path right after it is created.
 */
export function reopenTaskWorktree(
  projectDir: string,
  epicId: string,
  taskId: string,
  revertSha: string,
  opts: { onScratch?: (scratchPath: string) => void } = {},
): TaskWorktree {
  if (taskId === RESERVED_TASK_ID) {
    throw new WorktreeError(
      'worktree.reserved-task-id',
      `Task id "${RESERVED_TASK_ID}" is reserved for the integration branch itself.`,
      { taskId },
    );
  }
  const prefix = epicBranchPrefix(projectDir, epicId);
  const branch = taskBranchName(epicId, taskId, prefix);
  const integration = integrationBranchName(epicId, prefix);
  const branchExists = localBranchExists(projectDir, branch);
  const existing = parseWorktreePorcelain(
    git(projectDir, ['worktree', 'list', '--porcelain']),
  ).find((entry) => entry.branch === branch);

  if (existing !== undefined && git(existing.worktree, ['status', '--porcelain']) !== '') {
    throw new WorktreeError(
      'worktree.reopen-dirty',
      `The worktree ${existing.worktree} of ${branch} has uncommitted changes; commit or discard them before reopening.`,
      { worktreeDir: existing.worktree, branch },
    );
  }
  if (branchExists && !isAncestor(projectDir, branch, integration)) {
    throw new WorktreeError(
      'worktree.reopen-not-ancestor',
      `${branch} is not an ancestor of ${integration}; it cannot be fast-forwarded to the head.`,
      { branch, integration },
    );
  }
  let revert: string | null = null;
  try {
    revert = git(projectDir, ['rev-parse', '--verify', '--quiet', `${revertSha}^{commit}`]);
  } catch {
    // Not a commit this clone knows: not on the integration branch either.
  }
  if (
    revert === null ||
    !localBranchExists(projectDir, integration) ||
    !isAncestor(projectDir, revert, integration)
  ) {
    throw new WorktreeError(
      'worktree.reopen-revert-not-on-integration',
      `${revertSha} is not on ${integration}.`,
      { revertSha, integration },
    );
  }

  // A reattached branch keeps the base it was cut with. One cut before bases were
  // recorded gets the merge-base with the integration branch, taken before the
  // branch moves, and the output says so. A deleted branch is cut afresh from the
  // integration head, which is its base.
  let baseRecorded: TaskWorktree['baseRecorded'];
  let legacyBase: string | undefined;
  if (branchExists && !hasRecordedBase(projectDir, branch)) {
    legacyBase = git(projectDir, ['merge-base', branch, integration]);
  }
  // Built before anything is written, so a refused reopen leaves no ref behind.
  const commit = buildReopenCommit(projectDir, integration, revert, opts.onScratch);
  if (legacyBase !== undefined) {
    moveTaskBase(projectDir, branch, legacyBase);
    baseRecorded = { sha: legacyBase, from: 'merge-base' };
  }
  if (existing !== undefined) {
    git(existing.worktree, ['merge', '--ff-only', commit]);
    return {
      worktreeDir: existing.worktree,
      branch,
      epic: epicId,
      taskId,
      ...(baseRecorded ? { baseRecorded } : {}),
    };
  }
  const worktreeDir = taskWorktreeDir(projectDir, epicId, taskId);
  if (branchExists) {
    git(projectDir, ['worktree', 'add', worktreeDir, branch]);
    git(worktreeDir, ['merge', '--ff-only', commit]);
  } else {
    const head = git(projectDir, ['rev-parse', '--verify', `${integration}^{commit}`]);
    git(projectDir, ['worktree', 'add', '-b', branch, worktreeDir, commit]);
    moveTaskBase(projectDir, branch, head);
    baseRecorded = { sha: head, from: 'integration-head' };
  }
  return { worktreeDir, branch, epic: epicId, taskId, ...(baseRecorded ? { baseRecorded } : {}) };
}

/** `git revert --no-edit <revert>` on the integration head in a throwaway worktree; returns the commit. */
function buildReopenCommit(
  projectDir: string,
  integration: string,
  revert: string,
  onScratch: ((scratchPath: string) => void) | undefined,
): string {
  const dir = path.join(scratchRoot(projectDir), `scratch-${process.pid}-${randomUUID()}`);
  git(projectDir, ['worktree', 'add', '--detach', dir, integration]);
  try {
    onScratch?.(dir);
    try {
      git(dir, ['revert', '--no-edit', revert]);
    } catch (error) {
      let inProgress = true;
      try {
        git(dir, ['rev-parse', '-q', '--verify', 'REVERT_HEAD']);
      } catch {
        inProgress = false;
      }
      if (!inProgress) throw error;
      const paths = git(dir, ['diff', '--name-only', '--diff-filter=U'])
        .split('\n')
        .filter(Boolean);
      git(dir, ['revert', '--abort']);
      throw new WorktreeError(
        'worktree.reopen-revert-conflict',
        `Reverting ${revert} on ${integration} conflicts in ${paths.join(', ')}; the change no longer applies cleanly, so supersede the task with one cut from the integration head.`,
        { revertSha: revert, paths },
      );
    }
    return git(dir, ['rev-parse', 'HEAD']);
  } finally {
    try {
      git(projectDir, ['worktree', 'remove', '--force', dir]);
    } catch {
      // The next run's dead-pid sweep removes whatever is left.
    }
  }
}
