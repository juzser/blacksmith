import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CleanupItem, type CleanupOptions, planCleanup, runCleanup } from '../src/cleanup.js';
import type { StoredEvent } from '../src/events.js';
import { pidIsAlive } from '../src/heavyLock.js';
import { createTaskWorktree } from '../src/worktree.js';
import { git } from './helpers/process.js';

// Every test builds its repos under its own temp dir and injects platform,
// trash, isPidAlive and now: nothing here touches the real .wt folder, the real
// Trash or a real process.

const HOUR = 3_600_000;

function closedEvent(epicId: string): StoredEvent {
  return {
    event_id: `s:${epicId}`,
    record: {
      ts: '2026-01-01T00:00:00.000Z',
      session_id: 's',
      actor: 'orchestrator',
      event_type: 'epic-closed',
      plan_version: 1,
      causal_parent: null,
      payload: { epic_id: epicId },
    },
  } as unknown as StoredEvent;
}

function taskEvent(taskId: string): StoredEvent {
  return {
    event_id: `s:${taskId}`,
    record: {
      ts: '2026-01-01T00:00:00.000Z',
      session_id: 's',
      actor: 'orchestrator',
      event_type: 'task-added',
      task_id: taskId,
      plan_version: 1,
      causal_parent: null,
      payload: {},
    },
  } as unknown as StoredEvent;
}

type Git = NonNullable<CleanupOptions['git']>;
type Lstat = NonNullable<CleanupOptions['lstat']>;
type Readdir = NonNullable<CleanupOptions['readdir']>;

const realGit: Git = (cwd, args) => git(cwd, args).trim();
const realLstat: Lstat = (p) => {
  const s = lstatSync(p);
  return { mtimeMs: s.mtimeMs, isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink() };
};
const errno = (code: string) => Object.assign(new Error(code), { code });

