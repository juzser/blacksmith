import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTaskWorktree,
  listStale,
  removeTaskWorktree,
  WorktreeError,
} from '../src/worktree.js';
import { git } from './helpers/process.js';

describe('worktree.ts', () => {
  let root: string;
  let originDir: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-worktree-'));
    originDir = path.join(root, 'origin.git');
    projectDir = path.join(root, 'project');

    git(root, ['init', '-q', '--bare', '-b', 'main', originDir]);
    git(root, ['clone', '-q', originDir, projectDir]);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    await writeFile(path.join(projectDir, 'README.md'), '# project\n');
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-q', '-m', 'init']);
    git(projectDir, ['push', '-q', 'origin', 'main']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates the integration branch from the default branch on first use', () => {
    const result = createTaskWorktree(projectDir, 'epic-1', 'task-1');

    expect(result.branch).toBe('smith/epic-1/task-1');
    expect(existsSync(result.worktreeDir)).toBe(true);
    expect(result.worktreeDir).toBe(path.join(root, '.wt', 'project', 'task-1'));

    const branches = git(projectDir, ['branch', '--list']);
    expect(branches).toContain('smith/epic-1/integration');

    const content = readFileSync(path.join(result.worktreeDir, 'README.md'), 'utf8');
    expect(content).toBe('# project\n');
  });

  // D-42/P9-26: the whole finding. A worktree inside the project root is a
  // second copy of the project's own config where any root-walking tool will
  // find it, and the epic's lint went red at the integration root with every
  // task gate green. A sibling path is not reachable by walking down from the
  // project, so the class cannot recur for the next tool either.
  it('places the worktree outside the project root', () => {
    const result = createTaskWorktree(projectDir, 'epic-1', 'task-1');

    const relative = path.relative(projectDir, result.worktreeDir);
    expect(relative.startsWith('..')).toBe(true);
    expect(path.isAbsolute(result.worktreeDir)).toBe(true);
  });

  // D-40: `git worktree add` resolves a relative path against the git cwd,
  // which is projectDir — so a relative projectDir used to produce
  // workspaces/envkit/workspaces/envkit/wt/<task> on disk while the returned
  // path said otherwise. Every path this module hands out is absolute.
  it('resolves a relative projectDir instead of doubling it', () => {
    const relativeProject = path.relative(process.cwd(), projectDir);
    const result = createTaskWorktree(relativeProject, 'epic-1', 'task-1');

    expect(result.worktreeDir).toBe(path.join(root, '.wt', 'project', 'task-1'));
    expect(existsSync(path.join(result.worktreeDir, 'README.md'))).toBe(true);
  });

  it('rejects the reserved task-id "integration"', () => {
    expect(() => createTaskWorktree(projectDir, 'epic-1', 'integration')).toThrow(WorktreeError);
  });

  it('cuts a second task worktree from the CURRENT head of the integration branch', async () => {
    createTaskWorktree(projectDir, 'epic-1', 'task-1');

    // Advance the integration branch (simulating a prior merged task).
    git(projectDir, ['checkout', '-q', 'smith/epic-1/integration']);
    await writeFile(path.join(projectDir, 'advance.txt'), 'advanced\n');
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-q', '-m', 'advance integration']);

    const second = createTaskWorktree(projectDir, 'epic-1', 'task-2');
    expect(existsSync(path.join(second.worktreeDir, 'advance.txt'))).toBe(true);
  });

  it('removeTaskWorktree removes the worktree and the merged task branch', () => {
    const result = createTaskWorktree(projectDir, 'epic-1', 'task-1');

    // Merge the (unchanged) task branch into the integration branch so the
    // branch is fully merged and safe to delete.
    git(projectDir, ['checkout', '-q', 'smith/epic-1/integration']);
    git(projectDir, ['merge', '-q', '--no-ff', '-m', 'merge task-1', 'smith/epic-1/task-1']);

    removeTaskWorktree(projectDir, 'epic-1', 'task-1');

    expect(existsSync(result.worktreeDir)).toBe(false);
    const branches = git(projectDir, ['branch', '--list']);
    expect(branches).not.toContain('smith/epic-1/task-1');
  });

  it('listStale reports fully-merged task worktrees without deleting them', async () => {
    const t1 = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    const t2 = createTaskWorktree(projectDir, 'epic-1', 'task-2');

    // task-2 gets its own unfinished commit, so it is not an ancestor of the
    // integration branch (still "in flight", not stale).
    await writeFile(path.join(t2.worktreeDir, 'wip.txt'), 'wip\n');
    git(t2.worktreeDir, ['add', '.']);
    git(t2.worktreeDir, ['commit', '-q', '-m', 'wip on task-2']);

    git(projectDir, ['checkout', '-q', 'smith/epic-1/integration']);
    git(projectDir, ['merge', '-q', '--no-ff', '-m', 'merge task-1', 'smith/epic-1/task-1']);

    const stale = listStale(projectDir, 'epic-1');
    expect(stale.map((s) => s.taskId)).toEqual(['task-1']);
    // Not deleted.
    expect(existsSync(t1.worktreeDir)).toBe(true);
  });
});

