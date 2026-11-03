import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import {
  adopt,
  batchStep,
  QueueError,
  type QueueTask,
  resolveQueueChecks,
  type StepOptions,
  step,
} from '../src/queue.js';
import type { TaskEventContext } from '../src/taskEvents.js';
import type { CheckCommand } from '../src/testgate.js';
import { createTaskWorktree } from '../src/worktree.js';
import { runCli } from './helpers/cliHarness.js';
import { git as runGitFixture } from './helpers/process.js';

// Epic bs-check-tiers task-4: `queue run --checks`. An unlabelled or empty file
// keeps today's commands; a file declaring a later tier makes the pre-merge
// tier the pre-landing test. Commands in the fixtures append their own name to
// a log file, so what ran is read off the log, never inferred.

const EPIC = 'epic-1';
const INTEGRATION = `bs/${EPIC}/integration`;
const SHA40 = /^[0-9a-f]{40}$/;

function git(cwd: string, args: string[]): string {
  return runGitFixture(cwd, args).trim();
}

interface Logged {
  type: string;
  taskId?: string;
  payload: Record<string, unknown>;
}

describe('queue --checks', () => {
  let root: string;
  let projectDir: string;
  let stateDir: string;
  let logFile: string;
  const sessionId = 'sess-tier';
  let events: { ctx: TaskEventContext; stateDir: string };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-queue-tier-'));
    projectDir = path.join(root, 'project');
    stateDir = path.join(root, 'state');
    logFile = path.join(root, 'ran.log');
    writeFileSync(logFile, '');
    const originDir = path.join(root, 'origin.git');
    git(root, ['init', '-q', '--bare', '-b', 'main', originDir]);
    git(root, ['clone', '-q', originDir, projectDir]);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeFile(path.join(projectDir, name), `${name}\n`);
    }
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

  function makeTask(name: string, file: string, text: string): QueueTask {
    const wt = createTaskWorktree(projectDir, EPIC, name);
    writeFileSync(path.join(wt.worktreeDir, file), text);
    git(wt.worktreeDir, ['commit', '-q', '-am', `edit ${file}`]);
    return { taskId: `${EPIC}/${name}`, branch: wt.branch, worktreeDir: wt.worktreeDir };
  }

  /** A command that records `name` in the log, then exits `code`, printing `out` first. */
  function logging(name: string, code = 0, out = ''): string {
    const file = path.join(root, `${name}.sh`);
    writeFileSync(
      file,
      `${out ? `echo '${out}'\n` : ''}echo '${name}' >> '${logFile}'\nexit ${code}\n`,
    );
    chmodSync(file, 0o755);
    return `sh '${file}'`;
  }

  const ran = (): string[] => readFileSync(logFile, 'utf8').split('\n').filter(Boolean);

  async function logged(): Promise<Logged[]> {
    const all = await readEvents(sessionId, { stateDir });
    return all
      .filter((e) => e.record.event_type !== 'session-start')
      .map((e) => ({
        type: e.record.event_type,
        ...(e.record.task_id ? { taskId: e.record.task_id } : {}),
        payload: e.record.payload as Record<string, unknown>,
      }));
  }

  const ofType = (all: Logged[], type: string): Logged[] => all.filter((e) => e.type === type);

  const stepOpts = (extra: Partial<StepOptions> = {}): StepOptions => ({
    projectDir,
    epic: EPIC,
    testCmd: logging('test-cmd'),
    events,
    ...extra,
  });

  const tiered = (names: Array<[string, CheckCommand['tier'], string?]>): CheckCommand[] =>
    names.map(([name, tier, cmd]) => ({
      name,
      cmd: cmd ?? logging(name),
      ...(tier ? { tier } : {}),
    }));

  describe('resolveQueueChecks', () => {
    it('keeps the test command for an unlabelled file and for an empty one', () => {
      expect(resolveQueueChecks([])).toEqual({ preLanding: 'test-cmd' });
      expect(
        resolveQueueChecks([
          { name: 'a', cmd: 'true' },
          { name: 'b', cmd: 'true', tier: 'pre-merge' },
        ]),
      ).toEqual({ preLanding: 'test-cmd' });
    });

    it('selects the pre-merge tier once a later tier exists', () => {
      const a = { name: 'A', cmd: 'true' };
      const b = { name: 'B', cmd: 'true', tier: 'post-merge' as const };
      expect(resolveQueueChecks([a, b])).toEqual({ preLanding: 'pre-merge-tier', preMerge: [a] });
    });

    it('refuses a tiered file with no pre-merge entry', () => {
      const attempt = () => resolveQueueChecks([{ name: 'B', cmd: 'true', tier: 'pre-release' }]);
      expect(attempt).toThrow(QueueError);
      expect(attempt).toThrow(/no-pre-merge-checks|no pre-merge/i);
      try {
        attempt();
      } catch (err) {
        expect((err as QueueError).code).toBe('queue.no-pre-merge-checks');
      }
    });
  });

  describe('an unlabelled or empty file', () => {
    for (const [label, file] of [
      ['unlabelled', [{ name: 'A', cmd: 'true' }]],
      ['empty', []],
    ] as Array<[string, CheckCommand[]]>) {
      it(`runs --test-cmd and --select-test-cmd as without --checks (${label})`, async () => {
        const select = `${logging('select')} {files}`;
        const plain = makeTask('task-1', 'a.txt', 'a-1\n');
        await step(plain, stepOpts({ selectTestCmd: select }));
        const baselineRan = ran();
        writeFileSync(logFile, '');
        // A second epic cut from the same main: same task, same command, only --checks differs.
        const wt = createTaskWorktree(projectDir, 'epic-2', 'other-1');
        writeFileSync(path.join(wt.worktreeDir, 'a.txt'), 'a-1\n');
        git(wt.worktreeDir, ['commit', '-q', '-am', 'edit a.txt']);
        await step(
          { taskId: 'epic-2/other-1', branch: wt.branch, worktreeDir: wt.worktreeDir },
          stepOpts({ epic: 'epic-2', selectTestCmd: select, checks: resolveQueueChecks(file) }),
        );
        const all = await logged();
        const baseline = all.filter((e) => e.taskId === plain.taskId);
        const withChecks = all.filter((e) => e.taskId === 'epic-2/other-1');

        expect(baselineRan.length).toBeGreaterThan(0);
        expect(ran()).toEqual(baselineRan);
        expect(withChecks.map((e) => e.type)).toEqual(baseline.map((e) => e.type));
        const strip = (e: Logged) => {
          const { merge_sha, task_ids, ...rest } = e.payload;
          return {
            ...rest,
            sha: SHA40.test(String(merge_sha)),
            ids: (task_ids as string[]).length,
          };
        };
        const { pre_landing, ...withoutField } = (withChecks[0] as Logged).payload;
        expect(pre_landing).toBe('test-cmd');
        expect(strip({ ...(withChecks[0] as Logged), payload: withoutField })).toEqual(
          strip(baseline[0] as Logged),
        );
        expect((baseline[0] as Logged).payload.pre_landing).toBeUndefined();
        expect('pre_landing' in (baseline[0] as Logged).payload).toBe(false);
        expect(strip(baseline[0] as Logged).sha).toBe(true);
      });
    }
  });

  describe('a tiered file, sequential', () => {
    it('runs the pre-merge tier only and records one queue-tier-run before the landing', async () => {
      const task = makeTask('task-1', 'a.txt', 'a-1\n');
      const checks = resolveQueueChecks(
        tiered([
          ['A', undefined],
          ['B', 'post-merge'],
        ]),
      );
      const outcome = await step(task, stepOpts({ checks }));

      expect(outcome.outcome).toBe('merged');
      expect(ran()).toEqual(['A']);
      const all = await logged();
      const merged = ofType(all, 'wave-merged');
      expect(merged).toHaveLength(1);
      const landing = (merged[0] as Logged).payload;
      expect(landing.pre_landing).toBe('pre-merge-tier');
      expect(landing.test_cmd_not_run).toBe(true);
      expect(landing.select_test_cmd_not_run).toBeUndefined();
      const runs = ofType(all, 'queue-tier-run').filter(
        (e) => e.payload.run_id === landing.pre_landing_run_id,
      );
      expect(runs).toHaveLength(1);
      const run = runs[0] as Logged;
      expect(all.indexOf(run)).toBeLessThan(all.indexOf(merged[0] as Logged));
      expect(run.taskId).toBe(`${EPIC}/integration`);
      expect(run.payload).toMatchObject({
        epic_id: EPIC,
        task_ids: [task.taskId],
        mode: 'step',
        pass: true,
      });
      expect(run.payload.tree_sha).toMatch(SHA40);
      const results = run.payload.results as Array<Record<string, unknown>>;
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ name: 'A', pass: true });
      expect(results[0]?.cmd_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(results[0]?.check_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(results.every((r) => !('environment' in r))).toBe(true);
      const environment = run.payload.environment as Array<{ name: string }>;
      expect(environment).toHaveLength(1);
      expect(environment[0]?.name).toBe('A');
    });

    it('blocks exactly as a red --test-cmd does, naming the check and its tail', async () => {
      const task = makeTask('task-1', 'a.txt', 'a-1\n');
      const before = git(projectDir, ['rev-parse', INTEGRATION]);
      const checks = resolveQueueChecks(
        tiered([
          ['A', undefined, logging('A', 1, 'boom-tail')],
          ['B', 'post-merge'],
        ]),
      );
      const outcome = await step(task, stepOpts({ checks }));

      expect(outcome.outcome).toBe('tests-failed');
      expect(git(projectDir, ['rev-parse', INTEGRATION])).toBe(before);
      expect(ran()).toEqual(['A']);
      const all = await logged();
      expect(ofType(all, 'wave-merged')).toHaveLength(0);
      const blocked = ofType(all, 'error-logged');
      expect(blocked).toHaveLength(1);
      const payload = (blocked[0] as Logged).payload;
      expect(payload.error).toBe('execution.test-failure');
      expect(String(payload.detail)).toContain('A');
      expect(String(payload.detail)).toContain('boom-tail');
      expect(payload.pre_landing).toBe('pre-merge-tier');
      expect('run_id' in payload).toBe(false);
      const runs = ofType(all, 'queue-tier-run').filter(
        (e) => e.payload.run_id === payload.pre_landing_run_id,
      );
      expect(runs).toHaveLength(1);
      const run = runs[0] as Logged;
      expect(all.indexOf(run)).toBeLessThan(all.indexOf(blocked[0] as Logged));
      expect(run.payload.pass).toBe(false);
      expect((run.payload.results as Array<{ name: string; pass: boolean }>)[0]).toMatchObject({
        name: 'A',
        pass: false,
      });
      expect((run.payload.environment as Array<{ name: string }>)[0]?.name).toBe('A');
    });

    it('says select_test_cmd_not_run when --select-test-cmd was given, and runs neither command', async () => {
      const task = makeTask('task-1', 'a.txt', 'a-1\n');
      const checks = resolveQueueChecks(
        tiered([
          ['A', undefined],
          ['B', 'post-merge'],
        ]),
      );
      const outcome = await step(
        task,
        stepOpts({ checks, selectTestCmd: `${logging('select')} {files}` }),
      );

      expect(outcome.outcome).toBe('merged');
      expect(ran()).toEqual(['A']);
      const landing = (ofType(await logged(), 'wave-merged')[0] as Logged).payload;
      expect(landing.test_cmd_not_run).toBe(true);
      expect(landing.select_test_cmd_not_run).toBe(true);
    });
  });

  describe('a tiered file, --batch', () => {
    function threeTasks(bad?: 'task-3'): QueueTask[] {
      return [
        makeTask('task-1', 'a.txt', 'a-1\n'),
        makeTask('task-2', 'b.txt', 'b-1\n'),
        makeTask('task-3', 'c.txt', bad ? 'BAD\n' : 'c-1\n'),
      ];
    }
    const noBad = 'if grep -rq BAD --include="*.txt" .; then echo bad-found; exit 1; fi';

    it('tests the candidate once and every landing names that run', async () => {
      const tasks = threeTasks();
      const checks = resolveQueueChecks(
        tiered([
          ['A', undefined],
          ['B', 'post-merge'],
        ]),
      );
      const result = await batchStep(tasks, stepOpts({ checks }));

      expect(result.outcomes.every((o) => o.outcome === 'merged')).toBe(true);
      expect(result.suiteRuns).toBe(1);
      expect(ran()).toEqual(['A']);
      const all = await logged();
      const runs = ofType(all, 'queue-tier-run');
      expect(runs).toHaveLength(1);
      expect((runs[0] as Logged).payload).toMatchObject({
        mode: 'batch',
        task_ids: tasks.map((t) => t.taskId),
        pass: true,
      });
      const merged = ofType(all, 'wave-merged');
      expect(merged).toHaveLength(3);
      for (const m of merged) {
        expect(m.payload.pre_landing).toBe('pre-merge-tier');
        expect(m.payload.pre_landing_run_id).toBe((runs[0] as Logged).payload.run_id);
        expect('run_id' in m.payload).toBe(false);
      }
    });

    it('writes one queue-tier-run per tier run when a red candidate bisects', async () => {
      const tasks = threeTasks('task-3');
      const checks = resolveQueueChecks(
        tiered([
          ['A', undefined, noBad],
          ['B', 'post-merge'],
        ]),
      );
      const result = await batchStep(tasks, stepOpts({ checks }));

      expect(result.outcomes.map((o) => o.outcome)).toEqual(['merged', 'merged', 'tests-failed']);
      const all = await logged();
      const runs = ofType(all, 'queue-tier-run');
      expect(runs).toHaveLength(result.suiteRuns);
      expect(result.suiteRuns).toBe(3);
      const byIds = (ids: string[]) =>
        runs.find((r) => JSON.stringify(r.payload.task_ids) === JSON.stringify(ids)) as Logged;
      const red = byIds(tasks.map((t) => t.taskId));
      const left = byIds([tasks[0]?.taskId as string, tasks[1]?.taskId as string]);
      const right = byIds([tasks[2]?.taskId as string]);
      expect([red.payload.pass, left.payload.pass, right.payload.pass]).toEqual([
        false,
        true,
        false,
      ]);
      const merged = ofType(all, 'wave-merged');
      expect(merged).toHaveLength(2);
      for (const m of merged) expect(m.payload.pre_landing_run_id).toBe(left.payload.run_id);
      const blocked = ofType(all, 'error-logged');
      expect(blocked).toHaveLength(1);
      expect((blocked[0] as Logged).payload.pre_landing_run_id).toBe(right.payload.run_id);
      for (const e of [...merged, ...blocked]) expect('run_id' in e.payload).toBe(false);
      for (const r of runs) {
        expect(all.indexOf(r)).toBeLessThan(
          Math.max(...[...merged, ...blocked].map((e) => all.indexOf(e))),
        );
      }
    });
  });

  describe('events of a run without --checks', () => {
    const keys = (e: Logged) => Object.keys(e.payload).sort();

    it('adds merge_sha to a sequential wave-merged and nothing else', async () => {
      const task = makeTask('task-1', 'a.txt', 'a-1\n');
      await step(task, stepOpts());
      const all = await logged();
      expect(all.map((e) => e.type)).toEqual(['wave-merged']);
      expect(keys(all[0] as Logged)).toEqual(['files_changed', 'merge_sha', 'task_ids']);
      expect(all[0]?.payload.task_ids).toEqual([task.taskId]);
      expect(all[0]?.payload.files_changed).toEqual(['a.txt']);
    });

    it('adds merge_sha to every --batch wave-merged and nothing else', async () => {
      const tasks = [makeTask('task-1', 'a.txt', 'a-1\n'), makeTask('task-2', 'b.txt', 'b-1\n')];
      await batchStep(tasks, stepOpts());
      const all = await logged();
      expect(all.map((e) => e.type)).toEqual(['wave-merged', 'wave-merged']);
      for (const e of all) expect(keys(e)).toEqual(['files_changed', 'merge_sha', 'task_ids']);
    });

    it('adds merge_sha to an adopt wave-merged and nothing else', async () => {
      const task = makeTask('task-1', 'a.txt', 'a-1\n');
      git(projectDir, ['checkout', '-q', INTEGRATION]);
      git(projectDir, ['merge', '--no-ff', task.branch, '-m', 'hand-merged']);
      const sha = git(projectDir, ['rev-parse', 'HEAD']);
      await adopt(
        { taskId: task.taskId, branch: task.branch },
        { projectDir, epic: EPIC, mergeCommit: sha, events },
      );
      const all = await logged();
      expect(all.map((e) => e.type)).toEqual(['wave-merged']);
      expect(keys(all[0] as Logged)).toEqual(['files_changed', 'merge_sha', 'task_ids']);
      expect(all[0]?.payload.merge_sha).toBe(sha);
    });

    it('writes the base error-logged for a red --test-cmd and no tier event', async () => {
      const task = makeTask('task-1', 'a.txt', 'a-1\n');
      await step(task, stepOpts({ testCmd: logging('red', 1, 'red-tail') }));
      const all = await logged();
      expect(all.map((e) => e.type)).toEqual(['error-logged']);
      expect(keys(all[0] as Logged)).toEqual(['detail', 'error', 'severity', 'task_ref']);
      expect(String(all[0]?.payload.detail)).toContain('red-tail');
    });
  });

  describe('merge_sha', () => {
    const firstParent = (): string[] =>
      git(projectDir, ['rev-list', '--first-parent', INTEGRATION]).split('\n');
    const secondParent = (sha: string): string => git(projectDir, ['rev-parse', `${sha}^2`]);

    for (const withChecks of [false, true]) {
      const label = withChecks ? 'with a tiered --checks' : 'without --checks';

      it(`is the merge commit stepUnderLock landed (${label})`, async () => {
        const task = makeTask('task-1', 'a.txt', 'a-1\n');
        const checks = resolveQueueChecks(
          tiered([
            ['A', undefined],
            ['B', 'post-merge'],
          ]),
        );
        await step(task, stepOpts(withChecks ? { checks } : {}));
        const sha = (ofType(await logged(), 'wave-merged')[0] as Logged).payload.merge_sha;
        expect(sha).toMatch(SHA40);
        expect(sha).toBe(git(projectDir, ['rev-parse', INTEGRATION]));
        expect(secondParent(sha as string)).toBe(git(projectDir, ['rev-parse', task.branch]));
      });

      it(`is the merge commit made in the worktree holding the branch (${label})`, async () => {
        const task = makeTask('task-1', 'a.txt', 'a-1\n');
        const holder = path.join(root, 'holder');
        git(projectDir, ['worktree', 'add', '-q', holder, INTEGRATION]);
        const checks = resolveQueueChecks(
          tiered([
            ['A', undefined],
            ['B', 'post-merge'],
          ]),
        );
        await step(task, stepOpts(withChecks ? { checks } : {}));
        const sha = (ofType(await logged(), 'wave-merged')[0] as Logged).payload.merge_sha;
        expect(sha).toMatch(SHA40);
        expect(sha).toBe(git(holder, ['rev-parse', 'HEAD']));
        expect(secondParent(sha as string)).toBe(git(projectDir, ['rev-parse', task.branch]));
      });

      it(`is each task's own fold commit in attemptCandidate (${label})`, async () => {
        const tasks = [makeTask('task-1', 'a.txt', 'a-1\n'), makeTask('task-2', 'b.txt', 'b-1\n')];
        const checks = resolveQueueChecks(
          tiered([
            ['A', undefined],
            ['B', 'post-merge'],
          ]),
        );
        await batchStep(tasks, stepOpts(withChecks ? { checks } : {}));
        const merged = ofType(await logged(), 'wave-merged');
        expect(merged).toHaveLength(2);
        const chain = firstParent();
        for (const [i, m] of merged.entries()) {
          const sha = m.payload.merge_sha as string;
          expect(sha).toMatch(SHA40);
          expect(chain).toContain(sha);
          expect(secondParent(sha)).toBe(
            git(projectDir, ['rev-parse', (tasks[i] as QueueTask).branch]),
          );
        }
        expect(merged[0]?.payload.merge_sha).not.toBe(merged[1]?.payload.merge_sha);
      });
    }
  });

  describe('heavy re-entry', () => {
    // The heavy check fails unless its own lock ran in the queue's lock dir,
    // so a tier run handed no heavyLock (the default machine dir) fails too.
    const heavyChecks = (lockDir: string): CheckCommand[] =>
      tiered([
        ['unit', undefined, `${logging('unit')} && test "$BS_HEAVY_LOCK_DIR" = "${lockDir}"`],
        ['test-e2e', 'post-merge'],
      ]);

    async function expectReentered(): Promise<void> {
      const all = await logged();
      const run = ofType(all, 'queue-tier-run')[0] as Logged;
      const unit = (run.payload.results as Array<Record<string, unknown>>)[0] as {
        name: string;
        pass: boolean;
        lock_wait_ms: number;
        reason?: string;
      };
      expect(unit.name).toBe('unit');
      expect(unit.reason).not.toBe('heavy.wait-timeout');
      expect(unit.pass).toBe(true);
      expect(unit.lock_wait_ms).toBeLessThan(2000);
      expect(ofType(all, 'wave-merged').length).toBeGreaterThan(0);
    }

    it('lets a heavy check re-enter the lease step holds', async () => {
      const lockDir = path.join(root, 'locks');
      const task = makeTask('task-1', 'a.txt', 'a-1\n');
      const checks = resolveQueueChecks(heavyChecks(lockDir));
      const outcome = await step(
        task,
        stepOpts({ checks, heavyLock: { lockDir, maxWaitMs: 2000 } }),
      );
      await expectReentered();
      expect(outcome.outcome).toBe('merged');
      expect(existsSync(path.join(lockDir, 'heavy.lock'))).toBe(false);
    });

    it('lets a heavy check re-enter the lease a --batch candidate takes', async () => {
      const lockDir = path.join(root, 'locks');
      const tasks = [makeTask('task-1', 'a.txt', 'a-1\n'), makeTask('task-2', 'b.txt', 'b-1\n')];
      const checks = resolveQueueChecks(heavyChecks(lockDir));
      const result = await batchStep(
        tasks,
        stepOpts({ checks, heavyLock: { lockDir, maxWaitMs: 2000 } }),
      );
      await expectReentered();
      expect(result.outcomes.every((o) => o.outcome === 'merged')).toBe(true);
      expect(
        existsSync(lockDir) ? readdirSync(lockDir).filter((f) => f === 'heavy.lock') : [],
      ).toEqual([]);
    });
  });

  describe('queue run --checks (built binary)', () => {
    async function cliRun(
      file: unknown,
      extra: string[] = [],
    ): Promise<{ stdout: string; status: number }> {
      const task = makeTask('task-1', 'a.txt', 'a-1\n');
      const checksFile = path.join(root, 'checks.json');
      writeFileSync(checksFile, JSON.stringify(file));
      const tasksFile = path.join(root, 'tasks.json');
      writeFileSync(tasksFile, JSON.stringify([task]));
      const planFile = path.join(root, 'plan.json');
      writeFileSync(
        planFile,
        JSON.stringify({
          epic_id: EPIC,
          version: 1,
          status: 'active',
          tasks: [{ task_id: task.taskId, claims: ['a.txt'] }],
          edges: [],
        }),
      );
      const { stdout, status } = runCli([
        'queue',
        'run',
        EPIC,
        '--project',
        projectDir,
        '--tasks',
        tasksFile,
        '--test-cmd',
        logging('test-cmd'),
        '--checks',
        checksFile,
        '--session',
        sessionId,
        '--causal-parent',
        events.ctx.causalParent as string,
        '--plan',
        planFile,
        '--state-dir',
        stateDir,
        ...extra,
      ]);
      return { stdout, status };
    }

    it('refuses a tiered file with no pre-merge entry and lands nothing', async () => {
      const before = git(projectDir, ['rev-parse', 'main']);
      const { stdout, status } = await cliRun([{ name: 'B', cmd: 'true', tier: 'post-merge' }]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('queue.no-pre-merge-checks');
      expect(git(projectDir, ['rev-parse', 'main'])).toBe(before);
      expect(ofType(await logged(), 'wave-merged')).toHaveLength(0);
    });

    it('accepts --select-test-cmd beside a tiered file and says neither command ran', async () => {
      const file = tiered([
        ['A', undefined],
        ['B', 'post-merge'],
      ]);
      const { stdout, status } = await cliRun(file, [
        '--select-test-cmd',
        `${logging('select')} {files}`,
      ]);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)[0].outcome).toBe('merged');
      expect(ran()).toEqual(['A']);
      const landing = (ofType(await logged(), 'wave-merged')[0] as Logged).payload;
      expect(landing).toMatchObject({
        pre_landing: 'pre-merge-tier',
        test_cmd_not_run: true,
        select_test_cmd_not_run: true,
      });
    });

    it('keeps --test-cmd for an unlabelled file and records pre_landing test-cmd', async () => {
      const { status } = await cliRun([{ name: 'A', cmd: logging('A') }]);
      expect(status).toBe(0);
      expect(ran()).toEqual(['test-cmd']);
      expect((ofType(await logged(), 'wave-merged')[0] as Logged).payload.pre_landing).toBe(
        'test-cmd',
      );
    });
  });
});
