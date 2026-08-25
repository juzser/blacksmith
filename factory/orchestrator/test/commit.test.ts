import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { certifyCommit } from '../src/commit.js';

describe('certifyCommit', () => {
  let repoDir: string;

  function git(args: string[], cwd = repoDir) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), 'smith-commit-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await writeFile(path.join(repoDir, '.gitignore'), 'dist/\n');
    await writeFile(path.join(repoDir, 'README.md'), '# repo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('certifies a clean worktree whose branch is ahead of the base', async () => {
    git(['checkout', '-q', '-b', 'smith/epic-1/task-1']);
    await writeFile(path.join(repoDir, 'src.ts'), 'export const x = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'task work']);

    const cert = certifyCommit(repoDir, { baseRef: 'main' });

    expect(cert.certified).toBe(true);
    expect(cert.reason).toBeNull();
    expect(cert.dirty).toEqual([]);
    expect(cert.branch).toBe('smith/epic-1/task-1');
    expect(cert.head).toBe(git(['rev-parse', 'HEAD']));
    expect(cert.baseRef).toBe('main');
    expect(cert.commitsAhead).toBe(1);
  });

  it('certifies without a base when none is given, and says so rather than implying it checked', () => {
    const cert = certifyCommit(repoDir);

    expect(cert.certified).toBe(true);
    expect(cert.baseRef).toBeNull();
    expect(cert.baseSha).toBeNull();
    expect(cert.commitsAhead).toBeNull();
  });

  it('refuses a worktree that is not a git repo at all', async () => {
    const plainDir = await mkdtemp(path.join(tmpdir(), 'smith-commit-plain-'));
    try {
      const cert = certifyCommit(plainDir);

      expect(cert.certified).toBe(false);
      expect(cert.reason).toBe('not-a-git-worktree');
      expect(cert.head).toBeNull();
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });

  it('refuses uncommitted work and names every dirty path (D-30)', async () => {
    await writeFile(path.join(repoDir, 'README.md'), '# repo\nedited\n');
    await writeFile(path.join(repoDir, 'staged.ts'), 'export const s = 1;\n');
    git(['add', 'staged.ts']);
    await writeFile(path.join(repoDir, 'untracked.ts'), 'export const u = 1;\n');

    const cert = certifyCommit(repoDir, { baseRef: 'main' });

    expect(cert.certified).toBe(false);
    expect(cert.reason).toBe('uncommitted-work');
    expect(cert.dirty.sort()).toEqual(['README.md', 'staged.ts', 'untracked.ts']);
  });

  it('ignores gitignored paths, the same blind spot fingerprintWorktree takes on purpose', async () => {
    execFileSync('mkdir', ['-p', path.join(repoDir, 'dist')]);
    await writeFile(path.join(repoDir, 'dist', 'bundle.js'), 'build output\n');

    const cert = certifyCommit(repoDir);

    expect(cert.certified).toBe(true);
    expect(cert.dirty).toEqual([]);
  });

  it('survives a dirty path with a space in its name', async () => {
    await writeFile(path.join(repoDir, 'two words.ts'), 'export const t = 1;\n');

    const cert = certifyCommit(repoDir);

    expect(cert.reason).toBe('uncommitted-work');
    expect(cert.dirty).toEqual(['two words.ts']);
  });

  it('refuses an unborn branch — nothing has ever been committed', async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), 'smith-commit-unborn-'));
    try {
      git(['init', '-q', '-b', 'main'], emptyDir);

      const cert = certifyCommit(emptyDir);

      expect(cert.certified).toBe(false);
      expect(cert.reason).toBe('unborn-branch');
      expect(cert.head).toBeNull();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('refuses a branch head that still equals the base it was cut from (D-30)', () => {
    git(['checkout', '-q', '-b', 'smith/epic-1/task-3']);

    const cert = certifyCommit(repoDir, { baseRef: 'main' });

    expect(cert.certified).toBe(false);
    expect(cert.reason).toBe('branch-not-advanced');
    expect(cert.commitsAhead).toBe(0);
    expect(cert.baseSha).toBe(git(['rev-parse', 'main']));
  });

  it('refuses a base ref git cannot resolve instead of silently skipping the check', () => {
    const cert = certifyCommit(repoDir, { baseRef: 'smith/epic-1/integration' });

    expect(cert.certified).toBe(false);
    expect(cert.reason).toBe('unknown-base');
    expect(cert.baseRef).toBe('smith/epic-1/integration');
    expect(cert.baseSha).toBeNull();
  });

  it('reports uncommitted work first when the branch is also unadvanced — commit is the direct fix', async () => {
    git(['checkout', '-q', '-b', 'smith/epic-1/task-4']);
    await writeFile(path.join(repoDir, 'src.ts'), 'export const x = 1;\n');
    git(['add', '.']);

    const cert = certifyCommit(repoDir, { baseRef: 'main' });

    expect(cert.reason).toBe('uncommitted-work');
    expect(cert.dirty).toEqual(['src.ts']);
  });

  it('counts every commit ahead of the base, not just the newest', async () => {
    git(['checkout', '-q', '-b', 'smith/epic-1/task-5']);
    for (const n of [1, 2, 3]) {
      await writeFile(path.join(repoDir, `f${n}.ts`), `export const f${n} = ${n};\n`);
      git(['add', '.']);
      git(['commit', '-q', '-m', `work ${n}`]);
    }

    expect(certifyCommit(repoDir, { baseRef: 'main' }).commitsAhead).toBe(3);
  });

  // D-178: `claims.ts` and `immutability.ts` both read porcelain with
  // `--untracked-files=all`; this one did not. Untracked work is exactly the
  // shape a coder's first write takes, and it is the shape D-30 exists to
  // catch.
  it('names each file in a new untracked directory, not just the directory (D-178)', async () => {
    git(['checkout', '-q', '-b', 'smith/epic-1/task-1']);
    await writeFile(path.join(repoDir, 'committed.ts'), 'export const c = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'task work']);

    await mkdir(path.join(repoDir, 'src'));
    await writeFile(path.join(repoDir, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(repoDir, 'src', 'b.ts'), 'export const b = 1;\n');

    const cert = certifyCommit(repoDir, { baseRef: 'main' });

    expect(cert.certified).toBe(false);
    expect(cert.reason).toBe('uncommitted-work');
    expect(cert.dirty.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('sees untracked work through a status.showUntrackedFiles=no config (D-178)', async () => {
    git(['checkout', '-q', '-b', 'smith/epic-1/task-1']);
    await writeFile(path.join(repoDir, 'committed.ts'), 'export const c = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'task work']);

    git(['config', 'status.showUntrackedFiles', 'no']);
    await writeFile(path.join(repoDir, 'forgotten.ts'), 'export const f = 1;\n');

    const cert = certifyCommit(repoDir, { baseRef: 'main' });

    expect(cert.certified).toBe(false);
    expect(cert.reason).toBe('uncommitted-work');
    expect(cert.dirty).toEqual(['forgotten.ts']);
  });
});
