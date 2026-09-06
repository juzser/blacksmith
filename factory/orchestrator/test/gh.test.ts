import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { runGit } from '../src/git.js';
import type { ProjectRef } from '../src/projects.js';

// Every temp repo is set up through `runGit` (already exported by git.ts),
// never through a direct `node:child_process` import here — the epic's
// evidence shape is "we assert on what would have been run", and that
// starts with this test file never touching a real process itself.
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
      // Under the null (a resolver that falls back to the process's own
      // directory), this case would read `juzser/blacksmith` — a
      // well-formed wrong answer for a project the register never named.
      expect(resolveProjectRepo('unknown-project', register)).toEqual({
        reason: 'no-checkout',
        detail: expect.any(String),
      });
    });
  });

  describe('classifyGh', () => {
    it('names three distinct outcomes for three distinct runner behaviours', () => {
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

      const missing = classifyGh(() => spawnFailure);
      const unauthenticated = classifyGh(() => notLoggedIn);
      const readyResult = classifyGh(() => ready);

      expect(missing.outcome).toBe('missing');
      expect(unauthenticated.outcome).toBe('unauthenticated');
      expect(readyResult.outcome).toBe('ready');

      const outcomes = [missing.outcome, unauthenticated.outcome, readyResult.outcome];
      expect(new Set(outcomes).size).toBe(3);
    });

    it('classifies anything else as the explicit unknown outcome', () => {
      const odd = classifyGh(() => ({ status: 7, stdout: '', stderr: 'some other failure' }));
      expect(odd.outcome).toBe('unknown');
    });

    it('records every call the stub runner receives, so a test can assert the count', () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      classifyGh((cmd, args) => {
        calls.push({ cmd, args });
        return { status: 0, stdout: '', stderr: '' };
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ cmd: 'gh', args: ['auth', 'status'] });
    });
  });

  describe('command builders — argv, never a shell', () => {
    const hostileBody = 'line one\n`backtick` $(id) and a "quote"';

    it('builds a create-issue argv as an array, delivering the body byte-for-byte', () => {
      const argv = buildCreateIssueArgv('o/r', 'title', hostileBody);
      expect(Array.isArray(argv)).toBe(true);
      for (const el of argv) {
        expect(typeof el).toBe('string');
        expect(el).not.toContain('$(id)');
      }
      const bodyFileIndex = argv.indexOf('--body-file') + 1;
      const bodyFilePath = argv[bodyFileIndex];
      expect(readFileSync(bodyFilePath, 'utf8')).toBe(hostileBody);
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
      expect(readFileSync(argv[bodyFileIndex], 'utf8')).toBe(hostileBody);
    });
  });
});
