import { existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reopenTaskWorktree, WorktreeError } from '../src/worktree.js';
import { runCli } from './helpers/cliHarness.js';
import { createIntegrationRepo, type IntegrationRepo } from './helpers/integrationRepo.js';

const EPIC = 'epic-1';
const TASK = 'task-a';
const TASK_BRANCH = `bs/${EPIC}/${TASK}`;

/** Every ref and worktree, as one string to compare before and after. */
function snapshot(repo: IntegrationRepo): string {
  return [
    repo.git(['worktree', 'list', '--porcelain']),
    repo.git(['for-each-ref', '--format=%(refname) %(objectname)']),
  ].join('\n--\n');
}

function scratchEntries(repo: IntegrationRepo): string[] {
  return existsSync(repo.scratchRoot)
    ? readdirSync(repo.scratchRoot).filter((n) => n.startsWith('scratch-'))
    : [];
}

function revertInProgress(repo: IntegrationRepo): boolean {
  const dirs = repo
    .git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
  return dirs.some((dir) => {
    const file = repo.git(['rev-parse', '--git-path', 'REVERT_HEAD'], dir);
    return existsSync(path.resolve(dir, file));
  });
}

describe('reopenTaskWorktree', () => {
  let repo: IntegrationRepo;
  let mergeSha: string;
  let preRevertHead: string;
  let revertSha: string;

  beforeEach(async () => {
    repo = await createIntegrationRepo({ epicId: EPIC });
    repo.git(['branch', TASK_BRANCH, 'main']);
    mergeSha = repo.merge(TASK, { 'a.txt': 'a\n' });
    preRevertHead = repo.head();
    revertSha = repo.revert(mergeSha);
    repo.release();
  });

  afterEach(() => repo.dispose());

  const reopen = (sha: string = revertSha, onScratch?: (p: string) => void) =>
    reopenTaskWorktree(repo.projectDir, EPIC, TASK, sha, onScratch ? { onScratch } : {});

  it('attaches a worktree to the existing branch and leaves it one commit ahead of the head', () => {
    const before = repo.head();
    const scratch: string[] = [];
    const result = reopen(revertSha, (p) => scratch.push(p));

    expect(result).toEqual({
      worktreeDir: path.join(repo.root, '.wt', 'project', TASK),
      branch: TASK_BRANCH,
      epic: EPIC,
      taskId: TASK,
    });
    expect(repo.git(['rev-list', '--count', `${before}..${TASK_BRANCH}`])).toBe('1');
    expect(repo.git(['rev-parse', `${TASK_BRANCH}^`])).toBe(before);
    expect(repo.git(['rev-parse', `${TASK_BRANCH}^{tree}`])).toBe(
      repo.git(['rev-parse', `${preRevertHead}^{tree}`]),
    );
    expect(repo.head()).toBe(before);
    expect(repo.git(['status', '--porcelain'], result.worktreeDir)).toBe('');
    expect(scratch).toHaveLength(1);
    expect(path.dirname(scratch[0] as string)).toBe(repo.scratchRoot);
    expect(path.basename(scratch[0] as string)).toMatch(
      new RegExp(`^scratch-${process.pid}-[0-9a-f-]{36}$`),
    );
    expect(existsSync(scratch[0] as string)).toBe(false);
  });

  it('reuses a clean existing task worktree', () => {
    const dir = path.join(repo.root, '.wt', 'project', TASK);
    repo.git(['worktree', 'add', '-q', dir, TASK_BRANCH]);
    const scratch: string[] = [];
    const result = reopen(revertSha, (p) => scratch.push(p));

    expect(realpathSync(result.worktreeDir)).toBe(realpathSync(dir));
    expect(repo.git(['rev-parse', `${TASK_BRANCH}^`])).toBe(repo.head());
    expect(repo.git(['rev-parse', 'HEAD^{tree}'], dir)).toBe(
      repo.git(['rev-parse', `${preRevertHead}^{tree}`]),
    );
    expect(scratch).toHaveLength(1);
    expect(existsSync(scratch[0] as string)).toBe(false);
  });

  it('cuts a deleted branch from the head and gives it the same commit', () => {
    repo.git(['branch', '-D', TASK_BRANCH]);
    const scratch: string[] = [];
    reopen(revertSha, (p) => scratch.push(p));

    expect(repo.git(['rev-parse', `${TASK_BRANCH}^`])).toBe(repo.head());
    expect(repo.git(['rev-parse', `${TASK_BRANCH}^{tree}`])).toBe(
      repo.git(['rev-parse', `${preRevertHead}^{tree}`]),
    );
    expect(scratch).toHaveLength(1);
    expect(existsSync(scratch[0] as string)).toBe(false);
  });

  describe('early refusals', () => {
    const refuses = (code: string, sha: string = revertSha): void => {
      const before = snapshot(repo);
      let called = 0;
      expect(scratchEntries(repo)).toEqual([]);
      try {
        reopen(sha, () => called++);
        expect.unreachable('reopen should have refused');
      } catch (error) {
        expect(error).toBeInstanceOf(WorktreeError);
        expect((error as WorktreeError).code).toBe(code);
      }
      expect(called).toBe(0);
      expect(scratchEntries(repo)).toEqual([]);
      expect(snapshot(repo)).toBe(before);
    };

    it('refuses a dirty existing worktree', () => {
      const dir = path.join(repo.root, '.wt', 'project', TASK);
      repo.git(['worktree', 'add', '-q', dir, TASK_BRANCH]);
      writeFileSync(path.join(dir, 'README.md'), 'edited\n');
      refuses('worktree.reopen-dirty');
    });

    it('refuses a branch tip that is not an ancestor of the integration head', () => {
      const other = path.join(repo.root, 'other');
      repo.git(['worktree', 'add', '-q', '-b', 'side', other, 'main']);
      writeFileSync(path.join(other, 'side.txt'), 's\n');
      repo.git(['add', 'side.txt'], other);
      repo.git(['commit', '-q', '-m', 'side'], other);
      repo.git(['worktree', 'remove', '--force', other]);
      repo.git(['branch', '-f', TASK_BRANCH, 'side']);
      refuses('worktree.reopen-not-ancestor');
    });

    it('refuses a revert sha that is not on the integration branch', () => {
      const offBranch = repo.git(['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'off']);
      refuses('worktree.reopen-revert-not-on-integration', offBranch);
      refuses('worktree.reopen-revert-not-on-integration', 'f'.repeat(40));
    });
  });

  describe('a conflicting revert', () => {
    it('refuses with the sha and the path and leaves nothing behind', async () => {
      const other = await createIntegrationRepo({ epicId: EPIC, sessionId: 'sess-conflict' });
      try {
        other.handCommit({ 'f.txt': 'base\n' }, 'add f');
        other.git(['branch', TASK_BRANCH, 'main']);
        const m = other.merge(TASK, { 'f.txt': 'a\n' });
        const r = other.revert(m);
        other.merge('task-later', { 'f.txt': 'later\n' });
        other.release();
        const before = snapshot(other);
        const tip = other.git(['rev-parse', TASK_BRANCH]);
        const head = other.head();
        const scratch: string[] = [];

        let caught: unknown;
        try {
          reopenTaskWorktree(other.projectDir, EPIC, TASK, r, {
            onScratch: (p) => scratch.push(p),
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(WorktreeError);
        expect((caught as WorktreeError).code).toBe('worktree.reopen-revert-conflict');
        expect((caught as WorktreeError).message).toContain(r);
        expect((caught as WorktreeError).message).toContain('f.txt');
        expect(scratch).toHaveLength(1);
        expect(existsSync(scratch[0] as string)).toBe(false);
        expect(scratchEntries(other)).toEqual([]);
        expect(snapshot(other)).toBe(before);
        expect(other.git(['rev-parse', TASK_BRANCH])).toBe(tip);
        expect(other.head()).toBe(head);
        expect(revertInProgress(other)).toBe(false);
      } finally {
        await other.dispose();
      }
    });
  });

  it('prints the same keys as a plain worktree create through the CLI', () => {
    const run = runCli([
      'worktree',
      'create',
      repo.projectDir,
      EPIC,
      TASK,
      '--reopen',
      '--revert',
      revertSha,
    ]);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      worktreeDir: path.join(repo.root, '.wt', 'project', TASK),
      branch: TASK_BRANCH,
      epic: EPIC,
      taskId: TASK,
    });
    expect(repo.git(['rev-list', '--count', `${repo.head()}..${TASK_BRANCH}`])).toBe('1');
  });

  it('refuses through the CLI with exit 1 and the code', () => {
    const run = runCli([
      'worktree',
      'create',
      repo.projectDir,
      EPIC,
      TASK,
      '--reopen',
      '--revert',
      'f'.repeat(40),
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr + run.stdout).toContain('worktree.reopen-revert-not-on-integration');
  });

  it('asks for --revert with --reopen', () => {
    const run = runCli(['worktree', 'create', repo.projectDir, EPIC, TASK, '--reopen']);
    expect(run.status).toBe(1);
  });
});
