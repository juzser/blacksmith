import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiffstatError, isExcludedDiffPath, measureDiff, parseNumstat } from '../src/diffstat.js';

/** `git diff --numstat -z` records, NUL-separated, exactly as git emits them. */
function numstat(...records: string[]): string {
  return records.join('\0') + (records.length > 0 ? '\0' : '');
}

describe('parseNumstat (P9-18)', () => {
  it('reads added/deleted/path out of an ordinary record', () => {
    expect(parseNumstat(numstat('12\t3\tsrc/parse.ts'))).toEqual([
      { path: 'src/parse.ts', added: 12, deleted: 3, binary: false },
    ]);
  });

  it('takes the destination path of a rename, which git splits across three fields', () => {
    // `1\t0\t` with an EMPTY path field, then from, then to — verified against
    // git 2.x. Read naively, the empty field looks like a nameless file and the
    // two paths look like two more records.
    expect(parseNumstat(numstat('1\t0\t', 'src/old.ts', 'src/new.ts'))).toEqual([
      { path: 'src/new.ts', added: 1, deleted: 0, binary: false, renamedFrom: 'src/old.ts' },
    ]);
  });

  it('reports a binary file rather than counting it: git has no lines to give', () => {
    expect(parseNumstat(numstat('-\t-\tassets/logo.png'))).toEqual([
      { path: 'assets/logo.png', added: 0, deleted: 0, binary: true },
    ]);
  });

  it('keeps paths with spaces whole (this is why the reader is -z, not line-based)', () => {
    expect(parseNumstat(numstat('2\t1\tdocs/a note.md'))[0]?.path).toBe('docs/a note.md');
  });

  it('returns nothing for an empty diff', () => {
    expect(parseNumstat('')).toEqual([]);
  });

  it('refuses a record it cannot parse instead of silently counting zero', () => {
    expect(() => parseNumstat(numstat('not-a-record'))).toThrowError(DiffstatError);
    expect(() => parseNumstat(numstat('not-a-record'))).toThrowError(
      expect.objectContaining({ code: 'diffstat.unparseable-numstat' }),
    );
  });
});

describe('isExcludedDiffPath (P9-18)', () => {
  it('excludes lockfiles by basename, at any depth', () => {
    expect(isExcludedDiffPath('pnpm-lock.yaml')).toBe(true);
    expect(isExcludedDiffPath('packages/api/package-lock.json')).toBe(true);
    expect(isExcludedDiffPath('Cargo.lock')).toBe(true);
  });

  it('excludes generated directories', () => {
    expect(isExcludedDiffPath('dist/index.js')).toBe(true);
    expect(isExcludedDiffPath('ui/coverage/lcov-report/index.html')).toBe(true);
  });

  it('counts ordinary source and docs', () => {
    expect(isExcludedDiffPath('src/parse.ts')).toBe(false);
    expect(isExcludedDiffPath('docs/guide/operator-guide.md')).toBe(false);
    // Not a lockfile, despite the name — the match is on the whole basename.
    expect(isExcludedDiffPath('src/lock.ts')).toBe(false);
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('measureDiff (P9-18, real git)', () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-diffstat-'));
    repo = path.join(root, 'repo');
    await mkdir(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    await writeFile(path.join(repo, 'src.ts'), 'one\ntwo\nthree\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
    git(repo, ['branch', 'smith/epic-1/integration']);
    git(repo, ['checkout', '-q', '-b', 'smith/epic-1/task-1']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('counts added + deleted over the task branch, against the derived integration branch', async () => {
    await writeFile(path.join(repo, 'src.ts'), 'one\nTWO\nthree\nfour\n');
    await writeFile(path.join(repo, 'new.ts'), 'a\nb\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'work']);

    const measured = measureDiff(repo);

    // src.ts: 1 line rewritten (+1/-1) plus 1 appended (+1) = 3; new.ts: +2.
    expect(measured.diffLines).toBe(5);
    expect(measured.baseRef).toBe('smith/epic-1/integration');
    expect(measured.files.map((f) => f.path).sort()).toEqual(['new.ts', 'src.ts']);
  });

  it('leaves lockfiles and generated files out of the total, but still reports them', async () => {
    await writeFile(path.join(repo, 'src.ts'), 'one\ntwo\nthree\nfour\n');
    await writeFile(path.join(repo, 'pnpm-lock.yaml'), 'lockfile: {}\n'.repeat(400));
    await mkdir(path.join(repo, 'dist'));
    await writeFile(path.join(repo, 'dist', 'bundle.js'), 'x\n'.repeat(900));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'work plus noise']);

    const measured = measureDiff(repo);

    expect(measured.diffLines).toBe(1);
    expect(measured.files).toHaveLength(3);
    const lock = measured.files.find((f) => f.path === 'pnpm-lock.yaml');
    expect(lock).toMatchObject({ added: 400, excluded: true });
    expect(measured.excludedLines).toBe(1300);
  });

  it('measures against an explicit base ref when one is given', async () => {
    const head = git(repo, ['rev-parse', 'HEAD']);
    await writeFile(path.join(repo, 'src.ts'), 'one\ntwo\nthree\nfour\n');
    git(repo, ['commit', '-q', '-am', 'work']);

    expect(measureDiff(repo, { baseRef: head })).toMatchObject({ diffLines: 1, baseRef: head });
  });

  // D-157. Two hand-written TypeScript sources in this repo carried a NUL byte
  // for days (D-155), and git called both of them binary: the commit that
  // rewrote 2.9 KB of `agents-registry.ts` reported `0 insertions(+), 0
  // deletions(-)`. This module turns that report into the number a diff cap is
  // about, and a file git could not count must not read as a file that did not
  // change.
  it('reports the files git could not count instead of folding them into zero', async () => {
    await writeFile(path.join(repo, 'src.ts'), 'one\ntwo\u0000\nthree\nfour\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'a source file git reads as binary']);

    const measured = measureDiff(repo);

    expect(measured.files).toMatchObject([{ path: 'src.ts', binary: true, added: 0, deleted: 0 }]);
    expect(measured.unmeasuredFiles).toEqual(['src.ts']);
  });

  it('leaves an excluded binary off that list — it was never going to be counted', async () => {
    await writeFile(path.join(repo, 'bun.lockb'), 'lock\u0000file\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'lockfile']);

    const measured = measureDiff(repo);

    expect(measured.files).toMatchObject([{ path: 'bun.lockb', binary: true, excluded: true }]);
    expect(measured.unmeasuredFiles).toEqual([]);
  });

  it('counts nothing, and says so, when the branch has not diverged', () => {
    expect(measureDiff(repo)).toMatchObject({ diffLines: 0, files: [] });
  });

  it('names the ref it could not resolve rather than reporting a zero diff', () => {
    expect(() => measureDiff(repo, { baseRef: 'no/such/ref' })).toThrowError(
      expect.objectContaining({ code: 'diffstat.cannot-resolve-base-ref' }),
    );
  });

  it('refuses to guess a base ref off a branch that is not a task branch', () => {
    git(repo, ['checkout', '-q', 'main']);
    expect(() => measureDiff(repo)).toThrowError(
      expect.objectContaining({ code: 'diffstat.cannot-derive-base-ref' }),
    );
  });

  it('reports a non-git directory as a typed failure, not a raw shell error', async () => {
    const notARepo = path.join(root, 'elsewhere');
    await mkdir(notARepo);
    expect(() => measureDiff(notARepo)).toThrowError(
      expect.objectContaining({ code: 'diffstat.not-a-git-worktree' }),
    );
  });
});
