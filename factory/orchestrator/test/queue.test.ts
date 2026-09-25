import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import { admit, adopt, batchStep, groupForBatch, QueueError, step } from '../src/queue.js';
import type { TaskEventContext } from '../src/taskEvents.js';
import { createTaskWorktree } from '../src/worktree.js';
import { git as runGitFixture } from './helpers/process.js';

/** Trimmed — several assertions here compare a sha or a branch name directly. */
function git(cwd: string, args: string[]): string {
  return runGitFixture(cwd, args).trim();
}

describe('admit', () => {
  it('orders tasks topologically, tie-breaking by task id', () => {
    const order = admit(
      [{ task_id: 'b' }, { task_id: 'a' }, { task_id: 'c' }],
      [{ task: 'c', dependsOn: 'b' }],
    );
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('throws QueueError on a cyclic dependency', () => {
    expect(() =>
      admit(
        [{ task_id: 'a' }, { task_id: 'b' }],
        [
          { task: 'a', dependsOn: 'b' },
          { task: 'b', dependsOn: 'a' },
        ],
      ),
    ).toThrow(QueueError);
  });
});

describe('groupForBatch', () => {
  it('groups consecutive tasks whose claims are pairwise disjoint', () => {
    const groups = groupForBatch(
      [
        { taskId: 'a', claims: ['src/a.ts'] },
        { taskId: 'b', claims: ['src/b.ts'] },
        { taskId: 'c', claims: ['src/c.ts'] },
      ],
      [],
      [],
    );
    expect(groups).toEqual([['a', 'b', 'c']]);
  });

  it('splits the group where a claim overlaps an earlier member', () => {
    const groups = groupForBatch(
      [
        { taskId: 'a', claims: ['src/shared.ts'] },
        { taskId: 'b', claims: ['src/shared.ts'] },
        { taskId: 'c', claims: ['src/c.ts'] },
      ],
      [],
      [],
    );
    // b overlaps a, so it starts a fresh group; c is disjoint from b and joins it.
    expect(groups).toEqual([['a'], ['b', 'c']]);
  });

  it('gives a task with no claims its own singleton, isolated on both sides', () => {
    const groups = groupForBatch(
      [
        { taskId: 'a', claims: ['src/a.ts'] },
        { taskId: 'b' },
        { taskId: 'c', claims: ['src/c.ts'] },
      ],
      [],
      [],
    );
    expect(groups).toEqual([['a'], ['b'], ['c']]);
  });

  it('gives a task touching a serialize-always glob its own singleton', () => {
    const groups = groupForBatch(
      [
        { taskId: 'a', claims: ['src/a.ts'] },
        { taskId: 'b', claims: ['pnpm-lock.yaml'] },
        { taskId: 'c', claims: ['src/c.ts'] },
      ],
      [],
      ['pnpm-lock.yaml'],
    );
    expect(groups).toEqual([['a'], ['b'], ['c']]);
  });

  it('splits the group where a task depends_on a member of the current group', () => {
    const groups = groupForBatch(
      [
        { taskId: 'a', claims: ['src/a.ts'] },
        { taskId: 'b', claims: ['src/b.ts'] },
        { taskId: 'c', claims: ['src/c.ts'] },
      ],
      [{ task: 'b', dependsOn: 'a' }],
      [],
    );
    // b's claims don't overlap a's, but the dependency edge still splits the
    // group; c has no such edge and is disjoint from b, so it joins b.
    expect(groups).toEqual([['a'], ['b', 'c']]);
  });
});

describe('step', () => {
  let root: string;
  let originDir: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-queue-'));
    originDir = path.join(root, 'origin.git');
    projectDir = path.join(root, 'project');

    git(root, ['init', '-q', '--bare', '-b', 'main', originDir]);
    git(root, ['clone', '-q', originDir, projectDir]);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    await writeFile(path.join(projectDir, 'a.txt'), 'a\n');
    await writeFile(path.join(projectDir, 'b.txt'), 'b\n');
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-q', '-m', 'init']);
    git(projectDir, ['push', '-q', 'origin', 'main']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('merges a task whose rebase and tests both succeed', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    expect(result).toEqual({ outcome: 'merged', taskId: 'task-1' });

    const log = git(projectDir, ['log', 'smith/epic-1/integration', '--oneline']);
    expect(log).toContain('edit a');
  });

  // The queue used to `git checkout` the integration branch in the project
  // directory to merge, which moved the operator's own clone off the branch
  // they were working on. The merge now happens in a worktree of its own.
  it('never changes the branch the project directory has checked out', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);
    const worktreesBefore = git(projectDir, ['worktree', 'list', '--porcelain']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    expect(result).toEqual({ outcome: 'merged', taskId: 'task-1' });
    expect(git(projectDir, ['branch', '--show-current'])).toBe('main');
    expect(git(projectDir, ['status', '--porcelain'])).toBe('');
    expect(git(projectDir, ['log', 'smith/epic-1/integration', '--oneline'])).toContain(
      'Merge task-1 into smith/epic-1/integration',
    );
    // No merge worktree was added, or left behind.
    expect(git(projectDir, ['worktree', 'list', '--porcelain'])).toBe(worktreesBefore);
  });

  // With no worktree holding the integration branch the merge is made with
  // plumbing (merge-tree, commit-tree, update-ref): no working tree, so no
  // commit hook runs and no worktree is added, removed or pruned.
  it('merges with no working tree when no worktree holds the integration branch', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);
    const worktreesBefore = git(projectDir, ['worktree', 'list', '--porcelain']);
    // A hook that would refuse any merge commit made in a working tree.
    for (const name of ['pre-merge-commit', 'commit-msg']) {
      writeFileSync(path.join(projectDir, '.git', 'hooks', name), '#!/bin/sh\nexit 1\n', {
        mode: 0o755,
      });
    }

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    expect(result).toEqual({ outcome: 'merged', taskId: 'task-1' });
    expect(git(projectDir, ['worktree', 'list', '--porcelain'])).toBe(worktreesBefore);
    expect(git(projectDir, ['show', 'smith/epic-1/integration:a.txt'])).toBe('a-edited');
  });

  it('lands a two-parent merge commit with the queue message', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);
    const integrationBefore = git(projectDir, ['rev-parse', 'smith/epic-1/integration']);

    await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    const taskHead = git(projectDir, ['rev-parse', task.branch]);
    const parents = git(projectDir, [
      'rev-list',
      '--parents',
      '-n',
      '1',
      'smith/epic-1/integration',
    ])
      .split(' ')
      .slice(1);
    expect(parents).toEqual([integrationBefore, taskHead]);
    expect(git(projectDir, ['log', '-1', '--format=%B', 'smith/epic-1/integration'])).toBe(
      'Merge task-1 into smith/epic-1/integration',
    );
    expect(git(projectDir, ['log', '-1', '--format=%an <%ae>', 'smith/epic-1/integration'])).toBe(
      'Test <test@example.com>',
    );
  });

  // The operator's checkouts are not ours to clean (architecture §18 rule 10):
  // a linked worktree whose directory is away for a moment stays registered.
  it('leaves the registration of an operator worktree whose directory is missing', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);
    const operatorDir = path.join(root, 'operator-wt');
    const awayDir = path.join(root, 'operator-wt-away');
    git(projectDir, ['worktree', 'add', '-q', '-b', 'operator-feature', operatorDir]);
    await rename(operatorDir, awayDir);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    expect(result).toEqual({ outcome: 'merged', taskId: 'task-1' });
    await rename(awayDir, operatorDir);
    expect(git(operatorDir, ['branch', '--show-current'])).toBe('operator-feature');
    expect(git(operatorDir, ['status', '--porcelain'])).toBe('');
  });

  it('treats a prunable worktree entry on the integration branch as not holding it', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);
    const staleDir = path.join(root, 'stale-integration');
    git(projectDir, ['worktree', 'add', '-q', staleDir, 'smith/epic-1/integration']);
    await rm(staleDir, { recursive: true, force: true });
    expect(git(projectDir, ['worktree', 'list', '--porcelain'])).toContain('prunable');

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    expect(result).toEqual({ outcome: 'merged', taskId: 'task-1' });
    expect(git(projectDir, ['show', 'smith/epic-1/integration:a.txt'])).toBe('a-edited');
    // Not ours to prune either.
    expect(git(projectDir, ['worktree', 'list', '--porcelain'])).toContain(staleDir);
  });

  // The rebase leaves the task branch on top of integration, so a conflict at
  // merge time means integration moved underneath the queue; here the test
  // command moves it. The merge must fail loudly and land nothing.
  it('throws on a tree-less merge conflict and leaves the integration ref alone', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);
    const integration = 'refs/heads/smith/epic-1/integration';
    const script = path.join(root, 'move-integration.sh');
    await writeFile(
      script,
      [
        'set -e',
        `cd ${JSON.stringify(projectDir)}`,
        `export GIT_INDEX_FILE=${JSON.stringify(path.join(root, 'side.index'))}`,
        `git read-tree ${integration}`,
        "blob=$(printf 'a-other\\n' | git hash-object -w --stdin)",
        'git update-index --cacheinfo 100644,$blob,a.txt',
        `c=$(git commit-tree $(git write-tree) -p ${integration} -m side)`,
        `git update-ref ${integration} $c`,
        '',
      ].join('\n'),
    );

    let movedTo = '';
    await expect(
      step(
        { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
        { projectDir, epic: 'epic-1', testCmd: `sh ${JSON.stringify(script)}` },
      ).finally(() => {
        movedTo = git(projectDir, ['rev-parse', integration]);
      }),
    ).rejects.toThrow(/git merge-tree[\s\S]*a\.txt/);

    expect(git(projectDir, ['log', '-1', '--format=%s', movedTo])).toBe('side');
    expect(git(projectDir, ['rev-parse', integration])).toBe(movedTo);
    expect(git(projectDir, ['worktree', 'list', '--porcelain'])).not.toContain('smith-merge-');
  });

  it('merges in the project directory when it already has the integration branch out', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);
    git(projectDir, ['checkout', '-q', 'smith/epic-1/integration']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    expect(result).toEqual({ outcome: 'merged', taskId: 'task-1' });
    expect(git(projectDir, ['branch', '--show-current'])).toBe('smith/epic-1/integration');
    expect(git(projectDir, ['status', '--porcelain'])).toBe('');
    expect(await readFile(path.join(projectDir, 'a.txt'), 'utf8')).toBe('a-edited\n');
  });

  it('merges in the linked worktree that already has the integration branch out', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);
    const integrationDir = path.join(root, 'integration');
    git(projectDir, ['worktree', 'add', '-q', integrationDir, 'smith/epic-1/integration']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    expect(result).toEqual({ outcome: 'merged', taskId: 'task-1' });
    expect(git(projectDir, ['branch', '--show-current'])).toBe('main');
    expect(git(integrationDir, ['status', '--porcelain'])).toBe('');
    expect(await readFile(path.join(integrationDir, 'a.txt'), 'utf8')).toBe('a-edited\n');
  });

  it('refuses to merge into a worktree whose integration checkout has uncommitted changes', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);
    git(projectDir, ['checkout', '-q', 'smith/epic-1/integration']);
    await writeFile(path.join(projectDir, 'b.txt'), 'operator is editing\n');
    const headBefore = git(projectDir, ['rev-parse', 'smith/epic-1/integration']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    expect(result).toMatchObject({ outcome: 'integration-dirty', taskId: 'task-1' });
    if (result.outcome !== 'integration-dirty') throw new Error('unreachable');
    expect(await realpath(result.worktree)).toBe(await realpath(projectDir));
    expect(result.dirty).toEqual(['b.txt']);
    expect(git(projectDir, ['rev-parse', 'smith/epic-1/integration'])).toBe(headBefore);
    // The operator's edit is untouched.
    expect(await readFile(path.join(projectDir, 'b.txt'), 'utf8')).toBe('operator is editing\n');
  });

  it('reports tests-failed when the epic test command fails, without merging', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'false' },
    );

    expect(result.outcome).toBe('tests-failed');
    if (result.outcome === 'tests-failed') {
      expect(typeof result.outputTail).toBe('string');
    }

    const log = git(projectDir, ['log', 'smith/epic-1/integration', '--oneline']);
    expect(log).not.toContain('edit a');
  });

  it("runs the test command without the factory's own SMITH_ variables", async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);

    const before = process.env.SMITH_HOME;
    process.env.SMITH_HOME = projectDir;
    try {
      const result = await step(
        { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
        { projectDir, epic: 'epic-1', testCmd: '! env | grep -q "^SMITH_"' },
      );
      expect(result).toEqual({ outcome: 'merged', taskId: 'task-1' });
    } finally {
      if (before === undefined) delete process.env.SMITH_HOME;
      else process.env.SMITH_HOME = before;
    }
  });

  it('still lets the test command set a SMITH_ variable for itself', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      {
        projectDir,
        epic: 'epic-1',
        testCmd: 'export SMITH_HOME=/declared; test "$SMITH_HOME" = /declared',
      },
    );

    expect(result).toEqual({ outcome: 'merged', taskId: 'task-1' });
  });

  it('leaves the rest of the environment alone, so the command can find its tools', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'test -n "$PATH" && command -v node >/dev/null' },
    );

    expect(result).toEqual({ outcome: 'merged', taskId: 'task-1' });
  });

  it('reports rebase-conflict and leaves the task branch untouched (never auto-resolves)', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'from-task\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'task edits a']);

    // Simulate a prior merged task that touched the same line of a.txt.
    git(projectDir, ['checkout', '-q', 'smith/epic-1/integration']);
    await writeFile(path.join(projectDir, 'a.txt'), 'from-integration\n');
    git(projectDir, ['commit', '-q', '-am', 'integration edits a']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    expect(result.outcome).toBe('rebase-conflict');
    if (result.outcome === 'rebase-conflict') {
      expect(result.conflictingFiles).toEqual(['a.txt']);
    }

    // The task worktree is left in a clean, non-rebasing state.
    const status = git(task.worktreeDir, ['status', '--porcelain']);
    expect(status).toBe('');
    const rebaseMergeExists = git(task.worktreeDir, ['rev-parse', '--is-inside-work-tree']);
    expect(rebaseMergeExists).toBe('true');

    const log = git(projectDir, ['log', 'smith/epic-1/integration', '--oneline']);
    expect(log).not.toContain('task edits a');
  });

  // D-30/P9-8: `task-3-validate` reported done with 260 lines staged and never
  // committed. The rebase, the tests and the merge all "succeeded" against a
  // branch head that was still the integration commit it was cut from, and the
  // queue returned `merged` for a merge that moved nothing.
  it('refuses to merge a task whose branch is not ahead of integration', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-3');

    const result = await step(
      { taskId: 'task-3', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    expect(result).toEqual({
      outcome: 'nothing-to-merge',
      taskId: 'task-3',
      reason: 'branch-not-advanced',
      dirty: [],
    });
  });

  it('refuses to merge a task that left its work uncommitted, naming the paths', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-3');
    await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['add', 'a.txt']);

    const result = await step(
      { taskId: 'task-3', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    expect(result).toMatchObject({ outcome: 'nothing-to-merge', reason: 'uncommitted-work' });
    if (result.outcome !== 'nothing-to-merge') throw new Error('unreachable');
    expect(result.dirty).toEqual(['a.txt']);

    // Refused before the rebase: the staged work is still exactly where it was.
    expect(git(task.worktreeDir, ['status', '--porcelain'])).toBe('M  a.txt');
  });

  // D-46/P9-29: the queue is the only component that knows a branch actually
  // landed. Until now it returned that fact to its caller and nothing wrote
  // it down, so the tasks table's `completed` rows came from a human typing
  // `event append` afterwards — or, when nobody did, from nowhere at all.
  describe('event production', () => {
    let stateDir: string;
    const sessionId = 'sess-queue';
    let events: { ctx: TaskEventContext; stateDir: string };

    beforeEach(async () => {
      stateDir = path.join(root, 'state');
      const rootEvent = await appendEvent(
        {
          session_id: sessionId,
          actor: 'system',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        },
        { stateDir },
      );
      events = {
        ctx: { sessionId, planVersion: 1, causalParent: rootEvent.event_id, actor: 'system' },
        stateDir,
      };
    });

    async function logged(): Promise<{ type: string; taskId?: string; payload: unknown }[]> {
      const all = await readEvents(sessionId, { stateDir });
      return all
        .filter((e) => e.record.event_type !== 'session-start')
        .map((e) => ({
          type: e.record.event_type,
          ...(e.record.task_id ? { taskId: e.record.task_id } : {}),
          payload: e.record.payload,
        }));
    }

    // The file list is read off the merge commit itself (P9-15): the queue is
    // the only place that knows which files a landed branch actually rewrote,
    // and a finding anchored to one of them is answering about deleted code.
    it('logs wave-merged with the files the merge changed, at the moment it merges', async () => {
      const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
      await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
      git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);

      await step(
        { taskId: 'epic-1/task-1', branch: task.branch, worktreeDir: task.worktreeDir },
        { projectDir, epic: 'epic-1', testCmd: 'true', events },
      );

      expect(await logged()).toEqual([
        {
          type: 'wave-merged',
          taskId: 'epic-1/task-1',
          payload: { task_ids: ['epic-1/task-1'], files_changed: ['a.txt'] },
        },
      ]);
    });

    it('logs a classified error-logged when the epic tests fail', async () => {
      const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
      await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
      git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);

      await step(
        { taskId: 'epic-1/task-1', branch: task.branch, worktreeDir: task.worktreeDir },
        { projectDir, epic: 'epic-1', testCmd: 'false', events },
      );

      const [event] = await logged();
      expect(event?.type).toBe('error-logged');
      expect(event?.payload).toMatchObject({
        error: 'execution.test-failure',
        task_ref: 'epic-1/task-1',
      });
    });

    it('logs a merge-conflict error-logged when the rebase conflicts', async () => {
      const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
      await writeFile(path.join(task.worktreeDir, 'a.txt'), 'from-task\n');
      git(task.worktreeDir, ['commit', '-q', '-am', 'task edits a']);
      git(projectDir, ['checkout', '-q', 'smith/epic-1/integration']);
      await writeFile(path.join(projectDir, 'a.txt'), 'from-integration\n');
      git(projectDir, ['commit', '-q', '-am', 'integration edits a']);

      await step(
        { taskId: 'epic-1/task-1', branch: task.branch, worktreeDir: task.worktreeDir },
        { projectDir, epic: 'epic-1', testCmd: 'true', events },
      );

      const [event] = await logged();
      expect(event?.payload).toMatchObject({ error: 'integration.merge-conflict-textual' });
    });

    it('logs an env-failure error-logged when the integration checkout is dirty', async () => {
      const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
      await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
      git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);
      git(projectDir, ['checkout', '-q', 'smith/epic-1/integration']);
      await writeFile(path.join(projectDir, 'b.txt'), 'operator is editing\n');

      await step(
        { taskId: 'epic-1/task-1', branch: task.branch, worktreeDir: task.worktreeDir },
        { projectDir, epic: 'epic-1', testCmd: 'true', events },
      );

      const all = await logged();
      expect(all.map((e) => e.type)).toEqual(['error-logged']);
      expect(all[0]?.payload).toMatchObject({
        error: 'execution.env-failure',
        task_ref: 'epic-1/task-1',
      });
    });

    it('logs a contract error-logged when the task has nothing to merge (D-30)', async () => {
      const task = createTaskWorktree(projectDir, 'epic-1', 'task-3');
      await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');

      await step(
        { taskId: 'epic-1/task-3', branch: task.branch, worktreeDir: task.worktreeDir },
        { projectDir, epic: 'epic-1', testCmd: 'true', events },
      );

      const [event] = await logged();
      expect(event?.type).toBe('error-logged');
      expect(event?.payload).toMatchObject({
        error: 'contract.uncommitted-work',
        task_ref: 'epic-1/task-3',
      });
    });

    it('writes nothing when no event context is supplied', async () => {
      const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
      await writeFile(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
      git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);

      await step(
        { taskId: 'epic-1/task-1', branch: task.branch, worktreeDir: task.worktreeDir },
        { projectDir, epic: 'epic-1', testCmd: 'true' },
      );

      expect(await logged()).toEqual([]);
    });
  });
});

