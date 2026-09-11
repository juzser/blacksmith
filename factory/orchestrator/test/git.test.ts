import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partial mock: every call passes through to the real execFileSync except
// where a single test overrides it with `mockImplementationOnce`, to reach
// exec()'s catch branch with a caught error node itself never produces.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

import {
  GitCommandError,
  readOriginUrl,
  redactCredentials,
  runGit,
  runGitRaw,
} from '../src/git.js';

describe('git.ts', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), 'smith-git-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    await writeFile(path.join(repoDir, 'README.md'), '# repo\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('returns trimmed stdout', () => {
    expect(runGit(repoDir, ['branch', '--show-current'])).toBe('main');
  });

  it('leaves NUL-separated output untouched in raw mode', async () => {
    await writeFile(path.join(repoDir, 'new file.txt'), 'x\n');
    const raw = runGitRaw(repoDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    expect(raw).toBe('?? new file.txt\0');
  });

  // The whole point of P9-16(b): stderr is CAPTURED, not inherited. With
  // execFileSync's default stdio git writes straight to the parent's fd 2 and
  // the thrown error's `stderr` is null — so a non-empty `stderr` here is the
  // evidence that nothing reached the operator's terminal.
  it('captures git stderr instead of letting it reach the terminal', () => {
    let caught: unknown;
    try {
      runGit(repoDir, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    const error = caught as GitCommandError;
    expect(error.stderr).toContain('not a symbolic ref');
    expect(error.status).toBe(128);
  });

  // Silencing a channel must not delete the evidence on it — the same mistake
  // D-47 cost a false diagnosis for. git's own words go into the message.
  it('folds git stderr into the thrown error message', () => {
    expect(() => runGit(repoDir, ['rev-parse', '--verify', 'no-such-ref'])).toThrow(/no-such-ref/);
  });

  it('names the command and the directory it ran in', () => {
    let message = '';
    try {
      runGit(repoDir, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('git symbolic-ref refs/remotes/origin/HEAD');
    expect(message).toContain(repoDir);
  });

  it('reports a failure that said nothing rather than an empty message', () => {
    let message = '';
    try {
      runGit(repoDir, ['merge-base', '--is-ancestor', 'HEAD', 'HEAD~0', '--']);
    } catch (err) {
      message = (err as Error).message;
    }
    // `--` is not a valid extra arg here; whichever way git objects, the
    // message must never trail off after the exit code.
    expect(message).not.toMatch(/exit \d+\):\s*$/);
  });

  // guardrails.md, "No secrets in outputs". Routing stderr into the CLI's JSON
  // error envelope moves it from a terminal into logs, event records and PR
  // bodies, so a remote URL carrying a token must not travel with it.
  it('redacts credentials embedded in a remote URL', () => {
    expect(
      redactCredentials("fatal: unable to access 'https://alice:ghp_secret@host/x.git/'"),
    ).toBe("fatal: unable to access 'https://alice:***@host/x.git/'");
    expect(redactCredentials('https://ghp_tokenonly@host/x.git')).toBe('https://***@host/x.git');
    expect(redactCredentials('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref')).toBe(
      'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref',
    );
  });

  it('reads the origin remote url', () => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], {
      cwd: repoDir,
    });
    expect(readOriginUrl(repoDir)).toBe('https://github.com/o/r.git');
  });

  it('throws GitCommandError naming "No such remote" when there is no origin', () => {
    let caught: unknown;
    try {
      readOriginUrl(repoDir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    expect((caught as GitCommandError).stderr).toMatch(/no such remote/i);
  });

  // status === null (killed by signal / never exited) is a real outcome the
  // constructor must format distinctly from a numeric exit code, and a
  // silent failure ("said nothing") must not read as an empty message.
  it('formats a null status as "did not exit normally" and an empty stderr as "said nothing"', () => {
    const error = new GitCommandError(repoDir, ['status'], null, '');
    expect(error.status).toBeNull();
    expect(error.stderr).toBe('');
    expect(error.message).toContain('did not exit normally');
    expect(error.message).toContain('and said nothing');
  });

  // A cwd that does not exist makes execFileSync fail to spawn at all: no
  // exit status, no stderr, and node's own errno string in `code` instead --
  // the one thing `exec`'s catch branch is there to report.
  it('reports a spawn failure (no such cwd) with a null status and the errno in the message', () => {
    let caught: unknown;
    try {
      runGit(path.join(repoDir, 'does-not-exist'), ['status']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    const error = caught as GitCommandError;
    expect(error.status).toBeNull();
    expect(error.message).toContain('ENOENT');
  });

  // A caught error carrying neither `stderr` nor a string `code` is an edge
  // node itself never produces from execFileSync, but `exec`'s catch branch
  // must still fall back to "" rather than throw formatting the message.
  it('falls back to an empty stderr when the caught error has neither stderr nor a string code', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('no stderr, no code here');
    });
    let caught: unknown;
    try {
      runGit(repoDir, ['status']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    const error = caught as GitCommandError;
    expect(error.stderr).toBe('');
    expect(error.message).toContain('and said nothing');
  });
});
