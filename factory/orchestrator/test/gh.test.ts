import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCommentArgv,
  buildCreateIssueArgv,
  buildSearchIssuesArgv,
  type CommandResult,
  classifyGh,
  resolveProjectRepo,
  resolveRepoAtDir,
  slugFromRemoteUrl,
} from '../src/gh.js';
import * as git from '../src/git.js';
import { runGit } from '../src/git.js';
import type { ProjectRef } from '../src/projects.js';

// Real repos, set up via `runGit` (git.ts) rather than a direct
// `node:child_process` import in this file.
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'smith-gh-'));
  runGit(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

describe('gh.ts', () => {
  describe('slugFromRemoteUrl', () => {
    it.each([
      ['https://github.com/o/r.git', 'o/r'],
      ['https://github.com/o/r', 'o/r'],
      ['git@github.com:o/r.git', 'o/r'],
      ['ssh://git@github.com/o/r.git', 'o/r'],
      ['https://user:ghp_FAKETOKEN123@github.com/o/r.git', 'o/r'],
    ])('parses %s as %s', (url, expected) => {
      const result = slugFromRemoteUrl(url);
      expect(result).toEqual({ slug: expected });
    });

    it('never lets a credentialed URL leak the token', () => {
      const result = slugFromRemoteUrl('https://user:ghp_FAKETOKEN123@github.com/o/r.git');
      expect(JSON.stringify(result)).not.toContain('ghp_FAKETOKEN123');
    });

    it('refuses an unparseable remote', () => {
      expect(slugFromRemoteUrl('not-a-url')).toEqual({
        reason: 'unparseable-remote',
        detail: expect.any(String),
      });
    });

    it('refuses a non-GitHub host', () => {
      expect(slugFromRemoteUrl('https://gitlab.com/o/r.git')).toEqual({
        reason: 'non-github-host',
        detail: expect.any(String),
      });
    });
  });

  describe('resolveRepoAtDir — refusal is distinguishable from an answer', () => {
    let dirs: string[];

    beforeEach(() => {
      dirs = [];
    });

    afterEach(async () => {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    });

    it('names three different reasons for three different failures', async () => {
      const notARepo = await mkdtemp(path.join(tmpdir(), 'smith-gh-plain-'));
      const noOrigin = await makeRepo();
      const wrongHost = await makeRepo();
      runGit(wrongHost, ['remote', 'add', 'origin', 'https://gitlab.com/o/r.git']);
      dirs = [notARepo, noOrigin, wrongHost];

      const a = resolveRepoAtDir(notARepo);
      const b = resolveRepoAtDir(noOrigin);
      const c = resolveRepoAtDir(wrongHost);

      expect('reason' in a && a.reason).toBe('not-a-repo');
      expect('reason' in b && b.reason).toBe('no-origin');
      expect('reason' in c && c.reason).toBe('non-github-host');

      const reasons = [a, b, c].map((r) => ('reason' in r ? r.reason : r.slug));
      expect(new Set(reasons).size).toBe(3);
    });

    // Only a GitCommandError is classified into not-a-repo/no-origin; any
    // other error out of readOriginUrl is a programming or environment
    // fault and must be rethrown as-is, not mis-filed as a refusal.
    it('rethrows an error from readOriginUrl that is not a GitCommandError', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'smith-gh-rethrow-'));
      dirs = [dir];
      const spy = vi.spyOn(git, 'readOriginUrl').mockImplementationOnce(() => {
        throw new TypeError('boom');
      });
      try {
        expect(() => resolveRepoAtDir(dir)).toThrow(TypeError);
      } finally {
        spy.mockRestore();
      }
    });

    it('names git-failed, not no-origin, for a corrupt .git/config', async () => {
      const dir = await makeRepo();
      dirs = [dir];
      runGit(dir, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
      const configPath = path.join(dir, '.git', 'config');
      writeFileSync(configPath, `this is not a config line\n${readFileSync(configPath, 'utf8')}`);

      const a = resolveRepoAtDir(dir);

      expect('reason' in a ? String(a.reason) : a.slug).toBe('git-failed');
      expect('reason' in a && a.detail).toMatch(/bad config line 1/);
    });

    it('names git-failed for a spawn failure (ENOENT), never no-origin', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'smith-gh-spawn-'));
      dirs = [dir];
      const spy = vi.spyOn(git, 'readOriginUrl').mockImplementationOnce(() => {
        throw new git.GitCommandError(
          dir,
          ['remote', 'get-url', 'origin'],
          null,
          'git could not be run (ENOENT)',
        );
      });
      try {
        const a = resolveRepoAtDir(dir);
        expect('reason' in a ? String(a.reason) : a.slug).toBe('git-failed');
        expect('reason' in a && a.detail).toContain('ENOENT');
        expect('reason' in a && a.detail).toContain(dir);
      } finally {
        spy.mockRestore();
      }
    });

    it('names git-failed for a real missing cwd (ENOENT)', async () => {
      const parent = await mkdtemp(path.join(tmpdir(), 'smith-gh-gone-'));
      dirs = [parent];
      const missing = path.join(parent, 'gone');

      const a = resolveRepoAtDir(missing);

      expect('reason' in a ? String(a.reason) : a.slug).toBe('git-failed');
      expect('reason' in a && a.detail).toMatch(/ENOENT/);
    });

    it('names git-failed for a real plain file (ENOTDIR)', async () => {
      const parent = await mkdtemp(path.join(tmpdir(), 'smith-gh-file-'));
      dirs = [parent];
      const file = path.join(parent, 'plain-file');
      writeFileSync(file, 'not a directory');

      const a = resolveRepoAtDir(path.join(file, 'nested'));

      expect('reason' in a ? String(a.reason) : a.slug).toBe('git-failed');
      expect('reason' in a && a.detail).toMatch(/ENOTDIR/);
    });

    it('reserves no-origin for git actually saying the remote is absent, not other failures', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'smith-gh-other-'));
      dirs = [dir];
      const spy = vi.spyOn(git, 'readOriginUrl').mockImplementationOnce(() => {
        throw new git.GitCommandError(
          dir,
          ['remote', 'get-url', 'origin'],
          128,
          'fatal: something else entirely',
        );
      });
      try {
        const a = resolveRepoAtDir(dir);
        expect('reason' in a ? String(a.reason) : a.slug).toBe('git-failed');
      } finally {
        spy.mockRestore();
      }
    });

    it('produces six distinct refusals, each with a non-empty, unredacted-token-free detail', async () => {
      const noCheckout = resolveProjectRepo('ghost', []);

      const notARepo = await mkdtemp(path.join(tmpdir(), 'smith-gh-set-plain-'));
      dirs.push(notARepo);

      const noOrigin = await makeRepo();
      dirs.push(noOrigin);

      const gitFailedDir = await makeRepo();
      dirs.push(gitFailedDir);
      runGit(gitFailedDir, [
        'remote',
        'add',
        'origin',
        'https://user:ghp_FAKETOKEN123@github.com/o/r.git',
      ]);
      const configPath = path.join(gitFailedDir, '.git', 'config');
      writeFileSync(configPath, `this is not a config line\n${readFileSync(configPath, 'utf8')}`);

      const results = {
        'no-checkout': noCheckout,
        'not-a-repo': resolveRepoAtDir(notARepo),
        'no-origin': resolveRepoAtDir(noOrigin),
        'git-failed': resolveRepoAtDir(gitFailedDir),
        'unparseable-remote': slugFromRemoteUrl('not-a-url'),
        'non-github-host': slugFromRemoteUrl('https://gitlab.com/o/r.git'),
      };

      const reasons = Object.values(results).map((r) => ('reason' in r ? r.reason : r.slug));
      expect(new Set(reasons).size).toBe(6);
      for (const r of Object.values(results)) {
        expect('reason' in r && r.detail.length > 0).toBe(true);
        expect(JSON.stringify(r)).not.toContain('ghp_FAKETOKEN123');
      }
    });
  });

  describe('resolveProjectRepo', () => {
    let dirA: string;
    let dirB: string;
    let register: ProjectRef[];

    beforeEach(async () => {
      dirA = await makeRepo();
      dirB = await makeRepo();
      runGit(dirA, ['remote', 'add', 'origin', 'https://github.com/juzser/blacksmith.git']);
      runGit(dirB, ['remote', 'add', 'origin', 'git@github.com:someone/demo-rpg.git']);
      register = [
        { name: 'blacksmith', dir: dirA, self: true },
        { name: 'demo-rpg', dir: dirB, self: false },
      ];
    });

    afterEach(async () => {
      await Promise.all([dirA, dirB].map((d) => rm(d, { recursive: true, force: true })));
    });

    it('resolves two different projects to two different slugs, and refuses a third', () => {
      expect(resolveProjectRepo('blacksmith', register)).toEqual({ slug: 'juzser/blacksmith' });
      expect(resolveProjectRepo('demo-rpg', register)).toEqual({ slug: 'someone/demo-rpg' });
      // Under the null (falling back to the process's own directory) this
      // would read `juzser/blacksmith` — a well-formed wrong answer.
      expect(resolveProjectRepo('unknown-project', register)).toEqual({
        reason: 'no-checkout',
        detail: expect.any(String),
      });
    });
  });

  describe('classifyGh', () => {
    const spawnFailure: CommandResult = {
      status: null,
      stdout: '',
      stderr: '',
      spawnError: 'ENOENT',
    };
    const notLoggedIn: CommandResult = {
      status: 1,
      stdout: '',
      stderr: 'You are not logged into any GitHub hosts. Run gh auth login',
    };
    const ready: CommandResult = { status: 0, stdout: 'Logged in to github.com', stderr: '' };

    it('names three distinct outcomes for three distinct runner behaviours, plus unknown', () => {
      const outcomes = [
        classifyGh(() => spawnFailure).outcome,
        classifyGh(() => notLoggedIn).outcome,
        classifyGh(() => ready).outcome,
      ];
      expect(outcomes).toEqual(['missing', 'unauthenticated', 'ready']);
      expect(new Set(outcomes).size).toBe(3);
      expect(classifyGh(() => ({ status: 7, stdout: '', stderr: 'other' })).outcome).toBe(
        'unknown',
      );
    });

    it('falls back to stdout for the reason when stderr is empty', () => {
      const outcome = classifyGh(() => ({
        status: 1,
        stdout: 'not logged in to any GitHub hosts',
        stderr: '',
      }));
      expect(outcome).toEqual({
        outcome: 'unauthenticated',
        reason: 'not logged in to any GitHub hosts',
      });
    });

    it('records every call the stub runner receives, so a test can assert the count', () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      classifyGh((cmd, args) => {
        calls.push({ cmd, args });
        return ready;
      });
      expect(calls).toEqual([{ cmd: 'gh', args: ['auth', 'status'] }]);
    });
  });

  describe('command builders — argv, never a shell', () => {
    const hostileBody = 'line one\n`backtick` $(id) and a "quote"';

    it('builds a create-issue argv as an array, delivering the body byte-for-byte', () => {
      const argv = buildCreateIssueArgv('o/r', 'title', hostileBody);
      expect(Array.isArray(argv)).toBe(true);
      expect(argv.every((el) => typeof el === 'string' && !el.includes('$(id)'))).toBe(true);
      expect(readFileSync(argv[argv.indexOf('--body-file') + 1] as string, 'utf8')).toBe(
        hostileBody,
      );
    });

    it('builds a search-issues argv as an array', () => {
      const argv = buildSearchIssuesArgv('o/r', 'is:open label:factory-error');
      expect(Array.isArray(argv)).toBe(true);
      expect(argv).toContain('o/r');
    });

    it('builds a comment argv as an array, delivering the body byte-for-byte', () => {
      const argv = buildCommentArgv('o/r', 42, hostileBody);
      expect(Array.isArray(argv)).toBe(true);
      expect(argv).toContain('42');
      const bodyFileIndex = argv.indexOf('--body-file') + 1;
      expect(readFileSync(argv[bodyFileIndex] as string, 'utf8')).toBe(hostileBody);
    });
  });
});
