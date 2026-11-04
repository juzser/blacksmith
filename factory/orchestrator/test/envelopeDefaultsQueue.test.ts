import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, taskStatusFixtures } from './helpers/cliHarness.js';
import { git, runOrThrow } from './helpers/process.js';

// D-42 again, through the optional envelope: `queue run` merges git branches
// and only then appends `wave-merged`. A defaulted parent that the append
// refuses (fan-out) would leave a merge the log cannot see, so the refusal
// must come in the pre-flight, before any git write.

describe('queue run with a defaulted --causal-parent', () => {
  let scratchDir: string;
  beforeAll(async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), 'smith-envq-'));
  });
  afterAll(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });
  const { PLAN } = taskStatusFixtures(() => scratchDir);

  it('refuses an ambiguous default before any branch moves', async () => {
    const originDir = path.join(scratchDir, 'origin.git');
    const projectDir = path.join(scratchDir, 'project');
    runOrThrow('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
    runOrThrow('git', ['clone', '-q', originDir, projectDir]);
    runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
    runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
    await writeFile(path.join(projectDir, 'seed.txt'), 'seed\n');
    runOrThrow('git', ['add', '.'], { cwd: projectDir });
    runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
    runOrThrow('git', ['push', '-q', 'origin', 'main'], { cwd: projectDir });

    const created = runCli(['worktree', 'create', projectDir, 'epic-1', 'task-1']);
    expect(created.status).toBe(0);
    const { worktreeDir, branch } = JSON.parse(created.stdout);
    await writeFile(path.join(worktreeDir, 'task-1.txt'), 'task-1\n');
    runOrThrow('git', ['add', '.'], { cwd: worktreeDir });
    runOrThrow('git', ['commit', '-q', '-m', 'add task-1'], { cwd: worktreeDir });
    const mainBefore = git(projectDir, ['rev-parse', 'main']).trim();
    const branchBefore = git(projectDir, ['rev-parse', branch]).trim();
    // `worktree create` already made the integration branch; the merge would move it.
    const integrationBefore = git(projectDir, ['rev-parse', 'bs/epic-1/integration']).trim();

    const stateDir = path.join(scratchDir, 'events');
    await mkdir(stateDir, { recursive: true });
    const dispatch = (task: string, i: number) => ({
      session_id: 'q',
      actor: 'orchestrator',
      event_type: 'dispatch_decision',
      task_id: task,
      plan_version: 1,
      causal_parent: 'q#0',
      ts: `2026-11-04T00:00:0${i}.000Z`,
      payload: {
        agent_role: 'coder',
        provider: 'claude',
        model_tier: 'mid',
        model: 'claude-sonnet-5',
      },
    });
    const root = {
      session_id: 'q',
      actor: 'operator',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      ts: '2026-11-04T00:00:00.000Z',
      payload: {},
    };
    await writeFile(
      path.join(stateDir, 'q.jsonl'),
      `${[root, dispatch('epic-1/task-1', 1), dispatch('epic-1/task-2', 2)]
        .map((l) => JSON.stringify(l))
        .join('\n')}\n`,
    );
    const planPath = path.join(scratchDir, 'plan.json');
    await writeFile(planPath, JSON.stringify(PLAN));
    const tasksPath = path.join(scratchDir, 'tasks.json');
    await writeFile(tasksPath, JSON.stringify([{ taskId: 'task-1', branch, worktreeDir }]));

    const run = runCli(
      [
        'queue',
        'run',
        'epic-1',
        '--project',
        projectDir,
        '--test-cmd',
        'true',
        '--tasks',
        tasksPath,
        '--plan',
        planPath,
        '--session',
        'q',
        '--state-dir',
        stateDir,
      ],
      { CLAUDE_CODE_SESSION_ID: '' },
    );
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).error.code).toBe('cli.envelope-parent-ambiguous');
    // Nothing moved: main and the task branch are where they were, and no integration branch exists.
    expect(git(projectDir, ['rev-parse', 'main']).trim()).toBe(mainBefore);
    expect(git(projectDir, ['rev-parse', branch]).trim()).toBe(branchBefore);
    expect(git(projectDir, ['rev-parse', 'bs/epic-1/integration']).trim()).toBe(integrationBefore);
  });
});
