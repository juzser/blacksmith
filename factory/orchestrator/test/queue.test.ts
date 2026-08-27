import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import { admit, adopt, QueueError, step } from '../src/queue.js';
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