// D-177: `taskBranchName` strips a matching `<epic>/` prefix and the directory
// never did, so one task id addressed one branch but two directories. Every
// shipped spec writes the qualified form, `listStale` derives the id it
// reports from the branch (always bare), and the two verbs the operator guide
// pairs — `worktree stale` then `worktree rm` — could not talk to each other.
describe('worktree.ts - a qualified task id is the same task as its bare form', () => {
  let root: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-worktree-id-'));
    const originDir = path.join(root, 'origin.git');
    projectDir = path.join(root, 'project');

    git(root, ['init', '-q', '--bare', '-b', 'main', originDir]);
    git(root, ['clone', '-q', originDir, projectDir]);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    await writeFile(path.join(projectDir, 'README.md'), '# project\n');
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-q', '-m', 'init']);
    git(projectDir, ['push', '-q', 'origin', 'main']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('puts a qualified task id in the same directory as its bare form', () => {
    const result = createTaskWorktree(projectDir, 'epic-1', 'epic-1/task-1');

    expect(result.branch).toBe('smith/epic-1/task-1');
    expect(result.worktreeDir).toBe(path.join(root, '.wt', 'project', 'task-1'));
    expect(existsSync(path.join(result.worktreeDir, 'README.md'))).toBe(true);
  });

  it('removes a worktree created from the other spelling of the same id', () => {
    const result = createTaskWorktree(projectDir, 'epic-1', 'epic-1/task-1');

    git(projectDir, ['checkout', '-q', 'smith/epic-1/integration']);
    git(projectDir, ['merge', '-q', '--no-ff', '-m', 'merge task-1', 'smith/epic-1/task-1']);

    removeTaskWorktree(projectDir, 'epic-1', 'task-1');

    expect(existsSync(result.worktreeDir)).toBe(false);
    expect(git(projectDir, ['branch', '--list'])).not.toContain('smith/epic-1/task-1');
  });

  it('round-trips the id listStale reports back into removeTaskWorktree', () => {
    const created = createTaskWorktree(projectDir, 'epic-1', 'epic-1/task-1');

    git(projectDir, ['checkout', '-q', 'smith/epic-1/integration']);
    git(projectDir, ['merge', '-q', '--no-ff', '-m', 'merge task-1', 'smith/epic-1/task-1']);

    const stale = listStale(projectDir, 'epic-1');
    expect(stale.map((s) => s.taskId)).toEqual(['task-1']);
    expect(stale[0]?.worktreeDir).toBe(realpathSync(created.worktreeDir));

    // The operator guide pairs these two verbs; the id one prints has to be an
    // id the other accepts.
    for (const s of stale) removeTaskWorktree(projectDir, 'epic-1', s.taskId);
    expect(existsSync(created.worktreeDir)).toBe(false);
  });

  // The strip is prefix-MATCHING, not "drop the first segment": a leading
  // segment that is not this epic belongs to the id and stays put, in the
  // directory exactly as it already does in the branch.
  it('keeps a leading segment that is not the epic, in both the branch and the path', () => {
    const result = createTaskWorktree(projectDir, 'epic-2', 'epic-1/task-1');

    expect(result.branch).toBe('smith/epic-2/epic-1/task-1');
    expect(result.worktreeDir).toBe(path.join(root, '.wt', 'project', 'epic-1', 'task-1'));

    // And the id it reports still addresses the directory it reported.
    const stale = listStale(projectDir, 'epic-2');
    expect(stale.map((s) => s.taskId)).toEqual(['epic-1/task-1']);
    removeTaskWorktree(projectDir, 'epic-2', 'epic-1/task-1');
    expect(existsSync(result.worktreeDir)).toBe(false);
  });
});
