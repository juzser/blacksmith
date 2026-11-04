import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** No contributor's global or system git config may change an outcome. */
function hermetic(dir: string): string {
  const globalConfig = path.join(dir, 'global.gitconfig');
  writeFileSync(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  return globalConfig;
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
    hermetic(root);
    projectDir = path.join(root, 'project');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
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

  it('stands on main with main and master both present: main', async () => {
    await initRepo('main');
    git(projectDir, ['branch', 'master']);
    expect(detectDefaultBranch(projectDir)).toBe('main');
  });

  it('stands on master with both present: master', async () => {
    await initRepo('master');
    git(projectDir, ['branch', 'main']);
    expect(detectDefaultBranch(projectDir)).toBe('master');
  });

  it('breaks the both-exist tie with init.defaultBranch', async () => {
    await initRepo('main');
    git(projectDir, ['branch', 'master']);
    git(projectDir, ['config', 'init.defaultBranch', 'master']);
    git(projectDir, ['checkout', '-q', '-b', 'bs/x/integration']);
    expect(detectDefaultBranch(projectDir)).toBe('master');
  });

  it('breaks the tie from a global init.defaultBranch too, and only then', async () => {
    const globalConfig = hermetic(root);
    await initRepo('master');
    writeFileSync(globalConfig, '[init]\n\tdefaultBranch = main\n');
    git(projectDir, ['checkout', '-q', '-b', 'bs/x/integration']);
    // one of main/master: the global setting is not consulted
    expect(detectDefaultBranch(projectDir)).toBe('master');
    git(projectDir, ['branch', 'main']);
    expect(detectDefaultBranch(projectDir)).toBe('main');
  });

  it('ignores an init.defaultBranch naming a branch that does not exist', async () => {
    await initRepo('master');
    git(projectDir, ['config', 'init.defaultBranch', 'trunk']);
    git(projectDir, ['checkout', '-q', '-b', 'bs/x/integration']);
    expect(detectDefaultBranch(projectDir)).toBe('master');
  });

  it('ignores an init.defaultBranch naming a non-conventional existing branch', async () => {
    await initRepo('master');
    git(projectDir, ['branch', 'main']);
    git(projectDir, ['branch', 'trunk']);
    git(projectDir, ['config', 'init.defaultBranch', 'trunk']);
    git(projectDir, ['checkout', '-q', '-b', 'bs/x/integration']);
    expect(codeOf(() => detectDefaultBranch(projectDir))).toBe('worktree.default-branch-ambiguous');
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
    hermetic(root);
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
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