describe('batchStep', () => {
  let root: string;
  let originDir: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-queue-batch-'));
    originDir = path.join(root, 'origin.git');
    projectDir = path.join(root, 'project');

    git(root, ['init', '-q', '--bare', '-b', 'main', originDir]);
    git(root, ['clone', '-q', originDir, projectDir]);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    await writeFile(path.join(projectDir, 'a.txt'), 'a\n');
    await writeFile(path.join(projectDir, 'b.txt'), 'b\n');
    await writeFile(path.join(projectDir, 'c.txt'), 'c\n');
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-q', '-m', 'init']);
    git(projectDir, ['push', '-q', 'origin', 'main']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeTask(taskId: string, file: string, content: string) {
    const worktree = createTaskWorktree(projectDir, 'epic-1', taskId);
    writeFileSync(path.join(worktree.worktreeDir, file), content);
    git(worktree.worktreeDir, ['commit', '-q', '-am', `edit ${file}`]);
    return { taskId: `epic-1/${taskId}`, branch: worktree.branch, worktreeDir: worktree.worktreeDir };
  }

  it('lands three claim-disjoint tasks in admitted order with a single suite run', async () => {
    const a = makeTask('task-a', 'a.txt', 'a-edited\n');
    const b = makeTask('task-b', 'b.txt', 'b-edited\n');
    const c = makeTask('task-c', 'c.txt', 'c-edited\n');

    const result = await batchStep([a, b, c], { projectDir, epic: 'epic-1', testCmd: 'true' });

    expect(result.suiteRuns).toBe(1);
    expect(result.outcomes).toEqual([
      { outcome: 'merged', taskId: 'epic-1/task-a' },
      { outcome: 'merged', taskId: 'epic-1/task-b' },
      { outcome: 'merged', taskId: 'epic-1/task-c' },
    ]);

    // The first-parent chain is the mainline the batch built: three no-ff
    // merge commits, oldest (first admitted) closest to init.
    const subjects = git(projectDir, [
      'log',
      '--first-parent',
      '--format=%s',
      'smith/epic-1/integration',
    ])
      .split('\n')
      .reverse();
    expect(subjects).toEqual([
      'init',
      'Merge epic-1/task-a into smith/epic-1/integration',
      'Merge epic-1/task-b into smith/epic-1/integration',
      'Merge epic-1/task-c into smith/epic-1/integration',
    ]);
    expect(git(projectDir, ['show', 'smith/epic-1/integration:a.txt'])).toBe('a-edited');
    expect(git(projectDir, ['show', 'smith/epic-1/integration:b.txt'])).toBe('b-edited');
    expect(git(projectDir, ['show', 'smith/epic-1/integration:c.txt'])).toBe('c-edited');
    // No trace of the throwaway candidate worktree survives a green landing.
    expect(git(projectDir, ['worktree', 'list', '--porcelain'])).not.toMatch(/\.wt[\\/]project[\\/]batch-/);
  });

  it('logs one wave-merged per task, each carrying only that task’s own files', async () => {
    const stateDir = path.join(root, 'state');
    const sessionId = 'sess-batch';
    const rootEvent = await appendEvent(
      {
        session_id: sessionId,
        actor: 'system',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
    const events = {
      ctx: { sessionId, planVersion: 1, causalParent: rootEvent.event_id, actor: 'system' },
      stateDir,
    };

    const a = makeTask('task-a', 'a.txt', 'a-edited\n');
    const b = makeTask('task-b', 'b.txt', 'b-edited\n');

    await batchStep([a, b], { projectDir, epic: 'epic-1', testCmd: 'true', events });

    const all = await readEvents(sessionId, { stateDir });
    const logged = all
      .filter((e) => e.record.event_type !== 'session-start')
      .map((e) => ({
        type: e.record.event_type,
        taskId: e.record.task_id,
        payload: e.record.payload,
      }));
    expect(logged).toEqual([
      {
        type: 'wave-merged',
        taskId: 'epic-1/task-a',
        payload: { task_ids: ['epic-1/task-a'], files_changed: ['a.txt'] },
      },
      {
        type: 'wave-merged',
        taskId: 'epic-1/task-b',
        payload: { task_ids: ['epic-1/task-b'], files_changed: ['b.txt'] },
      },
    ]);
  });

  // B's file always fails the epic test command, whichever candidate it rides
  // in on. Zuul/Mergify's bisect (cited at groupForBatch): split, land the
  // innocent half, chase the guilty one down — rather than failing all three
  // for one task's sake. This is the spec's own worked example: suite_runs
  // must land exactly on 1 + 2*ceil(log2 3) = 5, not just under some bound.
  it('bisects a red candidate: lands the innocent tasks and fails only the guilty one', async () => {
    const a = makeTask('task-a', 'a.txt', 'a-edited\n');
    const b = makeTask('task-b', 'b.txt', 'BAD\n');
    const c = makeTask('task-c', 'c.txt', 'c-edited\n');

    const result = await batchStep([a, b, c], {
      projectDir,
      epic: 'epic-1',
      testCmd: '! grep -q BAD b.txt',
    });

    expect(result.outcomes).toEqual([
      { outcome: 'merged', taskId: 'epic-1/task-a' },
      { outcome: 'tests-failed', taskId: 'epic-1/task-b', outputTail: expect.any(String) },
      { outcome: 'merged', taskId: 'epic-1/task-c' },
    ]);
    expect(result.suiteRuns).toBe(1 + 2 * Math.ceil(Math.log2(3)));

    expect(git(projectDir, ['show', 'smith/epic-1/integration:a.txt'])).toBe('a-edited');
    expect(git(projectDir, ['show', 'smith/epic-1/integration:c.txt'])).toBe('c-edited');
    // task-b never landed — integration still has the original file.
    expect(git(projectDir, ['show', 'smith/epic-1/integration:b.txt'])).toBe('b');
  });

  // The rebase leaves every task's branch on top of the base the batch
  // started from, so a CAS failure at land time means integration moved
  // underneath the whole batch while the one shared suite run was in
  // flight — here the test command itself moves it, the same race
  // `step`'s "throws on a tree-less merge conflict" test drives for a single
  // task. A batch must not let that throw swallow the group: every ready
  // task reports `integration-moved` and nothing lands.
  it('reports integration-moved for every task when the ref moves mid-suite, without throwing', async () => {
    const a = makeTask('task-a', 'a.txt', 'a-edited\n');
    const b = makeTask('task-b', 'b.txt', 'b-edited\n');
    const integration = 'refs/heads/smith/epic-1/integration';
    const script = path.join(root, 'move-integration.sh');
    await writeFile(
      script,
      [
        'set -e',
        `cd ${JSON.stringify(projectDir)}`,
        `export GIT_INDEX_FILE=${JSON.stringify(path.join(root, 'side.index'))}`,
        `git read-tree ${integration}`,
        "blob=$(printf 'c-other\\n' | git hash-object -w --stdin)",
        'git update-index --cacheinfo 100644,$blob,c.txt',
        `c=$(git commit-tree $(git write-tree) -p ${integration} -m side)`,
        `git update-ref ${integration} $c`,
        '',
      ].join('\n'),
    );
    const before = git(projectDir, ['rev-parse', integration]);

    const result = await batchStep([a, b], {
      projectDir,
      epic: 'epic-1',
      testCmd: `sh ${JSON.stringify(script)}`,
    });

    const movedTo = git(projectDir, ['rev-parse', integration]);
    expect(result.outcomes).toEqual([
      { outcome: 'integration-moved', taskId: 'epic-1/task-a' },
      { outcome: 'integration-moved', taskId: 'epic-1/task-b' },
    ]);
    expect(result.suiteRuns).toBe(1);
    expect(movedTo).not.toBe(before);
    expect(git(projectDir, ['log', '-1', '--format=%s', movedTo])).toBe('side');
    expect(git(projectDir, ['worktree', 'list', '--porcelain'])).not.toMatch(/\.wt[\\/]project[\\/]batch-/);
  });
});

// D-137: `queue run` refuses to log a merge it did not make, which is right —
// but it left no other way to record one. `envkit-mcp-followup` was merged by
// hand, so its integration branch carried four landed tasks and its log carried
// zero `wave-merged` events, and `wave-merged` is the only event the projector
// folds to `completed`. The epic could not be closed by any honest means.
// `adopt` is the missing case: it does not trust the claim, it checks it.
describe('adopt', () => {
  let root: string;
  let originDir: string;
  let projectDir: string;
  let stateDir: string;
  const sessionId = 'sess-adopt';
  let events: { ctx: TaskEventContext; stateDir: string };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-adopt-'));
    originDir = path.join(root, 'origin.git');
    projectDir = path.join(root, 'project');
    stateDir = path.join(root, 'state');

    git(root, ['init', '-q', '--bare', '-b', 'main', originDir]);
    git(root, ['clone', '-q', originDir, projectDir]);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    await writeFile(path.join(projectDir, 'a.txt'), 'a\n');
    await writeFile(path.join(projectDir, 'b.txt'), 'b\n');
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-q', '-m', 'init']);
    git(projectDir, ['push', '-q', 'origin', 'main']);

    const rootEvent = await appendEvent(
      {
        session_id: sessionId,
        actor: 'system',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
    events = {
      ctx: { sessionId, planVersion: 1, causalParent: rootEvent.event_id, actor: 'system' },
      stateDir,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function logged(): Promise<{ type: string; taskId?: string; payload: unknown }[]> {
    const all = await readEvents(sessionId, { stateDir });
    return all
      .filter((e) => e.record.event_type !== 'session-start')
      .map((e) => ({
        type: e.record.event_type,
        ...(e.record.task_id ? { taskId: e.record.task_id } : {}),
        payload: e.record.payload,
      }));
  }

  /** The out-of-band merge this verb exists to adopt: no queue, no worktree. */
  function handMerge(branch: string, message: string): string {
    git(projectDir, ['checkout', '-q', 'smith/epic-1/integration']);
    git(projectDir, ['merge', '--no-ff', branch, '-m', message]);
    return git(projectDir, ['rev-parse', 'HEAD']);
  }

  function taskWithCommit(taskId: string, file: string, body: string): { branch: string } {
    const task = createTaskWorktree(projectDir, 'epic-1', taskId);
    writeFileSync(path.join(task.worktreeDir, file), body);
    git(task.worktreeDir, ['add', '.']);
    git(task.worktreeDir, ['commit', '-q', '-m', `edit ${file}`]);
    return { branch: task.branch };
  }

  // The payload has to be the queue's own, not a near-miss: the staleness
  // check reads `files_changed` and the projector reads `task_ids`, and both
  // are downstream of this being the same event `step` writes.
  it('logs wave-merged for a verified hand-merge, with the payload the queue writes', async () => {
    const task = taskWithCommit('task-1', 'a.txt', 'a-edited\n');
    const sha = handMerge(task.branch, 'hand-merged task-1');

    const result = await adopt(
      { taskId: 'epic-1/task-1', branch: task.branch },
      { projectDir, epic: 'epic-1', mergeCommit: sha, events },
    );

    expect(result).toEqual({
      outcome: 'adopted',
      taskId: 'epic-1/task-1',
      mergeCommit: sha,
      filesChanged: ['a.txt'],
    });
    expect(await logged()).toEqual([
      {
        type: 'wave-merged',
        taskId: 'epic-1/task-1',
        payload: { task_ids: ['epic-1/task-1'], files_changed: ['a.txt'] },
      },
    ]);
  });

  it('accepts an abbreviated sha and reports the full one it verified', async () => {
    const task = taskWithCommit('task-1', 'a.txt', 'a-edited\n');
    const sha = handMerge(task.branch, 'hand-merged task-1');

    const result = await adopt(
      { taskId: 'epic-1/task-1', branch: task.branch },
      { projectDir, epic: 'epic-1', mergeCommit: sha.slice(0, 8), events },
    );

    expect(result.mergeCommit).toBe(sha);
  });

  it('refuses a sha that names no commit in this repository', async () => {
    const task = taskWithCommit('task-1', 'a.txt', 'a-edited\n');
    handMerge(task.branch, 'hand-merged task-1');

    await expect(
      adopt(
        { taskId: 'epic-1/task-1', branch: task.branch },
        { projectDir, epic: 'epic-1', mergeCommit: 'deadbeef'.repeat(5), events },
      ),
    ).rejects.toMatchObject({ code: 'queue.adopt-unknown-commit' });
  });

  it('refuses a commit that is not a merge at all', async () => {
    const task = taskWithCommit('task-1', 'a.txt', 'a-edited\n');
    const sha = handMerge(task.branch, 'hand-merged task-1');
    // The task's own commit: on the integration branch, and still not a merge.
    const ordinary = git(projectDir, ['rev-parse', `${sha}^2`]);

    await expect(
      adopt(
        { taskId: 'epic-1/task-1', branch: task.branch },
        { projectDir, epic: 'epic-1', mergeCommit: ordinary, events },
      ),
    ).rejects.toMatchObject({ code: 'queue.adopt-not-a-merge' });
  });

  it('refuses a merge that never reached the integration branch', async () => {
    const task = taskWithCommit('task-1', 'a.txt', 'a-edited\n');
    git(projectDir, ['checkout', '-q', '-b', 'somewhere-else', 'main']);
    git(projectDir, ['merge', '--no-ff', task.branch, '-m', 'merged somewhere else']);
    const sha = git(projectDir, ['rev-parse', 'HEAD']);

    await expect(
      adopt(
        { taskId: 'epic-1/task-1', branch: task.branch },
        { projectDir, epic: 'epic-1', mergeCommit: sha, events },
      ),
    ).rejects.toMatchObject({ code: 'queue.adopt-not-on-integration' });
  });

  it("refuses a merge that did not bring in this task's branch", async () => {
    const one = taskWithCommit('task-1', 'a.txt', 'a-edited\n');
    const two = taskWithCommit('task-2', 'b.txt', 'b-edited\n');
    const sha = handMerge(one.branch, 'hand-merged task-1');

    await expect(
      adopt(
        { taskId: 'epic-1/task-2', branch: two.branch },
        { projectDir, epic: 'epic-1', mergeCommit: sha, events },
      ),
    ).rejects.toMatchObject({ code: 'queue.adopt-branch-not-merged' });
  });

  // The strict form: the branch head must be a parent, not merely an ancestor.
  // A branch that grew after the hand-merge did not land what it now carries,
  // and adopting it would mark work completed that is not on integration.
  it('refuses when the branch has moved on since the merge', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    writeFileSync(path.join(task.worktreeDir, 'a.txt'), 'a-edited\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a']);
    const sha = handMerge(task.branch, 'hand-merged task-1');
    writeFileSync(path.join(task.worktreeDir, 'a.txt'), 'a-edited-again\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit a again']);

    await expect(
      adopt(
        { taskId: 'epic-1/task-1', branch: task.branch },
        { projectDir, epic: 'epic-1', mergeCommit: sha, events },
      ),
    ).rejects.toMatchObject({ code: 'queue.adopt-branch-not-merged' });
  });

  // D-30, restated for the merge commit: a branch cut and never committed to
  // is the first parent of every merge made after it, so "is a parent" alone
  // would adopt a task that landed nothing.
  it('refuses a branch that carries no commit the merge could have landed (D-30)', async () => {
    const empty = createTaskWorktree(projectDir, 'epic-1', 'task-3');
    const one = taskWithCommit('task-1', 'a.txt', 'a-edited\n');
    const sha = handMerge(one.branch, 'hand-merged task-1');
    expect(git(projectDir, ['rev-parse', `${sha}^1`])).toBe(
      git(projectDir, ['rev-parse', empty.branch]),
    );

    await expect(
      adopt(
        { taskId: 'epic-1/task-3', branch: empty.branch },
        { projectDir, epic: 'epic-1', mergeCommit: sha, events },
      ),
    ).rejects.toMatchObject({ code: 'queue.adopt-nothing-landed' });
  });

  it('refuses a branch that does not exist', async () => {
    const task = taskWithCommit('task-1', 'a.txt', 'a-edited\n');
    const sha = handMerge(task.branch, 'hand-merged task-1');

    await expect(
      adopt(
        { taskId: 'epic-1/task-9', branch: 'smith/epic-1/task-9' },
        { projectDir, epic: 'epic-1', mergeCommit: sha, events },
      ),
    ).rejects.toMatchObject({ code: 'queue.adopt-unknown-branch' });
  });

  // Refusals throw and write nothing on purpose. A non-coordination
  // `error-logged` folds the task to `blocked` (db/projector.ts), and a task
  // whose adopt claim was mistyped is not blocked — logging one would put a
  // wrong status in the table to record a wrong command line.
  it('writes no event at all when it refuses', async () => {
    const task = taskWithCommit('task-1', 'a.txt', 'a-edited\n');
    handMerge(task.branch, 'hand-merged task-1');

    await expect(
      adopt(
        { taskId: 'epic-1/task-1', branch: task.branch },
        { projectDir, epic: 'epic-1', mergeCommit: 'deadbeef'.repeat(5), events },
      ),
    ).rejects.toThrow(QueueError);

    expect(await logged()).toEqual([]);
  });

  it('verifies without logging when no event context is supplied', async () => {
    const task = taskWithCommit('task-1', 'a.txt', 'a-edited\n');
    const sha = handMerge(task.branch, 'hand-merged task-1');

    const result = await adopt(
      { taskId: 'epic-1/task-1', branch: task.branch },
      { projectDir, epic: 'epic-1', mergeCommit: sha },
    );

    expect(result.outcome).toBe('adopted');
    expect(await logged()).toEqual([]);
  });
});

describe('step with test selection', () => {
  let root: string;
  let originDir: string;
  let projectDir: string;

  /** Records the files the test command was handed, one per line. */
  const RECORD = 'printf "%s\\n" {files} > selected.txt';

  async function selectedFiles(worktreeDir: string): Promise<string[]> {
    const raw = await readFile(path.join(worktreeDir, 'selected.txt'), 'utf8');
    return raw.split('\n').filter((line) => line.length > 0);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-select-'));
    originDir = path.join(root, 'origin.git');
    projectDir = path.join(root, 'project');

    git(root, ['init', '-q', '--bare', '-b', 'main', originDir]);
    git(root, ['clone', '-q', originDir, projectDir]);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    await mkdir(path.join(projectDir, 'src'), { recursive: true });
    await mkdir(path.join(projectDir, 'test'), { recursive: true });
    await writeFile(path.join(projectDir, 'src/alpha.ts'), 'export const alpha = 1;\n');
    await writeFile(path.join(projectDir, 'src/beta.ts'), 'export const beta = 2;\n');
    await writeFile(
      path.join(projectDir, 'test/alpha.test.ts'),
      "import { alpha } from '../src/alpha.js';\nexport const a = alpha;\n",
    );
    await writeFile(
      path.join(projectDir, 'test/beta.test.ts'),
      "import { beta } from '../src/beta.js';\nexport const b = beta;\n",
    );
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-q', '-m', 'init']);
    git(projectDir, ['push', '-q', 'origin', 'main']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs only the tests that can reach the task diff', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'src/beta.ts'), 'export const beta = 3;\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit beta']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'false', selectTestCmd: RECORD },
    );

    expect(result.outcome).toBe('merged');
    expect(result.tests).toEqual({
      mode: 'selected',
      ran: ['test/beta.test.ts'],
      known: 2,
    });
    expect(await selectedFiles(task.worktreeDir)).toEqual(['test/beta.test.ts']);
  });

  it('falls back to the full command when the diff touches a non-source file', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'src/beta.ts'), 'export const beta = 3;\n');
    await writeFile(path.join(task.worktreeDir, 'config.yml'), 'k: v\n');
    git(task.worktreeDir, ['add', '.']);
    git(task.worktreeDir, ['commit', '-q', '-m', 'edit beta and config']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true', selectTestCmd: RECORD },
    );

    expect(result.outcome).toBe('merged');
    expect(result.tests?.mode).toBe('full');
    expect((result.tests?.reasons ?? []).join(' ')).toContain('config.yml');
    expect(existsSync(path.join(task.worktreeDir, 'selected.txt'))).toBe(false);
  });

  it('reports nothing at all when no selection was asked for', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'src/beta.ts'), 'export const beta = 3;\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit beta']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true' },
    );

    // `tests` present means selection ran. Absent means it was never asked for,
    // which is the shape every result had before selection existed.
    expect(result).toEqual({ outcome: 'merged', taskId: 'task-1' });
  });

  it('still blocks the merge when a selected test fails', async () => {
    const task = createTaskWorktree(projectDir, 'epic-1', 'task-1');
    await writeFile(path.join(task.worktreeDir, 'src/beta.ts'), 'export const beta = 3;\n');
    git(task.worktreeDir, ['commit', '-q', '-am', 'edit beta']);

    const result = await step(
      { taskId: 'task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      { projectDir, epic: 'epic-1', testCmd: 'true', selectTestCmd: 'false # {files}' },
    );

    expect(result.outcome).toBe('tests-failed');
    const log = git(projectDir, ['log', 'smith/epic-1/integration', '--oneline']);
    expect(log).not.toContain('edit beta');
  });
});