describe('cleanup.ts', () => {
  let root: string;
  let projectDir: string;
  let wtRoot: string;
  let trashed: string[];
  let idleNow: number;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(path.join(tmpdir(), 'bs-cleanup-')));
    const originDir = path.join(root, 'origin.git');
    projectDir = path.join(root, 'project');
    wtRoot = path.join(root, '.wt', 'project');
    git(root, ['init', '-q', '--bare', '-b', 'main', originDir]);
    git(root, ['clone', '-q', originDir, projectDir]);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    await writeFile(path.join(projectDir, 'README.md'), '# project\n');
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-q', '-m', 'init']);
    git(projectDir, ['push', '-q', 'origin', 'main']);
    git(projectDir, ['remote', 'set-head', 'origin', 'main']);
    trashed = [];
    // Everything on disk was written "now"; this clock is two days later.
    idleNow = Date.now() + 48 * HOUR;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function opts(over: Partial<CleanupOptions> = {}): CleanupOptions {
    return {
      projectDir,
      now: idleNow,
      events: [closedEvent('e1')],
      platform: 'darwin',
      trash: (p) => {
        trashed.push(p);
      },
      isPidAlive: () => false,
      heavyLockDir: path.join(root, 'locks'),
      ...over,
    };
  }

  /** A task worktree with one commit, merged into main (fast-forward). */
  function mergedTask(task: string, epic = 'e1'): string {
    const wt = createTaskWorktree(projectDir, epic, task).worktreeDir;
    commitIn(wt, `${task}.txt`);
    git(projectDir, ['merge', '-q', '--ff-only', `bs/${epic}/${task}`]);
    return wt;
  }

  function commitIn(wt: string, file: string): void {
    git(wt, ['config', 'user.email', 'test@example.com']);
    git(wt, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(wt, file), `${file}\n`);
    git(wt, ['add', file]);
    git(wt, ['commit', '-q', '-m', file]);
  }

  const item = (items: CleanupItem[], branch: string) => items.find((i) => i.branch === branch);
  const branchExists = (b: string) => git(projectDir, ['branch', '--list', b]).trim().length > 0;
  const planOf = async (over: Partial<CleanupOptions> = {}) =>
    (await planCleanup(opts(over))).items;

  async function lockFile(lockDir: string, cwd: string): Promise<void> {
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, 'heavy.lock'),
      JSON.stringify({ pid: 4242, token: 't', label: 'l', startedAt: 'x', cwd }),
    );
  }

  it('plans a merged, idle task worktree for removal with its branch', async () => {
    const wt = mergedTask('t1');
    const items = await planOf();
    expect(item(items, 'bs/e1/t1')).toMatchObject({
      kind: 'worktree',
      path: realpathSync(wt),
      action: 'remove',
    });
    for (const i of items) expect(i.reason.length).toBeGreaterThan(0);
  });

  describe('24 h activity', () => {
    it('keeps a task whose last commit is recent', async () => {
      mergedTask('t1');
      const git2: Git = (cwd, args) =>
        args[0] === 'log' ? String(Math.floor(idleNow / 1000) - HOUR / 1000) : realGit(cwd, args);
      const i = item(await planOf({ git: git2 }), 'bs/e1/t1');
      expect(i).toMatchObject({ action: 'keep' });
      expect(i?.reason).toMatch(/^active-24h/);
    });

    it('keeps a task whose worktree index is recent', async () => {
      mergedTask('t1');
      const lstat: Lstat = (p) =>
        path.basename(p) === 'index'
          ? { mtimeMs: idleNow - HOUR, isDirectory: false, isSymbolicLink: false }
          : realLstat(p);
      const i = item(await planOf({ lstat }), 'bs/e1/t1');
      expect(i?.reason).toMatch(/^active-24h/);
    });

    it('keeps a task with a recently modified file in the tree', async () => {
      mergedTask('t1');
      const lstat: Lstat = (p) =>
        path.basename(p) === 'README.md' && p.includes('.wt')
          ? { mtimeMs: idleNow - HOUR, isDirectory: false, isSymbolicLink: false }
          : realLstat(p);
      const i = item(await planOf({ lstat }), 'bs/e1/t1');
      expect(i?.reason).toMatch(/^active-24h/);
    });

    it('stops walking at the first recent entry', async () => {
      const wt = realpathSync(mergedTask('t1'));
      mkdirSync(path.join(wt, 'sub-a'));
      mkdirSync(path.join(wt, 'sub-b'));
      const calls: string[] = [];
      const readdir: Readdir = (p) => {
        if (p.startsWith(wt)) calls.push(p);
        return readdirSync(p);
      };
      const lstat: Lstat = (p) =>
        p.startsWith(wt) && p !== wt
          ? { mtimeMs: idleNow - HOUR, isDirectory: true, isSymbolicLink: false }
          : realLstat(p);
      await planOf({ readdir, lstat });
      expect(calls).toEqual([wt]);
    });

    it('keeps a tree past the 20,000 entry cap as walk-capped', async () => {
      const wt = realpathSync(mergedTask('t1'));
      const readdir: Readdir = (p) =>
        p === wt ? Array.from({ length: 20_001 }, (_, n) => `gen-${n}`) : readdirSync(p);
      const lstat: Lstat = (p) =>
        path.basename(p).startsWith('gen-')
          ? { mtimeMs: 0, isDirectory: false, isSymbolicLink: false }
          : realLstat(p);
      const i = item(await planOf({ readdir, lstat }), 'bs/e1/t1');
      expect(i).toMatchObject({ action: 'keep' });
      expect(i?.reason).toMatch(/^walk-capped/);
    });

    it('keeps a tree with an unreadable subdirectory as unreadable, naming the path', async () => {
      const wt = createTaskWorktree(projectDir, 'e1', 't1').worktreeDir;
      mkdirSync(path.join(wt, 'sub'));
      commitIn(wt, 'sub/x.txt');
      git(projectDir, ['merge', '-q', '--ff-only', 'bs/e1/t1']);
      const readdir: Readdir = (p) => {
        if (path.basename(p) === 'sub') throw errno('EACCES');
        return readdirSync(p);
      };
      const i = item(await planOf({ readdir }), 'bs/e1/t1');
      expect(i).toMatchObject({ action: 'keep' });
      expect(i?.reason).toMatch(/^unreadable/);
      expect(i?.reason).toContain(path.join(realpathSync(wt), 'sub'));
    });
  });

  describe('epic state', () => {
    it('keeps every task of an open epic', async () => {
      mergedTask('t1', 'e2');
      const i = item(await planOf({ events: [taskEvent('e2/t1')] }), 'bs/e2/t1');
      expect(i).toMatchObject({ action: 'keep' });
      expect(i?.reason).toMatch(/^open-epic/);
    });

    it('keeps an epic with no events unless its integration branch is landed', async () => {
      mergedTask('t1', 'e3');
      const intWt = path.join(wtRoot, 'e3-integration');
      git(projectDir, ['worktree', 'add', '-q', intWt, 'bs/e3/integration']);
      commitIn(intWt, 'int.txt');
      git(projectDir, ['worktree', 'remove', intWt]);
      const kept = item(await planOf({ events: [] }), 'bs/e3/t1');
      expect(kept?.reason).toMatch(/^epic-unrecorded/);

      git(projectDir, [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=T',
        'merge',
        '-q',
        '--no-edit',
        'bs/e3/integration',
      ]);
      const ok = item(await planOf({ events: [] }), 'bs/e3/t1');
      expect(ok?.action).toBe('remove');
    });

    it('keeps an integration worktree until its branch is an ancestor of the default branch', async () => {
      createTaskWorktree(projectDir, 'e1', 't1');
      const intWt = path.join(wtRoot, 'integration');
      git(projectDir, ['worktree', 'add', '-q', intWt, 'bs/e1/integration']);
      commitIn(intWt, 'int.txt');

      const kept = item(await planOf(), 'bs/e1/integration');
      expect(kept).toMatchObject({ action: 'keep' });
      expect(kept?.reason).toMatch(/^not-merged/);

      git(projectDir, ['merge', '-q', '--ff-only', 'bs/e1/integration']);
      expect(item(await planOf(), 'bs/e1/integration')?.action).toBe('remove');
    });

    it('limits worktree targets to --epic but still plans orphans project-wide', async () => {
      mergedTask('t1', 'e1');
      mergedTask('t9', 'e9');
      mkdirSync(path.join(wtRoot, 'orphan'));
      const items = await planOf({ epicId: 'e9', events: [closedEvent('e1'), closedEvent('e9')] });
      expect(item(items, 'bs/e1/t1')).toBeUndefined();
      expect(item(items, 'bs/e9/t9')?.action).toBe('remove');
      expect(items.find((i) => i.kind === 'directory')?.action).toBe('trash');
    });
  });

  describe('worktree state', () => {
    it('keeps and reports a dirty worktree', async () => {
      const wt = mergedTask('t1');
      await writeFile(path.join(wt, 'scratch.txt'), 'x');
      const i = item(await planOf(), 'bs/e1/t1');
      expect(i).toMatchObject({ action: 'keep' });
      expect(i?.reason).toMatch(/^dirty/);
    });

    it('keeps anything named harness-codex-dispatch', async () => {
      mergedTask('harness-codex-dispatch-1');
      const i = item(await planOf(), 'bs/e1/harness-codex-dispatch-1');
      expect(i?.reason).toMatch(/^harness-codex-dispatch/);
    });

    it('keeps an unmerged task branch', async () => {
      const wt = createTaskWorktree(projectDir, 'e1', 't1').worktreeDir;
      commitIn(wt, 'work.txt');
      const i = item(await planOf(), 'bs/e1/t1');
      expect(i?.reason).toMatch(/^not-merged/);
    });

    it('keeps an unmerged branch even when the main clone is on a non-default branch that contains it', async () => {
      const wt = createTaskWorktree(projectDir, 'e1', 't1').worktreeDir;
      commitIn(wt, 'work.txt');
      git(projectDir, ['checkout', '-q', '-b', 'feature']);
      git(projectDir, ['merge', '-q', '--ff-only', 'bs/e1/t1']);
      // `git branch -d` alone would accept this: the branch is merged into HEAD.
      const report = await runCleanup(opts({ apply: true }));
      expect(item(report.items, 'bs/e1/t1')?.reason).toMatch(/^not-merged/);
      expect(existsSync(wt)).toBe(true);
      expect(branchExists('bs/e1/t1')).toBe(true);
    });

    it('keeps a worktree whose branch was deleted', async () => {
      mergedTask('t1');
      git(projectDir, ['update-ref', '-d', 'refs/heads/bs/e1/t1']);
      const items = await planOf();
      const i = items.find((x) => x.kind === 'worktree');
      expect(i).toMatchObject({ action: 'keep' });
      expect(i?.reason).toMatch(/^branch-missing/);
    });

    it('plans a merged branch that has no worktree', async () => {
      git(projectDir, ['branch', 'bs/e1/solo', 'main']);
      expect(item(await planOf(), 'bs/e1/solo')).toMatchObject({
        kind: 'branch',
        action: 'remove',
      });
      await runCleanup(opts({ apply: true }));
      expect(branchExists('bs/e1/solo')).toBe(false);
    });

    it('never touches a branch outside the bs/ and smith/ prefixes', async () => {
      git(projectDir, ['branch', 'feature/old', 'main']);
      await runCleanup(opts({ apply: true }));
      expect(branchExists('feature/old')).toBe(true);
    });

    it('keeps a git-locked worktree', async () => {
      const wt = mergedTask('t1');
      git(projectDir, ['worktree', 'lock', '--reason', 'pid 1', wt]);
      const i = item(await planOf(), 'bs/e1/t1');
      expect(i?.reason).toMatch(/^git-locked/);
    });

    it('keeps a worktree with a git index.lock', async () => {
      const wt = mergedTask('t1');
      const gitDir = git(wt, ['rev-parse', '--absolute-git-dir']).trim();
      await writeFile(path.join(gitDir, 'index.lock'), '');
      const i = item(await planOf(), 'bs/e1/t1');
      expect(i?.reason).toMatch(/^index-lock/);
    });

    it('only prunes a prunable worktree and never removes it', async () => {
      const wt = mergedTask('t1');
      await rm(wt, { recursive: true, force: true });
      const removed: string[][] = [];
      const git2: Git = (cwd, args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') removed.push(args);
        return realGit(cwd, args);
      };
      const items = await planOf({ git: git2 });
      expect(items.find((i) => i.kind === 'prune')).toMatchObject({ action: 'prune' });
      expect(item(items, 'bs/e1/t1')).toBeUndefined();

      await runCleanup(opts({ apply: true, git: git2 }));
      expect(removed).toEqual([]);
      expect(git(projectDir, ['worktree', 'list', '--porcelain'])).not.toContain('t1');
    });
  });

  describe('heavy lock', () => {
    it('keeps an item when a live process holds a lock whose cwd is inside it', async () => {
      const wt = mergedTask('t1');
      await lockFile(path.join(root, 'locks'), path.join(realpathSync(wt), 'deep'));
      const i = item(await planOf({ isPidAlive: () => true }), 'bs/e1/t1');
      expect(i?.reason).toMatch(/^heavy-lock/);
    });

    it('ignores a lock whose recorded pid is dead', async () => {
      const wt = mergedTask('t1');
      await lockFile(path.join(root, 'locks'), realpathSync(wt));
      expect(item(await planOf({ isPidAlive: () => false }), 'bs/e1/t1')?.action).toBe('remove');
    });

    it('treats an EPERM probe as a live holder', async () => {
      const wt = mergedTask('t1');
      await lockFile(path.join(root, 'locks'), realpathSync(wt));
      const kill = (() => {
        throw errno('EPERM');
      }) as unknown as typeof process.kill;
      const i = item(await planOf({ isPidAlive: (pid) => pidIsAlive(pid, kill) }), 'bs/e1/t1');
      expect(i?.reason).toMatch(/^heavy-lock/);
    });

    it('keeps everything it cannot attribute when the lock file is unparseable', async () => {
      mergedTask('t1');
      await mkdir(path.join(root, 'locks'), { recursive: true });
      await writeFile(path.join(root, 'locks', 'heavy.lock'), '{nope');
      expect((await planOf()).find((i) => i.branch === 'bs/e1/t1')?.reason).toMatch(/^heavy-lock/);
    });

    it('ignores a lock held elsewhere', async () => {
      mergedTask('t1');
      await lockFile(path.join(root, 'locks'), path.join(root, 'elsewhere'));
      expect(item(await planOf({ isPidAlive: () => true }), 'bs/e1/t1')?.action).toBe('remove');
    });
  });

  describe('apply', () => {
    it('changes nothing on a dry run', async () => {
      const wt = mergedTask('t1');
      mkdirSync(path.join(wtRoot, 'orphan'));
      const before = git(projectDir, ['worktree', 'list', '--porcelain']);
      await runCleanup(opts());
      expect(git(projectDir, ['worktree', 'list', '--porcelain'])).toBe(before);
      expect(existsSync(wt)).toBe(true);
      expect(branchExists('bs/e1/t1')).toBe(true);
      expect(trashed).toEqual([]);
    });

    it('removes the worktree, then its branch, and trashes orphans', async () => {
      const wt = mergedTask('t1');
      mkdirSync(path.join(wtRoot, 'orphan'));
      const report = await runCleanup(opts({ apply: true }));
      expect(existsSync(wt)).toBe(false);
      expect(branchExists('bs/e1/t1')).toBe(false);
      expect(trashed).toEqual([path.join(wtRoot, 'orphan')]);
      expect(item(report.items, 'bs/e1/t1')?.action).toBe('remove');
    });

    it('rebuilds the list in the same run instead of reusing an earlier plan', async () => {
      const wt = mergedTask('t1');
      expect(item(await planOf(), 'bs/e1/t1')?.action).toBe('remove');
      await writeFile(path.join(wt, 'late.txt'), 'x');
      const report = await runCleanup(opts({ apply: true }));
      expect(item(report.items, 'bs/e1/t1')?.reason).toMatch(/^dirty/);
      expect(existsSync(wt)).toBe(true);
    });

    it('keeps the item when an edit lands after the gate, and does not delete the branch', async () => {
      const wt = mergedTask('t1');
      const git2: Git = (cwd, args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') {
          writeFileSync(path.join(wt, 'README.md'), 'edited\n');
        }
        return realGit(cwd, args);
      };
      const report = await runCleanup(opts({ apply: true, git: git2 }));
      const i = item(report.items, 'bs/e1/t1');
      expect(i).toMatchObject({ action: 'keep' });
      expect(i?.reason).toMatch(/modified or untracked/);
      expect(existsSync(wt)).toBe(true);
      expect(branchExists('bs/e1/t1')).toBe(true);
    });

    it('keeps the branch when a commit lands after the first gate', async () => {
      const wt = mergedTask('t1');
      const git2: Git = (cwd, args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') commitIn(wt, 'late.txt');
        return realGit(cwd, args);
      };
      const report = await runCleanup(opts({ apply: true, git: git2 }));
      expect(item(report.items, 'bs/e1/t1')).toMatchObject({ action: 'keep' });
      expect(item(report.items, 'bs/e1/t1')?.reason).toMatch(/^not-merged/);
      expect(branchExists('bs/e1/t1')).toBe(true);
    });

    it('reports a branch deletion that git refuses as keep with git message', async () => {
      mergedTask('t1');
      const git2: Git = (cwd, args) => {
        if (args[0] === 'branch' && args[1] === '-d') throw new Error('refused by git');
        return realGit(cwd, args);
      };
      const report = await runCleanup(opts({ apply: true, git: git2 }));
      expect(item(report.items, 'bs/e1/t1')).toMatchObject({ action: 'keep' });
      expect(item(report.items, 'bs/e1/t1')?.reason).toContain('refused by git');
    });

    it('never uses force or -D', async () => {
      mergedTask('t1');
      git(projectDir, ['branch', 'bs/e1/solo', 'main']);
      const seen: string[][] = [];
      const git2: Git = (cwd, args) => {
        seen.push(args);
        return realGit(cwd, args);
      };
      await runCleanup(opts({ apply: true, git: git2 }));
      for (const args of seen) {
        expect(args).not.toContain('--force');
        expect(args).not.toContain('-D');
        expect(args).not.toContain('-f');
      }
    });
  });

  describe('directories under .wt/<project>', () => {
    it('trashes an orphan directory on macOS and reports manual elsewhere', async () => {
      mkdirSync(path.join(wtRoot, 'orphan'), { recursive: true });
      expect((await planOf()).find((i) => i.kind === 'directory')?.action).toBe('trash');
      const linux = await runCleanup(opts({ apply: true, platform: 'linux' }));
      expect(linux.items.find((i) => i.kind === 'directory')?.action).toBe('manual');
      expect(trashed).toEqual([]);
      expect(existsSync(path.join(wtRoot, 'orphan'))).toBe(true);
    });

    it('keeps a directory that holds its own .git directory', async () => {
      mkdirSync(path.join(wtRoot, 'other', '.git'), { recursive: true });
      const i = (await planOf()).find((x) => x.kind === 'directory');
      expect(i?.reason).toMatch(/^independent-repo/);
    });

    it('keeps a directory whose .git file points at some other repository', async () => {
      mkdirSync(path.join(wtRoot, 'foreign'), { recursive: true });
      await writeFile(path.join(wtRoot, 'foreign', '.git'), 'gitdir: /elsewhere/.git/worktrees/x');
      const i = (await planOf()).find((x) => x.kind === 'directory');
      expect(i?.reason).toMatch(/^foreign-git/);
    });

    it('keeps a recently modified orphan', async () => {
      mkdirSync(path.join(wtRoot, 'orphan'), { recursive: true });
      const i = (await planOf({ now: Date.now() })).find((x) => x.kind === 'directory');
      expect(i?.reason).toMatch(/^active-24h/);
    });

    it('keeps an orphan named harness-codex-dispatch', async () => {
      mkdirSync(path.join(wtRoot, 'harness-codex-dispatch-3'), { recursive: true });
      const i = (await planOf()).find((x) => x.kind === 'directory');
      expect(i?.reason).toMatch(/^harness-codex-dispatch/);
    });

    it('touches nothing outside .wt/<project>/', async () => {
      mkdirSync(path.join(root, '.wt', 'other-project', 'x'), { recursive: true });
      mkdirSync(path.join(wtRoot, 'orphan'), { recursive: true });
      const outside = createTaskWorktree(projectDir, 'e1', 't1').worktreeDir;
      commitIn(outside, 'w.txt');
      git(projectDir, ['merge', '-q', '--ff-only', 'bs/e1/t1']);
      const moved = path.join(root, 'elsewhere');
      git(projectDir, ['worktree', 'move', outside, moved]);

      const report = await runCleanup(opts({ apply: true }));
      expect(item(report.items, 'bs/e1/t1')?.reason).toMatch(/^outside-root/);
      expect(existsSync(moved)).toBe(true);
      expect(existsSync(path.join(root, '.wt', 'other-project', 'x'))).toBe(true);
      expect(trashed).toEqual([path.join(wtRoot, 'orphan')]);
    });

    it('resolves a symlinked .wt/<project> root and keeps a symlink entry without following it', async () => {
      const store = path.join(root, 'store');
      const outsideTarget = path.join(root, 'outside-target');
      mkdirSync(path.join(store, 'orphan'), { recursive: true });
      mkdirSync(outsideTarget);
      symlinkSync(outsideTarget, path.join(store, 'link'));
      mkdirSync(path.join(root, '.wt'), { recursive: true });
      symlinkSync(store, wtRoot);

      const report = await runCleanup(opts({ apply: true }));
      const dirs = report.items.filter((i) => i.kind === 'directory');
      expect(dirs.find((d) => d.path === path.join(wtRoot, 'orphan'))?.action).toBe('trash');
      const link = dirs.find((d) => d.path === path.join(wtRoot, 'link'));
      expect(link).toMatchObject({ action: 'keep' });
      expect(link?.reason).toMatch(/^symlink/);
      expect(trashed).toEqual([path.join(wtRoot, 'orphan')]);
      expect(existsSync(outsideTarget)).toBe(true);
    });
  });

  describe('merge targets and failures', () => {
    it('plans a legacy smith/ task worktree whose branch is merged', async () => {
      const wt = path.join(wtRoot, 'e9-t1');
      git(projectDir, ['worktree', 'add', '-q', '-b', 'smith/e9/t1', wt, 'main']);
      commitIn(wt, 'legacy.txt');
      git(projectDir, ['merge', '-q', '--ff-only', 'smith/e9/t1']);
      const i = item(await planOf({ events: [closedEvent('e9')] }), 'smith/e9/t1');
      expect(i).toMatchObject({ kind: 'worktree', action: 'remove' });
      await runCleanup(opts({ apply: true, events: [closedEvent('e9')] }));
      expect(existsSync(wt)).toBe(false);
      expect(branchExists('smith/e9/t1')).toBe(false);
    });

    it('counts a branch landed only in origin/<default> as merged', async () => {
      const wt = createTaskWorktree(projectDir, 'e1', 't1').worktreeDir;
      commitIn(wt, 'remote.txt');
      git(projectDir, ['push', '-q', 'origin', 'bs/e1/t1:main']);
      git(projectDir, ['fetch', '-q', 'origin']);
      expect(git(projectDir, ['branch', '--list', 'main', '--contains', 'bs/e1/t1']).trim()).toBe(
        '',
      );
      const i = item(await planOf(), 'bs/e1/t1');
      expect(i?.action).toBe('remove');
      expect(i?.reason).toContain('origin/main');
    });

    it('counts a task merged only into its integration branch as merged', async () => {
      const wt = createTaskWorktree(projectDir, 'e1', 't1').worktreeDir;
      commitIn(wt, 'int-only.txt');
      git(projectDir, ['update-ref', 'refs/heads/bs/e1/integration', 'refs/heads/bs/e1/t1']);
      const i = item(await planOf(), 'bs/e1/t1');
      expect(i?.action).toBe('remove');
      expect(i?.reason).toContain('bs/e1/integration');
      const integration = item(await planOf(), 'bs/e1/integration');
      expect(integration?.action).toBe('keep');
      expect(integration?.reason).toMatch(/^not-merged/);
    });

    it('reports a failing trash call as keep and leaves the directory in place', async () => {
      const orphan = path.join(wtRoot, 'orphan');
      mkdirSync(orphan, { recursive: true });
      const report = await runCleanup(
        opts({
          apply: true,
          trash: () => {
            throw new Error('trash exploded');
          },
        }),
      );
      const d = report.items.find((i) => i.kind === 'directory');
      expect(d?.action).toBe('keep');
      expect(d?.reason).toMatch(/^trash-failed/);
      expect(d?.reason).toContain('trash exploded');
      expect(existsSync(orphan)).toBe(true);
    });
  });

  describe('default branch resolution', () => {
    /** An unmerged task whose commit is contained only by the checked-out `feature`. */
    function unmergedOnFeature(): string {
      const wt = createTaskWorktree(projectDir, 'e1', 't1').worktreeDir;
      commitIn(wt, 'wip.txt');
      git(projectDir, ['checkout', '-q', '-b', 'feature']);
      git(projectDir, ['merge', '-q', '--no-ff', '-m', 'wip', 'bs/e1/t1']);
      return wt;
    }

    it('keeps the task when there is no remote and the clone sits on a branch containing it', async () => {
      const wt = unmergedOnFeature();
      git(projectDir, ['remote', 'remove', 'origin']);
      const report = await runCleanup(opts({ apply: true }));
      expect(item(report.items, 'bs/e1/t1')?.action).toBe('keep');
      expect(existsSync(wt)).toBe(true);
      expect(branchExists('bs/e1/t1')).toBe(true);
    });

    it('keeps the task when the remote has no symbolic default ref', async () => {
      const wt = unmergedOnFeature();
      git(projectDir, ['remote', 'set-head', 'origin', '-d']);
      const report = await runCleanup(opts({ apply: true }));
      expect(item(report.items, 'bs/e1/t1')?.action).toBe('keep');
      expect(existsSync(wt)).toBe(true);
      expect(branchExists('bs/e1/t1')).toBe(true);
    });

    it('keeps every merge-dependent item as no-default-branch when no default exists', async () => {
      const wt = unmergedOnFeature();
      git(projectDir, ['remote', 'remove', 'origin']);
      git(projectDir, ['branch', '-m', 'main', 'trunk']);
      git(projectDir, ['branch', 'bs/e1/loose', 'feature']);
      const report = await runCleanup(opts({ apply: true }));
      for (const b of ['bs/e1/t1', 'bs/e1/loose']) {
        expect(item(report.items, b)?.action).toBe('keep');
        expect(item(report.items, b)?.reason).toMatch(/^no-default-branch/);
        expect(branchExists(b)).toBe(true);
      }
      expect(existsSync(wt)).toBe(true);
    });

    it('still removes a really merged task when origin/HEAD names the default', async () => {
      const wt = mergedTask('t1');
      git(projectDir, ['checkout', '-q', '-b', 'feature']);
      await runCleanup(opts({ apply: true }));
      expect(existsSync(wt)).toBe(false);
      expect(branchExists('bs/e1/t1')).toBe(false);
    });
  });

  describe('edges', () => {
    it('reports nothing for a project with no .wt folder and no task branches', async () => {
      expect(await planOf()).toEqual([]);
    });

    it('raises cleanup.not-a-git-repo for a directory that is not a repository', async () => {
      const plain = path.join(root, 'plain');
      mkdirSync(plain);
      await expect(planCleanup(opts({ projectDir: plain }))).rejects.toMatchObject({
        code: 'cleanup.not-a-git-repo',
      });
    });
  });
});
