import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitCommandError, redactCredentials, runGit, runGitRaw } from '../src/git.js';

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
});
