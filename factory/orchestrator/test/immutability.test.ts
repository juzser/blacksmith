import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkWorktreeImmutable,
  fingerprintWorktree,
  ImmutabilityError,
} from '../src/immutability.js';
import { git as runGitFixture } from './helpers/process.js';

/** The SmithError code a throwing call raised, or undefined if it did not throw. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as ImmutabilityError).code;
  }
  return undefined;
}

describe('fingerprintWorktree / checkWorktreeImmutable', () => {
  let repoDir: string;

  function git(args: string[], cwd = repoDir) {
    return runGitFixture(cwd, args);
  }

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), 'smith-immutability-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await writeFile(path.join(repoDir, '.gitignore'), 'node_modules/\ndist/\n');
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(path.join(repoDir, 'src', 'parse.ts'), 'export const parse = () => 1;\n');
    await writeFile(path.join(repoDir, 'README.md'), '# repo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('reports no drift when the judge only read the worktree', () => {
    const before = fingerprintWorktree(repoDir);
    const result = checkWorktreeImmutable(repoDir, before);

    expect(result.unchanged).toBe(true);
    expect(result.drift).toEqual([]);
    expect(result.violation).toBeNull();
  });

  it('catches a file the judge created', async () => {
    const before = fingerprintWorktree(repoDir);
    await writeFile(path.join(repoDir, 'src', 'patch.ts'), 'export const patch = () => 2;\n');

    const result = checkWorktreeImmutable(repoDir, before);

    expect(result.unchanged).toBe(false);
    expect(result.drift).toEqual([
      {
        kind: 'dirtied',
        path: 'src/patch.ts',
        before: null,
        after: expect.stringMatching(/^\?\?/),
      },
    ]);
    expect(result.violation).toEqual({
      error: 'contract.judge-mutation',
      paths: ['src/patch.ts'],
    });
  });

  it('catches an edit to a tracked file that was clean when the judge started', async () => {
    const before = fingerprintWorktree(repoDir);
    await writeFile(path.join(repoDir, 'src', 'parse.ts'), 'export const parse = () => 999;\n');

    const result = checkWorktreeImmutable(repoDir, before);

    expect(result.violation?.paths).toEqual(['src/parse.ts']);
    expect(result.drift[0]).toMatchObject({ kind: 'dirtied', path: 'src/parse.ts', before: null });
  });

  // The case a status-only fingerprint cannot see, and the reason this guard
  // hashes content: the coder left src/parse.ts dirty, so the porcelain line
  // reads " M src/parse.ts" both before and after the judge edits it again.
  it('catches an edit to a file that was ALREADY dirty when the judge started', async () => {
    await writeFile(path.join(repoDir, 'src', 'parse.ts'), 'export const parse = () => 2;\n');
    const before = fingerprintWorktree(repoDir);
    const statusBefore = git(['status', '--porcelain=v1']);

    await writeFile(path.join(repoDir, 'src', 'parse.ts'), 'export const parse = () => 3;\n');
    const statusAfter = git(['status', '--porcelain=v1']);

    // Same porcelain output — a `git status` diff alone would call this clean.
    expect(statusAfter).toBe(statusBefore);

    const result = checkWorktreeImmutable(repoDir, before);
    expect(result.unchanged).toBe(false);
    expect(result.drift[0]?.kind).toBe('modified');
    expect(result.drift[0]?.path).toBe('src/parse.ts');
    expect(result.drift[0]?.before).not.toBe(result.drift[0]?.after);
  });

  it('catches a judge that staged a file it did not otherwise touch', async () => {
    await writeFile(path.join(repoDir, 'src', 'parse.ts'), 'export const parse = () => 2;\n');
    const before = fingerprintWorktree(repoDir);

    git(['add', 'src/parse.ts']);

    const result = checkWorktreeImmutable(repoDir, before);
    expect(result.unchanged).toBe(false);
    expect(result.drift[0]).toMatchObject({ kind: 'modified', path: 'src/parse.ts' });
  });

  it('catches a judge that committed its edit', async () => {
    const before = fingerprintWorktree(repoDir);
    await writeFile(path.join(repoDir, 'src', 'parse.ts'), 'export const parse = () => 4;\n');
    git(['commit', '-q', '-am', 'the judge fixed its own finding']);

    const result = checkWorktreeImmutable(repoDir, before);
    expect(result.unchanged).toBe(false);
    expect(result.drift.map((d) => d.kind)).toContain('head-moved');
    expect(result.violation?.paths).toContain('HEAD');
  });

  it('catches a judge that switched branches without moving HEAD', () => {
    const before = fingerprintWorktree(repoDir);
    git(['checkout', '-q', '-b', 'judge-side-branch']);

    const result = checkWorktreeImmutable(repoDir, before);
    expect(result.unchanged).toBe(false);
    expect(result.drift).toEqual([
      { kind: 'branch-switched', path: 'HEAD', before: 'main', after: 'judge-side-branch' },
    ]);
  });

  it('catches a file the judge deleted', async () => {
    const before = fingerprintWorktree(repoDir);
    await rm(path.join(repoDir, 'src', 'parse.ts'));

    const result = checkWorktreeImmutable(repoDir, before);
    expect(result.violation?.paths).toEqual(['src/parse.ts']);
    expect(result.drift[0]?.after).toContain('gone');
  });

  it('catches a judge that reverted a change the coder had left behind', async () => {
    await writeFile(path.join(repoDir, 'src', 'parse.ts'), 'export const parse = () => 2;\n');
    const before = fingerprintWorktree(repoDir);

    git(['checkout', '--', 'src/parse.ts']);

    const result = checkWorktreeImmutable(repoDir, before);
    expect(result.drift[0]).toMatchObject({ kind: 'reverted', path: 'src/parse.ts', after: null });
  });

  // Judges hold Bash to run the suite, and running it writes: node_modules/,
  // dist/, coverage caches. The guard is deliberately blind to anything the
  // project already ignores — no --ignored — or it would fire on every judge
  // that did its job.
  it('is blind to gitignored paths so a judge can run the test suite', async () => {
    const before = fingerprintWorktree(repoDir);
    await mkdir(path.join(repoDir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(repoDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    await mkdir(path.join(repoDir, 'dist'), { recursive: true });
    await writeFile(path.join(repoDir, 'dist', 'out.js'), 'console.log(1);\n');

    const result = checkWorktreeImmutable(repoDir, before);
    expect(result.unchanged).toBe(true);
  });

  // The blindness above is not an escape hatch: widening .gitignore is itself
  // a tracked-file edit, and ignore rules never apply to already-tracked files.
  it('cannot be evaded by widening .gitignore mid-run', async () => {
    const before = fingerprintWorktree(repoDir);
    await writeFile(path.join(repoDir, '.gitignore'), 'node_modules/\ndist/\nsrc/\n');
    await writeFile(path.join(repoDir, 'src', 'parse.ts'), 'export const parse = () => 5;\n');

    const result = checkWorktreeImmutable(repoDir, before);
    expect(result.violation?.paths).toEqual(['.gitignore', 'src/parse.ts']);
  });

  // The dispatcher takes the fingerprint, writes it to a file, runs the judge,
  // then reads it back — so the in-memory object and the round-tripped one
  // must be the same thing.
  it('compares against a fingerprint that round-tripped through JSON', async () => {
    const before = fingerprintWorktree(repoDir);
    const fingerprintPath = path.join(repoDir, '..', 'before.json');
    await writeFile(fingerprintPath, JSON.stringify(before));
    await writeFile(path.join(repoDir, 'src', 'parse.ts'), 'export const parse = () => 6;\n');

    const reloaded = JSON.parse(await readFile(fingerprintPath, 'utf8'));
    const result = checkWorktreeImmutable(repoDir, reloaded);

    expect(result.violation?.paths).toEqual(['src/parse.ts']);
    await rm(fingerprintPath, { force: true });
  });

  // The one hole, pinned as a test rather than left as a hope: a judge that
  // edits a file and restores the exact original bytes is invisible to any
  // before/after comparison. Documented in the operator guide.
  it('cannot see an edit the judge reverted byte-for-byte', async () => {
    const file = path.join(repoDir, 'src', 'parse.ts');
    const original = await readFile(file, 'utf8');
    const before = fingerprintWorktree(repoDir);

    await writeFile(file, 'export const parse = () => 7;\n');
    await writeFile(file, original);

    expect(checkWorktreeImmutable(repoDir, before).unchanged).toBe(true);
  });

  it('records head: null in a worktree with no commits yet', async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), 'smith-immutability-empty-'));
    git(['init', '-q', '-b', 'main'], emptyDir);

    const fingerprint = fingerprintWorktree(emptyDir);
    expect(fingerprint.head).toBeNull();
    expect(fingerprint.branch).toBe('main');

    await rm(emptyDir, { recursive: true, force: true });
  });

  it('throws immutability.not-a-git-worktree outside a repository', async () => {
    const plainDir = await mkdtemp(path.join(tmpdir(), 'smith-immutability-plain-'));
    try {
      expect(() => fingerprintWorktree(plainDir)).toThrow(ImmutabilityError);
      expect(codeOf(() => fingerprintWorktree(plainDir))).toBe('immutability.not-a-git-worktree');
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });

  // A missing or truncated before-file must fail loudly. Comparing against
  // `undefined` entries would report "unchanged" for a worktree the judge
  // rewrote from top to bottom.
  it('rejects a malformed before-fingerprint instead of reporting unchanged', () => {
    expect(() => checkWorktreeImmutable(repoDir, {} as never)).toThrow(ImmutabilityError);
    expect(codeOf(() => checkWorktreeImmutable(repoDir, {} as never))).toBe(
      'immutability.invalid-fingerprint',
    );
  });
});
