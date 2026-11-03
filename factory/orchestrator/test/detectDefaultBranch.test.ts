import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectDefaultBranch, type WorktreeError } from '../src/worktree.js';
import { git } from './helpers/process.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as WorktreeError).code;
  }
  return undefined;
}

describe('detectDefaultBranch on a project without a remote', () => {
  let root: string;
  let projectDir: string;

  /** A repo whose first commit lands on `first`; no remote. */
  async function initRepo(first: string): Promise<void> {
    git(root, ['init', '-q', '-b', first, projectDir]);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    await writeFile(path.join(projectDir, 'README.md'), '# p\n');
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-q', '-m', 'init']);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-defbranch-'));
    projectDir = path.join(root, 'project');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(['master', 'main'])(
    'never returns a checked-out bs/ branch (default %s)',
    async (name) => {
      await initRepo(name);
      git(projectDir, ['checkout', '-q', '-b', 'bs/x/integration']);
      expect(detectDefaultBranch(projectDir)).toBe(name);
    },
  );

  it('never returns a checked-out legacy smith/ branch either', async () => {
    await initRepo('master');
    git(projectDir, ['checkout', '-q', '-b', 'smith/x/integration']);
    expect(detectDefaultBranch(projectDir)).toBe('master');
  });

  it('prefers init.defaultBranch when that branch exists', async () => {
    await initRepo('main');
    git(projectDir, ['branch', 'master']);
    git(projectDir, ['config', 'init.defaultBranch', 'master']);
    git(projectDir, ['checkout', '-q', '-b', 'bs/x/integration']);
    expect(detectDefaultBranch(projectDir)).toBe('master');
  });

  it('refuses with a coded error when main and master both exist and nothing says which', async () => {
    await initRepo('main');
    git(projectDir, ['branch', 'master']);
    git(projectDir, ['checkout', '-q', '-b', 'bs/x/integration']);
    expect(codeOf(() => detectDefaultBranch(projectDir))).toBe('worktree.default-branch-ambiguous');
  });

  it('refuses when only a bs/ branch exists', async () => {
    await initRepo('bs/x/integration');
    expect(codeOf(() => detectDefaultBranch(projectDir))).toBe('worktree.default-branch-not-found');
  });

  it('still falls back to a checked-out non-bs branch', async () => {
    await initRepo('trunk');
    expect(detectDefaultBranch(projectDir)).toBe('trunk');
  });
});

describe('detectDefaultBranch with a remote', () => {
  it('keeps origin/HEAD ahead of everything else', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'smith-defbranch-r-'));
    try {
      const originDir = path.join(root, 'origin.git');
      const projectDir = path.join(root, 'project');
      git(root, ['init', '-q', '--bare', '-b', 'trunk', originDir]);
      git(root, ['clone', '-q', originDir, projectDir]);
      git(projectDir, ['config', 'user.email', 't@example.com']);
      git(projectDir, ['config', 'user.name', 'T']);
      git(projectDir, ['checkout', '-q', '-b', 'trunk']);
      await writeFile(path.join(projectDir, 'f'), 'x\n');
      git(projectDir, ['add', '.']);
      git(projectDir, ['commit', '-q', '-m', 'init']);
      git(projectDir, ['push', '-q', 'origin', 'trunk']);
      git(projectDir, ['remote', 'set-head', 'origin', 'trunk']);
      git(projectDir, ['branch', 'main']);
      git(projectDir, ['checkout', '-q', '-b', 'bs/x/integration']);
      expect(detectDefaultBranch(projectDir)).toBe('trunk');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
