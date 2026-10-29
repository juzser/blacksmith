import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPEC_REVIEW_EVENT } from '../src/spec.js';
import { runCli, taskStatusFixtures } from './helpers/cliHarness.js';
import { git, runOrThrow } from './helpers/process.js';

// Part of the former cli.test.ts, split along its describe blocks so vitest runs
// the parts on separate workers. cli.ts is thin argv->module wiring (excluded from
// the coverage floor, like UI glue per stack.md); it is verified end-to-end here
// as a built binary, the way it actually runs (`smith <ns> <action> ...`).
// Shared harness: helpers/cliHarness.ts.

describe('cli.ts (built binary)', () => {
  let scratchDir: string;

  // dist/ is built once for the whole run by test/globalSetup.ts, not here:
  // guardHook.test.ts execs the same binary, and two parallel vitest workers
  // emitting into one dist/ while a third reads it is a race. Each file of the
  // old single cli.test.ts now owns its scratch directory, so none depends on
  // another having run first.
  beforeAll(async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), 'smith-cli-'));
  });

  afterAll(async () => {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  describe('task-status producers (D-46/P9-29)', () => {
    const { PLAN, session, tail, ingest, append, handMergedProject } = taskStatusFixtures(
      () => scratchDir,
    );

    // #269: a merge the log cannot see is a merge nobody can prove happened.
    // `queue run` must refuse before any git write, not merge silently and
    // leave `wave-merged` unwritten the way the wave playbook's undocumented
    // invocation used to.
    it('queue run: refuses to merge at all without --session, and touches no branch', async () => {
      const originDir = path.join(scratchDir, `p269-origin-${Date.now()}.git`);
      const projectDir = path.join(scratchDir, `p269-project-${Date.now()}`);
      runOrThrow('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
      runOrThrow('git', ['clone', '-q', originDir, projectDir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
      await writeFile(path.join(projectDir, 'seed.txt'), 'seed\n');
      runOrThrow('git', ['add', '.'], { cwd: projectDir });
      runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
      runOrThrow('git', ['push', '-q', 'origin', 'main'], { cwd: projectDir });
      const headBefore = git(projectDir, ['rev-parse', 'HEAD']).trim();

      const created = runCli(['worktree', 'create', projectDir, 'epic-1', 'task-1']);
      expect(created.status).toBe(0);
      const { worktreeDir, branch } = JSON.parse(created.stdout);
      await writeFile(path.join(worktreeDir, 'task-1.txt'), 'task-1\n');
      runOrThrow('git', ['add', '.'], { cwd: worktreeDir });
      runOrThrow('git', ['commit', '-q', '-m', 'add task-1'], { cwd: worktreeDir });

      const tasksPath = path.join(scratchDir, `p269-tasks-${Date.now()}.json`);
      await writeFile(tasksPath, JSON.stringify([{ taskId: 'task-1', branch, worktreeDir }]));

      const result = runCli([
        'queue',
        'run',
        'epic-1',
        '--project',
        projectDir,
        '--test-cmd',
        'true',
        '--tasks',
        tasksPath,
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('cli.queue-run-needs-session');

      runOrThrow('git', ['checkout', 'main'], { cwd: projectDir });
      const headAfter = git(projectDir, ['rev-parse', 'HEAD']).trim();
      expect(headAfter).toBe(headBefore);
    });

    // The last id-minting hole: `--tasks` is a hand-written file, so a bare
    // id in it would have made queue.ts write `wave-merged` under a spelling
    // the plan never used — the exact divergence (D-14) that left the epic
    // with one folded task instead of six.
    it('queue run: refuses to log a merge under an id the plan does not contain', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const tasksPath = path.join(scratchDir, `${sessionId}-tasks.json`);
      await writeFile(
        tasksPath,
        JSON.stringify([{ taskId: 'task-9', branch: 'b', worktreeDir: scratchDir }]),
      );
      const result = runCli([
        'queue',
        'run',
        'epic-1',
        '--project',
        scratchDir,
        '--test-cmd',
        'true',
        '--tasks',
        tasksPath,
        '--plan',
        planPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error.message).toContain('no task "task-9"');
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-merged')).toEqual([]);
    });

    it('queue run: refuses to log at all without a plan to mint ids from', async () => {
      const { sessionId, eventsDir } = await session();
      const tasksPath = path.join(scratchDir, `${sessionId}-noplan-tasks.json`);
      await writeFile(
        tasksPath,
        JSON.stringify([{ taskId: 'task-1', branch: 'b', worktreeDir: scratchDir }]),
      );
      const result = runCli([
        'queue',
        'run',
        'epic-1',
        '--project',
        scratchDir,
        '--test-cmd',
        'true',
        '--tasks',
        tasksPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error.message).toContain('--plan');
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-merged')).toEqual([]);
    });

    // D-186: `queue.ts` exports `admit()` — "Admission order for a serial merge
    // queue: topological by dependency edges" — and nothing calls it. `queue run`
    // walks the hand-written `--tasks` array in the order it was typed, so a task
    // can be rebased and merged before the task it declares `depends_on`, and the
    // epic's cumulative regression gate runs against an integration branch that
    // does not have the prerequisite on it yet.
    it('queue run: merges in dependency order, not the order the tasks file lists', async () => {
      const { sessionId, eventsDir } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-dep-plan.json`);
      await writeFile(
        planPath,
        JSON.stringify({
          ...PLAN,
          edges: [
            {
              task: 'epic-1/task-1',
              dependsOn: 'epic-1/task-2',
              edge_type: 'artifact',
              edge_provenance: 'declared',
            },
          ],
        }),
      );

      const originDir = path.join(scratchDir, `${sessionId}-dep-origin.git`);
      const projectDir = path.join(scratchDir, `${sessionId}-dep-project`);
      runOrThrow('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
      runOrThrow('git', ['clone', '-q', originDir, projectDir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
      await writeFile(path.join(projectDir, 'seed.txt'), 'seed\n');
      runOrThrow('git', ['add', '.'], { cwd: projectDir });
      runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
      runOrThrow('git', ['push', '-q', 'origin', 'main'], { cwd: projectDir });

      const made: Array<{ taskId: string; branch: string; worktreeDir: string }> = [];
      for (const id of ['task-1', 'task-2']) {
        const created = runCli(['worktree', 'create', projectDir, 'epic-1', id]);
        expect(created.status).toBe(0);
        const { worktreeDir, branch } = JSON.parse(created.stdout);
        await writeFile(path.join(worktreeDir, `${id}.txt`), `${id}\n`);
        runOrThrow('git', ['add', '.'], { cwd: worktreeDir });
        runOrThrow('git', ['commit', '-q', '-m', `add ${id}`], { cwd: worktreeDir });
        made.push({ taskId: id, branch, worktreeDir });
      }

      // The dependent listed first — exactly what a hand-written tasks file may say.
      const tasksPath = path.join(scratchDir, `${sessionId}-dep-tasks.json`);
      await writeFile(tasksPath, JSON.stringify(made));

      const queued = runCli([
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
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(queued.status).toBe(0);
      expect(JSON.parse(queued.stdout).map((o: { taskId: string }) => o.taskId)).toEqual([
        'epic-1/task-2',
        'epic-1/task-1',
      ]);
    });

    // merge-lanes: without --plan there is nowhere to read edges or claims
    // from, so grouping would be guesswork. `--plan` is unconditionally
    // required since #269, so --batch hits that same generic refusal.
    it('queue run --batch: refuses without --plan', async () => {
      const { sessionId, eventsDir } = await session();
      const tasksPath = path.join(scratchDir, `batch-noplan-tasks-${Date.now()}.json`);
      await writeFile(
        tasksPath,
        JSON.stringify([{ taskId: 'task-1', branch: 'b', worktreeDir: scratchDir }]),
      );
      const result = runCli([
        'queue',
        'run',
        'epic-1',
        '--project',
        scratchDir,
        '--test-cmd',
        'true',
        '--tasks',
        tasksPath,
        '--batch',
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(1);
      const error = JSON.parse(result.stdout).error;
      expect(error.code).toBe('cli.missing-flag');
      expect(error.message).toContain('--plan');
    });

    // A batch candidate is tested whole, with no per-task file set to narrow
    // a `--select-test-cmd` template to — silently running the full suite
    // while the outcome claimed it was selected would be the D-260 lie this
    // combination must refuse instead.
    it('queue run --batch: refuses with --select-test-cmd', async () => {
      const { sessionId, eventsDir } = await session();
      const planPath = path.join(scratchDir, `batch-selecttest-plan-${Date.now()}.json`);
      await writeFile(planPath, JSON.stringify(PLAN));
      const tasksPath = path.join(scratchDir, `batch-selecttest-tasks-${Date.now()}.json`);
      await writeFile(
        tasksPath,
        JSON.stringify([{ taskId: 'task-1', branch: 'b', worktreeDir: scratchDir }]),
      );
      const result = runCli([
        'queue',
        'run',
        'epic-1',
        '--project',
        scratchDir,
        '--test-cmd',
        'true',
        '--tasks',
        tasksPath,
        '--plan',
        planPath,
        '--batch',
        '--select-test-cmd',
        'pnpm test {files}',
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(1);
      const error = JSON.parse(result.stdout).error;
      expect(error.message).toContain('--batch');
      expect(error.message).toContain('--select-test-cmd');
    });

    // merge-lanes: two claim-disjoint tasks (PLAN's task-1 touches
    // src/foo/*.ts, task-2 touches src/bar/*.ts — neither globs onto a
    // serialize-always path) fold into one candidate and cost one suite run,
    // and the JSON shape gains a `batches` summary instead of staying a bare
    // outcomes array.
    it('queue run --batch: groups claim-disjoint tasks into one suite run', async () => {
      const { sessionId, eventsDir } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-batch-plan.json`);
      await writeFile(planPath, JSON.stringify(PLAN));

      const originDir = path.join(scratchDir, `${sessionId}-batch-origin.git`);
      const projectDir = path.join(scratchDir, `${sessionId}-batch-project`);
      runOrThrow('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
      runOrThrow('git', ['clone', '-q', originDir, projectDir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
      await writeFile(path.join(projectDir, 'seed.txt'), 'seed\n');
      runOrThrow('git', ['add', '.'], { cwd: projectDir });
      runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
      runOrThrow('git', ['push', '-q', 'origin', 'main'], { cwd: projectDir });

      const made: Array<{ taskId: string; branch: string; worktreeDir: string }> = [];
      for (const id of ['task-1', 'task-2']) {
        const created = runCli(['worktree', 'create', projectDir, 'epic-1', id]);
        expect(created.status).toBe(0);
        const { worktreeDir, branch } = JSON.parse(created.stdout);
        await writeFile(path.join(worktreeDir, `${id}.txt`), `${id}\n`);
        runOrThrow('git', ['add', '.'], { cwd: worktreeDir });
        runOrThrow('git', ['commit', '-q', '-m', `add ${id}`], { cwd: worktreeDir });
        made.push({ taskId: id, branch, worktreeDir });
      }

      const tasksPath = path.join(scratchDir, `${sessionId}-batch-tasks.json`);
      await writeFile(tasksPath, JSON.stringify(made));

      const queued = runCli([
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
        '--batch',
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(queued.status).toBe(0);
      const body = JSON.parse(queued.stdout);
      expect(body.outcomes.map((o: { taskId: string }) => o.taskId)).toEqual([
        'epic-1/task-1',
        'epic-1/task-2',
      ]);
      expect(body.outcomes.every((o: { outcome: string }) => o.outcome === 'merged')).toBe(true);
      expect(body.batches).toEqual([
        { task_ids: ['epic-1/task-1', 'epic-1/task-2'], suite_runs: 1, landed: true },
      ]);
    });

    // A singleton "group" (groupForBatch gave the task no claim-disjoint
    // sibling to stack with) runs through plain `step`, which refuses
    // before any test runs when the branch carries nothing to merge (D-30).
    // `suite_runs` must say 0, not the 1 it used to claim unconditionally.
    it('queue run --batch: a singleton group reports 0 suite runs when step refuses before testing', async () => {
      const { sessionId, eventsDir } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-batch-noop-plan.json`);
      await writeFile(planPath, JSON.stringify(PLAN));

      const originDir = path.join(scratchDir, `${sessionId}-batch-noop-origin.git`);
      const projectDir = path.join(scratchDir, `${sessionId}-batch-noop-project`);
      runOrThrow('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
      runOrThrow('git', ['clone', '-q', originDir, projectDir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
      await writeFile(path.join(projectDir, 'seed.txt'), 'seed\n');
      runOrThrow('git', ['add', '.'], { cwd: projectDir });
      runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
      runOrThrow('git', ['push', '-q', 'origin', 'main'], { cwd: projectDir });

      // task-1's own claims (src/foo/*.ts) overlap nothing else in PLAN, so
      // groupForBatch gives it a singleton — but it never commits anything
      // on its branch, so `step` reports `nothing-to-merge` before any test.
      const created = runCli(['worktree', 'create', projectDir, 'epic-1', 'task-1']);
      expect(created.status).toBe(0);
      const { worktreeDir, branch } = JSON.parse(created.stdout);

      const tasksPath = path.join(scratchDir, `${sessionId}-batch-noop-tasks.json`);
      await writeFile(tasksPath, JSON.stringify([{ taskId: 'task-1', branch, worktreeDir }]));

      const queued = runCli([
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
        '--batch',
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(queued.status).toBe(1);
      const body = JSON.parse(queued.stdout);
      expect(body.outcomes).toEqual([
        expect.objectContaining({ outcome: 'nothing-to-merge', taskId: 'epic-1/task-1' }),
      ]);
      expect(body.batches).toEqual([{ task_ids: ['epic-1/task-1'], suite_runs: 0, landed: false }]);
    });

    // merge-lanes: a group's candidate can fail the suite — bisection still
    // lands the innocent task and reports the guilty one, and the run stops
    // at the first batch that did not fully land (`allMerged` false), same
    // as the non-batch loop stopping at the first non-merged outcome.
    it('queue run --batch: bisects a failing group and stops the run there', async () => {
      const { sessionId, eventsDir } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-batch-bad-plan.json`);
      await writeFile(planPath, JSON.stringify(PLAN));

      const originDir = path.join(scratchDir, `${sessionId}-batch-bad-origin.git`);
      const projectDir = path.join(scratchDir, `${sessionId}-batch-bad-project`);
      runOrThrow('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
      runOrThrow('git', ['clone', '-q', originDir, projectDir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
      await writeFile(path.join(projectDir, 'seed.txt'), 'seed\n');
      runOrThrow('git', ['add', '.'], { cwd: projectDir });
      runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
      runOrThrow('git', ['push', '-q', 'origin', 'main'], { cwd: projectDir });

      const contents = { 'task-1': 'task-1\n', 'task-2': 'BAD\n' } as const;
      const made: Array<{ taskId: string; branch: string; worktreeDir: string }> = [];
      for (const id of ['task-1', 'task-2'] as const) {
        const created = runCli(['worktree', 'create', projectDir, 'epic-1', id]);
        expect(created.status).toBe(0);
        const { worktreeDir, branch } = JSON.parse(created.stdout);
        await writeFile(path.join(worktreeDir, `${id}.txt`), contents[id]);
        runOrThrow('git', ['add', '.'], { cwd: worktreeDir });
        runOrThrow('git', ['commit', '-q', '-m', `add ${id}`], { cwd: worktreeDir });
        made.push({ taskId: id, branch, worktreeDir });
      }

      const tasksPath = path.join(scratchDir, `${sessionId}-batch-bad-tasks.json`);
      await writeFile(tasksPath, JSON.stringify(made));

      const queued = runCli([
        'queue',
        'run',
        'epic-1',
        '--project',
        projectDir,
        '--test-cmd',
        '! grep -q BAD task-2.txt',
        '--tasks',
        tasksPath,
        '--plan',
        planPath,
        '--batch',
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(queued.status).toBe(1);
      const body = JSON.parse(queued.stdout);
      expect(body.outcomes).toEqual([
        { outcome: 'merged', taskId: 'epic-1/task-1' },
        { outcome: 'tests-failed', taskId: 'epic-1/task-2', outputTail: expect.any(String) },
      ]);
      expect(body.batches).toHaveLength(1);
      expect(body.batches[0].task_ids).toEqual(['epic-1/task-1', 'epic-1/task-2']);
      expect(body.batches[0].landed).toBe(false);
    });

    it('queue adopt: logs wave-merged for a verified hand-merge, under the plan’s id', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const { projectDir, sha } = await handMergedProject(sessionId);

      // Typed bare, as a human would; the log has to hold the qualified id.
      const adopted = runCli([
        'queue',
        'adopt',
        'task-1',
        '--project',
        projectDir,
        '--merge-commit',
        sha,
        '--plan',
        planPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(adopted.status).toBe(0);
      expect(JSON.parse(adopted.stdout)).toEqual({
        outcome: 'adopted',
        taskId: 'epic-1/task-1',
        mergeCommit: sha,
        filesChanged: ['a.txt'],
      });

      const merged = tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-merged');
      expect(merged).toHaveLength(1);
      expect(merged[0]?.task_id).toBe('epic-1/task-1');
      expect(merged[0]?.payload.files_changed).toEqual(['a.txt']);
    });

    // The claim is checked against the repository, not accepted: a real merge
    // of the real branch, made somewhere the epic does not assemble, landed
    // nothing for the epic and cannot be adopted into it.
    it('queue adopt: refuses a commit the integration branch does not contain', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const { projectDir, branch } = await handMergedProject(sessionId);
      runOrThrow('git', ['checkout', '-q', '-b', 'somewhere-else', 'main'], { cwd: projectDir });
      runOrThrow('git', ['merge', '--no-ff', branch, '-m', 'merged somewhere else'], {
        cwd: projectDir,
      });
      const elsewhere = runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: projectDir }).stdout.trim();

      const adopted = runCli([
        'queue',
        'adopt',
        'task-1',
        '--project',
        projectDir,
        '--merge-commit',
        elsewhere,
        '--plan',
        planPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(adopted.status).toBe(1);
      expect(JSON.parse(adopted.stdout).error.code).toBe('queue.adopt-not-on-integration');
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-merged')).toEqual([]);
    });

    it('queue adopt: refuses a task id the plan does not contain', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const { projectDir, sha } = await handMergedProject(sessionId);

      const adopted = runCli([
        'queue',
        'adopt',
        'task-9',
        '--project',
        projectDir,
        '--merge-commit',
        sha,
        '--plan',
        planPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(adopted.status).toBe(1);
      expect(JSON.parse(adopted.stdout).error.message).toContain('no task "task-9"');
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-merged')).toEqual([]);
    });

    // D-43/P9-27: `epic verdict` stays the free read-only probe; `epic close`
    // is the verb that writes the fact down. The dogfood epic was closed by a
    // human overriding a hold, and the log recorded nothing at all.
    //
    // Nested inside the task-status describe (opened in cliWave.test.ts) to
    // reuse its PLAN/session()/tail() fixtures, now from helpers/cliHarness.ts — an epic can only be closed once it has tasks, and `plan
    // ingest` is what puts them on the log.
    describe('epic close (D-43/P9-27)', () => {
      async function heldEpic() {
        const { sessionId, eventsDir, planPath } = await session();
        // Ingested, never dispatched: task-added with status todo is exactly
        // the non-terminal state an override closes over.
        const ingest = runCli([
          'plan',
          'ingest',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(ingest.status).toBe(0);
        return { sessionId, eventsDir };
      }

      it('refuses to close a held epic without a rationale, and writes nothing', async () => {
        const { sessionId, eventsDir } = await heldEpic();
        const result = runCli([
          'epic',
          'close',
          '--epic',
          'epic-1',
          '--project',
          scratchDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('epic.close-refused');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'epic-closed')).toEqual(
          [],
        );
      });

      it('records an operator override, naming the machine verdict it overrode', async () => {
        const { sessionId, eventsDir } = await heldEpic();
        const result = runCli([
          'epic',
          'close',
          '--epic',
          'epic-1',
          '--project',
          scratchDir,
          '--override-rationale',
          'Carry-forward defects only; tracked as D-99.',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          epicId: 'epic-1',
          closedBy: 'operator-override',
          machineVerdict: 'hold',
        });

        const closed = tail(sessionId, eventsDir).filter((r) => r.event_type === 'epic-closed');
        expect(closed).toHaveLength(1);
        expect(closed[0]?.task_id).toBe('epic-1/integration');
        expect(closed[0]?.payload.override_rationale).toBe(
          'Carry-forward defects only; tracked as D-99.',
        );
      });

      // `event tail` used to answer a typo'd session with [] and exit 0
      // (D-45; fixed under P9-28, which is why the check below is now the
      // refusal rather than an empty array). Closing must not inherit it: the
      // only thing worse than an unrecorded close is a recorded one in a log
      // nobody is reading.
      it('refuses an unknown session instead of starting a log with a close in it', async () => {
        const { eventsDir } = await heldEpic();
        const result = runCli([
          'epic',
          'close',
          '--epic',
          'epic-1',
          '--project',
          scratchDir,
          '--override-rationale',
          'ship it',
          '--session',
          'no-such-session',
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        const tailed = runCli(['event', 'tail', 'no-such-session', '--state-dir', eventsDir]);
        expect(tailed.status).toBe(1);
        expect(JSON.parse(tailed.stdout).error.code).toBe('events.unknown-session');
      });
    });

    // D-41/P9-24: a finding is about a file, and a file has an owner. Until
    // now the only way to raise one was `gate run`, which meant the finding
    // was born owned by whoever happened to be at the gate.
    describe('findings raise (D-41/P9-24)', () => {
      const EVIDENCE = [
        {
          file_path: 'src/bar/thing.ts',
          finding_category: 'correctness',
          severity: 'S2-major',
          summary: 'off-by-one in loop bound',
          failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
        },
      ];

      async function evidenceFile(name: string, evidence: unknown = EVIDENCE): Promise<string> {
        const filePath = path.join(scratchDir, `${name}.json`);
        await writeFile(filePath, JSON.stringify(evidence));
        return filePath;
      }

      it('raises a finding with no gate run at all, on the task named by --task', async () => {
        const { sessionId, eventsDir } = await session();
        const evidence = await evidenceFile('raise-plain');

        const result = runCli([
          'findings',
          'raise',
          '--evidence',
          evidence,
          '--found-by',
          'reviewer',
          '--task',
          'epic-1/task-1',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject([
          { taskId: 'epic-1/task-1', attribution: 'gated', suppressed: false },
        ]);

        const raised = tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised');
        expect(raised).toHaveLength(1);
        expect(raised[0]?.task_id).toBe('epic-1/task-1');

        // Each raised finding carries the event_id of the finding-raised
        // event it just appended, so a follower can chain off it directly.
        const tailResult = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir]);
        const raisedEvent = JSON.parse(tailResult.stdout).find(
          (e: { record: { event_type: string } }) => e.record.event_type === 'finding-raised',
        );
        expect(JSON.parse(result.stdout)[0].event_id).toBe(raisedEvent.event_id);
      });

      it('routes the finding to whoever claims the file, not to --task', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const evidence = await evidenceFile('raise-owned');

        const result = runCli([
          'findings',
          'raise',
          '--evidence',
          evidence,
          '--found-by',
          'reviewer',
          '--task',
          'epic-1/task-1',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject([
          { taskId: 'epic-1/task-2', attribution: 'reassigned', suppressed: false },
        ]);

        const records = tail(sessionId, eventsDir);
        const raised = records.filter((r) => r.event_type === 'finding-raised');
        expect(raised).toHaveLength(1);
        expect(raised[0]?.task_id).toBe('epic-1/task-2');

        const moved = records.filter((r) => r.event_type === 'finding-reattributed');
        expect(moved).toHaveLength(1);
        expect(moved[0]?.payload).toMatchObject({
          from_task_id: 'epic-1/task-1',
          to_task_id: 'epic-1/task-2',
          attribution: 'reassigned',
          file_path: 'src/bar/thing.ts',
        });
      });

      it('opens a follow-up against the epic when no task claims the file', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        // Nothing in PLAN claims scripts/, and no --task is given: the epic is
        // the only thing left that can own it.
        const evidence = await evidenceFile('raise-unclaimed', [
          { ...EVIDENCE[0], file_path: 'scripts/release.sh' },
        ]);

        const result = runCli([
          'findings',
          'raise',
          '--evidence',
          evidence,
          '--found-by',
          'reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        const [routed] = JSON.parse(result.stdout);
        expect(routed).toMatchObject({ attribution: 'follow-up', suppressed: false });
        expect(routed.taskId).toMatch(/^epic-1\/followup-/);

        const records = tail(sessionId, eventsDir);
        const added = records.filter((r) => r.event_type === 'task-added');
        expect(added).toHaveLength(1);
        expect(added[0]?.task_id).toBe(routed.taskId);
        expect(added[0]?.payload).toMatchObject({
          epic_id: 'epic-1',
          task_status: 'todo',
          claims: ['scripts/release.sh'],
        });
      });

      it('attributes by the live record of a task, not a superseded copy of it', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = path.join(scratchDir, `${sessionId}-superseded-plan.json`);
        await writeFile(
          planPath,
          JSON.stringify({
            epic_id: 'epic-1',
            version: 2,
            status: 'active',
            tasks: [
              { task_id: 'epic-1/task-1', claims: ['src/old/**'], task_status: 'superseded' },
              { task_id: 'epic-1/task-1', claims: ['src/live/**'], task_status: 'todo' },
              // Superseded under a new id: its old files belong to nobody it names.
              { task_id: 'epic-1/task-2', claims: ['src/gone/**'], task_status: 'superseded' },
            ],
            edges: [],
          }),
        );
        const raise = async (name: string, file: string) => {
          const evidence = await evidenceFile(name, [{ ...EVIDENCE[0], file_path: file }]);
          const result = runCli([
            'findings',
            'raise',
            '--evidence',
            evidence,
            '--found-by',
            'reviewer',
            '--task',
            'epic-1/task-1',
            '--plan',
            planPath,
            '--session',
            sessionId,
            '--causal-parent',
            `${sessionId}#0`,
            '--state-dir',
            eventsDir,
          ]);
          expect(result.status).toBe(0);
          return JSON.parse(result.stdout)[0];
        };

        expect(await raise('raise-live', 'src/live/a.ts')).toMatchObject({
          taskId: 'epic-1/task-1',
          attribution: 'gated',
        });
        expect(await raise('raise-dead', 'src/old/a.ts')).toMatchObject({
          attribution: 'follow-up',
        });
        expect(await raise('raise-gone', 'src/gone/a.ts')).toMatchObject({
          attribution: 'follow-up',
        });
      });

      it('refuses to raise a finding with neither --task nor --plan to own it', async () => {
        const { sessionId, eventsDir } = await session();
        const evidence = await evidenceFile('raise-ownerless');

        const result = runCli([
          'findings',
          'raise',
          '--evidence',
          evidence,
          '--found-by',
          'reviewer',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.missing-flag');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised')).toEqual(
          [],
        );
      });

      // #285: `--findings` takes an already-minted `RaiseFindingInput[]`
      // ({finding, filePath}), not a judge artifact (`FindingEvidence[]`,
      // snake_case `file_path`). Handing it the latter used to crash with an
      // uncaught TypeError deep inside `normalizeRepoPath`, which reads
      // `filePath` straight off the item.
      it('refuses a judge-artifact-shaped --findings file with a named shape error, not a crash', async () => {
        const { sessionId, eventsDir } = await session();
        const judgeArtifact = await evidenceFile('raise-findings-wrong-shape');

        const result = runCli([
          'findings',
          'raise',
          '--findings',
          judgeArtifact,
          '--task',
          'epic-1/task-1',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        const error = JSON.parse(result.stdout).error;
        expect(error.code).toBe('cli.invalid-flag');
        expect(error.message).toContain('item 0');
        expect(error.message).toContain('--evidence');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised')).toEqual(
          [],
        );
      });

      it('refuses a --findings item missing filePath, naming the index and field', async () => {
        const { sessionId, eventsDir } = await session();
        const badFile = path.join(scratchDir, `${sessionId}-raise-findings-missing.json`);
        await writeFile(badFile, JSON.stringify([{ finding: { summary: 'x' } }]));

        const result = runCli([
          'findings',
          'raise',
          '--findings',
          badFile,
          '--task',
          'epic-1/task-1',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        const error = JSON.parse(result.stdout).error;
        expect(error.code).toBe('cli.invalid-flag');
        expect(error.message).toContain('filePath');
      });
    });

    // P9-15: an open finding in a file you are about to edit is worth knowing
    // and is not a task. The CLI is where that reaches a dispatch prompt.
    describe('findings for-dispatch / reverify (P9-15)', () => {
      /** An S3 in src/foo/thing.ts — task-1's claim — owned by task-2. */
      async function openFinding(sessionId: string, eventsDir: string): Promise<string> {
        const evidence = path.join(scratchDir, `${sessionId}-p9-15-evidence.json`);
        await writeFile(
          evidence,
          JSON.stringify([
            {
              file_path: 'src/foo/thing.ts',
              finding_category: 'maintainability',
              severity: 'S3-minor',
              summary: 'duplicated parse branch',
              failure_scenario: { inputs: 'any', expected: 'one branch', actual: 'two' },
            },
          ]),
        );
        const raised = runCli([
          'findings',
          'raise',
          '--evidence',
          evidence,
          '--found-by',
          'reviewer',
          '--task',
          'epic-1/task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(raised.status).toBe(0);
        return JSON.parse(raised.stdout)[0].findingId as string;
      }

      it('hands the dispatching task the open findings its own claims cover', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        await openFinding(sessionId, eventsDir);

        const forTask1 = runCli([
          'findings',
          'for-dispatch',
          '--session',
          sessionId,
          '--plan',
          planPath,
          '--task',
          'epic-1/task-1',
          '--state-dir',
          eventsDir,
        ]);
        expect(forTask1.status).toBe(0);
        const block = JSON.parse(forTask1.stdout);
        expect(block.findings.map((f: { file_path: string }) => f.file_path)).toEqual([
          'src/foo/thing.ts',
        ]);
        expect(block.text).toContain('CONTEXT, NOT SCOPE');
        expect(block.text).toContain('duplicated parse branch');

        // task-2 claims src/bar/*.ts and owns this finding besides: neither the
        // claims join nor the own-findings rule lets it through.
        const forTask2 = runCli([
          'findings',
          'for-dispatch',
          '--session',
          sessionId,
          '--plan',
          planPath,
          '--task',
          'epic-1/task-2',
          '--state-dir',
          eventsDir,
        ]);
        expect(forTask2.status).toBe(0);
        expect(JSON.parse(forTask2.stdout).findings).toEqual([]);
      });

      // #248: dispatch.md has the epic-level roles pass no --task. That call
      // is epic-wide; half a per-task call is refused, never widened.
      it('with neither --plan nor --task, hands an epic-level role every open finding', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        await openFinding(sessionId, eventsDir);

        const epicWide = runCli([
          'findings',
          'for-dispatch',
          '--session',
          sessionId,
          '--state-dir',
          eventsDir,
        ]);
        expect(epicWide.status).toBe(0);
        const block = JSON.parse(epicWide.stdout);
        expect(block.taskId).toBeNull();
        expect(block.findings.map((f: { file_path: string }) => f.file_path)).toEqual([
          'src/foo/thing.ts',
        ]);

        const taskWithoutPlan = runCli([
          'findings',
          'for-dispatch',
          '--session',
          sessionId,
          '--task',
          'epic-1/task-1',
          '--state-dir',
          eventsDir,
        ]);
        expect(taskWithoutPlan.status).not.toBe(0);
        expect(JSON.parse(taskWithoutPlan.stdout).error).toMatchObject({
          code: 'cli.missing-flag',
          details: { flag: 'plan' },
        });

        const planWithoutTask = runCli([
          'findings',
          'for-dispatch',
          '--session',
          sessionId,
          '--plan',
          planPath,
          '--state-dir',
          eventsDir,
        ]);
        expect(planWithoutTask.status).not.toBe(0);
        expect(JSON.parse(planWithoutTask.stdout).error).toMatchObject({
          code: 'cli.missing-flag',
          details: { flag: 'task' },
        });
      });

      it('reverify records that a human re-read the finding, without moving its status', async () => {
        const { sessionId, eventsDir } = await session();
        const findingId = await openFinding(sessionId, eventsDir);

        const result = runCli([
          'findings',
          'reverify',
          findingId,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--note',
          'still reproduces on the new parser',
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);

        const reverified = tail(sessionId, eventsDir).filter(
          (r) => r.event_type === 'finding-reverified',
        );
        expect(reverified).toHaveLength(1);
        expect(reverified[0]?.payload).toMatchObject({
          finding_id: findingId,
          file_path: 'src/foo/thing.ts',
          note: 'still reproduces on the new parser',
        });

        const listed = runCli([
          'findings',
          'list',
          '--session',
          sessionId,
          '--state-dir',
          eventsDir,
        ]);
        expect(listed.status).toBe(0);
        expect(JSON.parse(listed.stdout)[0].finding_status).toBe('raised');
      });

      it('refuses to reverify a finding the log never raised', async () => {
        const { sessionId, eventsDir } = await session();
        const result = runCli([
          'findings',
          'reverify',
          'finding-nope',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('findings.unknown-finding');
      });

      it('waivers approve-task records the operator approval, and refuses an agent actor', async () => {
        const { sessionId, eventsDir } = await session();
        const base = [
          'waivers',
          'approve-task',
          'epic-1/task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--note',
          'no longer needed',
          '--state-dir',
          eventsDir,
        ];

        const refused = runCli([...base, '--actor', 'coder']);
        expect(refused.status).toBe(1);
        expect(JSON.parse(refused.stdout).error.code).toBe('waivers.not-operator');

        const ok = runCli([...base, '--actor', 'operator']);
        expect(ok.status).toBe(0);
        const approved = tail(sessionId, eventsDir).filter(
          (r) => r.event_type === 'task-waiver-approved',
        );
        expect(approved).toHaveLength(1);
        expect(approved[0]?.task_id).toBe('epic-1/task-2');
        expect(approved[0]?.payload).toEqual({ operator_note: 'no longer needed' });
      });
    });

    // D-33/P9-9: every judge in this factory returned findings against a diff,
    // and every finding against a diff blocked the diff. The dogfood epic
    // deadlocked on that: a wave-3 spec defect, correctly found, recorded as a
    // coder failure, bounced back to a coder whose diff could not legally
    // contain the fix — because the fix was a new plan version. These are the
    // two verbs that route it the other way instead.
    describe('spec findings and plan amendment (D-33/P9-9)', () => {
      // Anchored to a file task-2 claims, on purpose: the whole question is
      // whether scope beats ownership. A diff finding on this path is
      // reassigned to epic-1/task-2 (the test above proves it); a spec finding
      // on the same path must not be.
      const SPEC_EVIDENCE = [
        {
          file_path: 'src/bar/thing.ts',
          finding_category: 'correctness',
          severity: 'S2-major',
          criterion_ref: 'epic-1/task-2:criterion-1',
          summary: 'criterion says "it works" but never says against which input',
          failure_scenario: {
            inputs: 'any',
            expected: 'a checkable clause',
            actual: 'nothing a gate can decide',
          },
        },
      ];

      async function specEvidenceFile(name: string, evidence: unknown = SPEC_EVIDENCE) {
        const filePath = path.join(scratchDir, `${name}.json`);
        await writeFile(filePath, JSON.stringify(evidence));
        return filePath;
      }

      /** Raise the spec finding these tests amend against, and return its id. */
      async function raiseSpec(
        name: string,
        sessionId: string,
        eventsDir: string,
        planPath: string,
      ): Promise<string> {
        const result = runCli([
          'findings',
          'raise',
          '--scope',
          'spec',
          '--evidence',
          await specEvidenceFile(name),
          '--found-by',
          'spec-reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        return JSON.parse(result.stdout)[0].findingId;
      }

      it('raises a spec finding against the epic, not against whoever claims the file', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'findings',
          'raise',
          '--scope',
          'spec',
          '--evidence',
          await specEvidenceFile('spec-raise'),
          '--found-by',
          'spec-reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject([
          { taskId: 'epic-1/integration', attribution: 'spec', suppressed: false },
        ]);

        const records = tail(sessionId, eventsDir);
        const raised = records.filter((r) => r.event_type === 'finding-raised');
        expect(raised).toHaveLength(1);
        expect(raised[0]?.task_id).toBe('epic-1/integration');
        expect(raised[0]?.payload).toMatchObject({
          finding_scope: 'spec',
          spec_ref: { plan_version: 1, criterion_ref: 'epic-1/task-2:criterion-1' },
        });
        // The two halves of the divert: no task was told to fix it, and no
        // task was told it now owns it. A plan defect has no owner but the
        // plan.
        expect(records.filter((r) => r.event_type === 'finding-reattributed')).toEqual([]);
        expect(records.filter((r) => r.event_type === 'task-added')).toEqual([]);
      });

      it('refuses a spec raise with no --plan: the version reviewed is read, never typed', async () => {
        const { sessionId, eventsDir } = await session();

        const result = runCli([
          'findings',
          'raise',
          '--scope',
          'spec',
          '--evidence',
          await specEvidenceFile('spec-noplan'),
          '--found-by',
          'spec-reviewer',
          '--task',
          'epic-1/task-1',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.missing-flag');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised')).toEqual(
          [],
        );
      });

      // Item (j) of a dogfood run's findings: the one refusal a
      // spec-reviewer actually hit in an earlier dogfood epic was this one, and it was
      // reported back as "error object with exit 0". The exit code was the
      // pipe's, not the CLI's - but nothing here had ever pinned it either.
      it('refuses spec evidence that names no criterion_ref, with exit 1 and no event', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const { criterion_ref: _dropped, ...noCriterion } =
          SPEC_EVIDENCE[0] as (typeof SPEC_EVIDENCE)[0];

        const result = runCli([
          'findings',
          'raise',
          '--scope',
          'spec',
          '--evidence',
          await specEvidenceFile('spec-nocriterion', [noCriterion]),
          '--found-by',
          'spec-reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error).toMatchObject({
          code: 'findings.spec-evidence-needs-criterion',
          details: { index: 0 },
        });
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised')).toEqual(
          [],
        );
      });

      it('rejects a --scope it does not know rather than defaulting it to diff', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'findings',
          'raise',
          '--scope',
          'plan',
          '--evidence',
          await specEvidenceFile('spec-badscope'),
          '--found-by',
          'spec-reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.invalid-flag');
      });

      it('amends the plan, cuts v2, and puts the finding that forced it on the amendment path', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const findingId = await raiseSpec('spec-amend', sessionId, eventsDir, planPath);
        const specsDir = path.join(scratchDir, `${sessionId}-specs`);
        // D-127: the amendment has to move the task whose criterion the
        // finding names, or there is nothing for the finding to wait on.
        const changesPath = path.join(scratchDir, `${sessionId}-changes.json`);
        await writeFile(
          changesPath,
          JSON.stringify({
            supersede: {
              'epic-1/task-2': {
                ...PLAN.tasks[1],
                acceptance_criteria: ['parses `A="x\\ny"` into a single entry'],
              },
            },
          }),
        );

        const result = runCli([
          'plan',
          'amend',
          '--plan',
          planPath,
          '--findings',
          findingId,
          '--rationale',
          'criterion-1 was unfalsifiable; v2 names the input it is checked against',
          '--sites',
          'src/bar/thing.ts,src/elsewhere/same-shape.ts',
          '--changes',
          changesPath,
          '--specs-dir',
          specsDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          epic: 'epic-1',
          version: 2,
          previousVersion: 1,
          findingIds: [findingId],
          // D-123: both sites are named; only the one an obligated task claims
          // (task-2 claims src/bar/*.ts) has work behind it. The other is
          // reported back to the operator rather than refused.
          sites: ['src/bar/thing.ts', 'src/elsewhere/same-shape.ts'],
          sitesUnclaimed: ['src/elsewhere/same-shape.ts'],
        });

        // The version exists on disk, and the log says why it was cut.
        const written = JSON.parse(
          await readFile(path.join(specsDir, 'epic-1', 'plan-v2.json'), 'utf8'),
        ) as { version: number; tasks: { task_id: string; plan_version: number }[] };
        expect(written.version).toBe(2);
        // Three records: task-1 carried, task-2's dead copy, task-2's replacement.
        expect(written.tasks.map((t) => t.plan_version)).toEqual([2, 2, 2]);

        const records = tail(sessionId, eventsDir);
        const cut = records.filter((r) => r.event_type === 'plan-version-created');
        expect(cut).toHaveLength(1);
        expect(cut[0]?.payload).toMatchObject({
          epic_id: 'epic-1',
          version: 2,
          previous_version: 1,
          amends: [{ finding_id: findingId, criterion_ref: 'epic-1/task-2:criterion-1' }],
        });

        // The one exit an unwaivable spec finding has — opened, not walked
        // through. `amended` is what the superseded task landing earns (D-127).
        const transitioned = records.filter((r) => r.event_type === 'finding-transitioned');
        expect(transitioned).toHaveLength(1);
        expect(transitioned[0]?.payload).toMatchObject({
          finding_id: findingId,
          to_status: 'amend-pending',
          amends_task_ids: ['epic-1/task-2'],
          amends_plan_version: 2,
        });
      });

      // A follow-up the gate minted lives in the log and in no plan file. `plan
      // amend` has to be able to retire it, or it stays live beside its
      // replacement with no verb that can end it.
      describe('supersede of a task only the log added', () => {
        const REPLACEMENT = {
          task_id: 'epic-1/folded',
          epic_id: 'epic-1',
          plan_version: 2,
          objective: 'One task that does what both follow-ups asked.',
          output_schema_ref: 'result.schema.json',
          acceptance_criteria: ['both follow-ups are covered'],
          claims: ['src/qux/*.ts', 'src/quux/*.ts'],
          budget: { tokens: 1000, diff_lines: 100 },
          contract: { functional_clauses: ['do both'], nonfunctional_clauses: [] },
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
        };

        async function amendOverLoggedFollowUps(
          name: string,
          supersedeKeys: string[],
          {
            sites = ['src/bar/thing.ts'],
            replacementFor = (i: number) => ({
              ...REPLACEMENT,
              task_id: `epic-1/folded-${i}`,
              claims: [`src/fold${i}/*.ts`],
            }),
          }: { sites?: string[]; replacementFor?: (i: number) => Record<string, unknown> } = {},
        ) {
          const { sessionId, eventsDir, planPath } = await session();
          ingest(planPath, sessionId, eventsDir);
          for (const [i, claim] of ['src/qux/*.ts', 'src/quux/*.ts'].entries()) {
            append(sessionId, eventsDir, {
              event_type: 'task-added',
              task_id: `epic-1/followup-${i}`,
              payload: {
                epic_id: 'epic-1',
                case: 'bugfix',
                origin: 'escalation',
                task_status: 'todo',
                plan_version: 1,
                objective: `Follow-up ${i}.`,
                claims: [claim],
                budget_tokens: 4000,
              },
            });
          }
          const findingId = await raiseSpec(name, sessionId, eventsDir, planPath);
          const specsDir = path.join(scratchDir, `${sessionId}-specs`);
          const changesPath = path.join(scratchDir, `${sessionId}-changes.json`);
          await writeFile(
            changesPath,
            JSON.stringify({
              supersede: Object.fromEntries(
                supersedeKeys.map((key, i) => [key, replacementFor(i)]),
              ),
            }),
          );
          const result = runCli([
            'plan',
            'amend',
            '--plan',
            planPath,
            '--findings',
            findingId,
            '--rationale',
            'fold the follow-ups into one planned task each',
            '--sites',
            sites.join(','),
            '--changes',
            changesPath,
            '--specs-dir',
            specsDir,
            '--session',
            sessionId,
            '--causal-parent',
            `${sessionId}#0`,
            '--state-dir',
            eventsDir,
          ]);
          return {
            result,
            sessionId,
            eventsDir,
            specsDir,
            findingId,
            v2Path: path.join(specsDir, 'epic-1', 'plan-v2.json'),
          };
        }

        // The stub a log-only key leaves behind is dead on arrival: it is new
        // to v2 only because the old version never had a record for it. It is
        // what the amendment retired, so the diff calls it superseded, the
        // finding does not wait on it, and its claims cover no named site.
        it('records a renamed-away log-only task as superseded, never as added work', async () => {
          const { result, sessionId, eventsDir, findingId } = await amendOverLoggedFollowUps(
            'spec-amend-logged-diff',
            ['followup-0', 'epic-1/followup-1'],
            // Claimed by followup-0 alone; neither replacement claims it.
            { sites: ['src/qux/a.ts'] },
          );
          expect(result.stderr).toBe('');
          expect(result.status).toBe(0);

          const records = tail(sessionId, eventsDir);
          const amended = records.filter((r) => r.event_type === 'plan-version-created');
          expect(amended).toHaveLength(1);
          const diff = amended[0]?.payload.diff as Record<string, string[]>;
          expect([...(diff.added ?? [])].sort()).toEqual(['epic-1/folded-0', 'epic-1/folded-1']);
          expect([...(diff.superseded ?? [])].sort()).toEqual([
            'epic-1/followup-0',
            'epic-1/followup-1',
          ]);

          const transitioned = records.filter(
            (r) => r.event_type === 'finding-transitioned' && r.payload.finding_id === findingId,
          );
          expect(transitioned).toHaveLength(1);
          expect(
            [...((transitioned[0]?.payload.amends_task_ids ?? []) as string[])].sort(),
          ).toEqual(['epic-1/folded-0', 'epic-1/folded-1']);

          expect(amended[0]?.payload.sites_unclaimed).toEqual(['src/qux/a.ts']);
          expect(JSON.parse(result.stdout).sitesUnclaimed).toEqual(['src/qux/a.ts']);
        });

        // Several tasks folded into one: every key names the same replacement.
        // v2 carries that replacement once, live, beside a dead record per key.
        it('folds three keys into one identical replacement: one live record, keys superseded', async () => {
          const { result, sessionId, eventsDir, findingId, v2Path } =
            await amendOverLoggedFollowUps(
              'spec-amend-logged-fold',
              ['followup-0', 'epic-1/followup-1', 'task-1'],
              { replacementFor: () => ({ ...REPLACEMENT }) },
            );
          expect(result.stderr).toBe('');
          expect(result.status).toBe(0);

          const v2 = JSON.parse(await readFile(v2Path, 'utf8')) as {
            tasks: { task_id: string; task_status: string }[];
          };
          expect(v2.tasks.filter((t) => t.task_id === 'epic-1/folded')).toEqual([
            expect.objectContaining({ task_status: 'todo' }),
          ]);
          for (const id of ['epic-1/followup-0', 'epic-1/followup-1', 'epic-1/task-1']) {
            expect(v2.tasks.filter((t) => t.task_id === id)).toEqual([
              expect.objectContaining({ task_status: 'superseded' }),
            ]);
          }
          expect(runCli(['plan', 'validate', v2Path]).status).toBe(0);

          const records = tail(sessionId, eventsDir);
          const diff = records.find((r) => r.event_type === 'plan-version-created')?.payload
            .diff as Record<string, string[]>;
          expect(diff.added).toEqual(['epic-1/folded']);
          expect([...(diff.superseded ?? [])].sort()).toEqual([
            'epic-1/followup-0',
            'epic-1/followup-1',
            'epic-1/task-1',
          ]);
          const transitioned = records.find(
            (r) => r.event_type === 'finding-transitioned' && r.payload.finding_id === findingId,
          );
          expect(transitioned?.payload.amends_task_ids).toEqual(['epic-1/folded']);
        });

        it('retires a bare and a qualified key: stub validates, ingest supersedes once, no reader sees them live', async () => {
          const { result, sessionId, eventsDir, v2Path } = await amendOverLoggedFollowUps(
            'spec-amend-logged',
            ['followup-0', 'epic-1/followup-1'],
          );
          expect(result.stderr).toBe('');
          expect(result.status).toBe(0);

          const v2 = JSON.parse(await readFile(v2Path, 'utf8')) as {
            tasks: { task_id: string; task_status: string; plan_version: number }[];
          };
          for (const id of ['epic-1/followup-0', 'epic-1/followup-1']) {
            expect(v2.tasks.filter((t) => t.task_id === id)).toEqual([
              expect.objectContaining({ task_status: 'superseded', plan_version: 2 }),
            ]);
          }

          const validate = runCli(['plan', 'validate', v2Path]);
          expect(validate.status).toBe(0);

          ingest(v2Path, sessionId, eventsDir);
          const records = tail(sessionId, eventsDir);
          for (const id of ['epic-1/followup-0', 'epic-1/followup-1']) {
            expect(
              records.filter((r) => r.event_type === 'task-superseded' && r.task_id === id),
            ).toHaveLength(1);
            // Added once, by the gate that minted it; the amendment adds nothing under that id.
            expect(
              records.filter((r) => r.event_type === 'task-added' && r.task_id === id),
            ).toHaveLength(1);
          }

          // wave next: neither follow-up is proposed, deferred or occupying a claim.
          const next = runCli([
            'wave',
            'next',
            v2Path,
            '--repo',
            scratchDir,
            '--session',
            sessionId,
            '--state-dir',
            eventsDir,
          ]);
          expect(next.status).toBe(0);
          const proposal = JSON.parse(next.stdout);
          const seen = [
            ...proposal.wave,
            ...proposal.deferred.map((d: { taskId: string }) => d.taskId),
            ...proposal.occupied,
          ];
          expect(seen).not.toContain('epic-1/followup-0');
          expect(seen).not.toContain('epic-1/followup-1');
          expect(proposal.wave).toContain('epic-1/folded-0');

          // The projection folds them to superseded.
          const dbPath = path.join(scratchDir, `${sessionId}.db`);
          const rebuild = runCli([
            'db',
            'rebuild',
            '--db',
            dbPath,
            '--session',
            sessionId,
            '--state-dir',
            eventsDir,
          ]);
          expect(rebuild.status).toBe(0);
          for (const id of ['epic-1/followup-0', 'epic-1/followup-1']) {
            const shown = runCli(['stats', 'task', '--db', dbPath, '--task', id]);
            expect(JSON.parse(shown.stdout).task.taskStatus).toBe('superseded');
          }
        });

        it('refuses a supersede key that names no task the plan or the log knows, writing nothing', async () => {
          const { result, specsDir, v2Path } = await amendOverLoggedFollowUps('spec-amend-ghost', [
            'followup-0',
            'followup-ghost',
          ]);
          expect(result.status).toBe(1);
          const error = JSON.parse(result.stdout).error;
          expect(error.code).toBe('plan.unknown-task');
          expect(error.message).toContain('followup-ghost');
          expect(error.message).toContain('epic-1/followup-0');
          expect(existsSync(v2Path)).toBe(false);
          expect(existsSync(path.join(specsDir, 'epic-1'))).toBe(false);
        });
      });

      // #221: a denied waiver (or any other reason a finding sits open) is
      // easy to lose track of once the next amendment is cut for something
      // else entirely. When the amendment's own objective text names an open
      // finding it did not cite, the CLI says so rather than staying silent.
      it('warns in its output when --changes cites an open finding --findings does not name', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const findingId = await raiseSpec('spec-amend-warn-cited', sessionId, eventsDir, planPath);

        const otherResult = runCli([
          'findings',
          'raise',
          '--scope',
          'spec',
          '--evidence',
          await specEvidenceFile('spec-amend-warn-other', [
            { ...SPEC_EVIDENCE[0], summary: 'a second, unrelated criterion problem' },
          ]),
          '--found-by',
          'spec-reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(otherResult.status).toBe(0);
        const otherFindingId = JSON.parse(otherResult.stdout)[0].findingId;

        const specsDir = path.join(scratchDir, `${sessionId}-warn-specs`);
        const changesPath = path.join(scratchDir, `${sessionId}-warn-changes.json`);
        await writeFile(
          changesPath,
          JSON.stringify({
            supersede: {
              'epic-1/task-2': {
                ...PLAN.tasks[1],
                acceptance_criteria: ['parses `A="x\\ny"` into a single entry'],
                objective: `Do the other thing. Also touches ${otherFindingId} in passing.`,
              },
            },
          }),
        );

        const result = runCli([
          'plan',
          'amend',
          '--plan',
          planPath,
          '--findings',
          findingId,
          '--rationale',
          'criterion-1 was unfalsifiable; v2 names the input it is checked against',
          '--sites',
          'src/bar/thing.ts',
          '--changes',
          changesPath,
          '--specs-dir',
          specsDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).warnings).toEqual([
          expect.stringContaining(otherFindingId),
        ]);
      });

      it('refuses an amendment that cites no finding: a version cut on request is a mutable plan', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const specsDir = path.join(scratchDir, `${sessionId}-nofinding-specs`);

        const result = runCli([
          'plan',
          'amend',
          '--plan',
          planPath,
          '--findings',
          '',
          '--rationale',
          'because I said so',
          '--sites',
          'src/bar/thing.ts',
          '--specs-dir',
          specsDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('plan.amendment-without-finding');
        expect(existsSync(path.join(specsDir, 'epic-1', 'plan-v2.json'))).toBe(false);
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === 'plan-version-created'),
        ).toEqual([]);
      });

      // D-123: the flag is required at the CLI too, so the shorter invocation
      // is a usage error rather than an amendment whose scope nobody stated.
      it('refuses an amendment that names no sites (D-123)', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const specsDir = path.join(scratchDir, `${sessionId}-nosites-specs`);

        const result = runCli([
          'plan',
          'amend',
          '--plan',
          planPath,
          '--findings',
          'finding-whatever',
          '--rationale',
          'the shape moved',
          '--specs-dir',
          specsDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('sites');
        expect(existsSync(path.join(specsDir, 'epic-1', 'plan-v2.json'))).toBe(false);
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === 'plan-version-created'),
        ).toEqual([]);
      });

      it('refuses to amend against a diff finding: that says the code is wrong', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const specsDir = path.join(scratchDir, `${sessionId}-diff-specs`);
        const diffEvidence = await specEvidenceFile('amend-diff-evidence', [
          {
            file_path: 'src/bar/thing.ts',
            finding_category: 'correctness',
            severity: 'S2-major',
            summary: 'off-by-one in loop bound',
            failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
          },
        ]);
        const raise = runCli([
          'findings',
          'raise',
          '--evidence',
          diffEvidence,
          '--found-by',
          'reviewer',
          '--task',
          'epic-1/task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(raise.status).toBe(0);

        const result = runCli([
          'plan',
          'amend',
          '--plan',
          planPath,
          '--findings',
          JSON.parse(raise.stdout)[0].findingId,
          '--rationale',
          'trying to fix code with a plan version',
          '--sites',
          'src/bar/thing.ts',
          '--specs-dir',
          specsDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('plan.amendment-not-spec-scoped');
        expect(existsSync(path.join(specsDir, 'epic-1', 'plan-v2.json'))).toBe(false);
      });

      it('defaults --specs-dir to the directory --plan already lives in, not the work root (#219)', async () => {
        const { sessionId, eventsDir } = await session();
        // A plan filed in the `<specsDir>/<epicId>/plan-vN.json` shape
        // `planFilePath` itself writes, but nowhere near this session's own
        // scratch plan or the work root's specs/active -- the two trees a
        // pre-#219 default could plant the new version in instead.
        const ownSpecsDir = path.join(scratchDir, `${sessionId}-own-specs`);
        const planPath = path.join(ownSpecsDir, 'epic-1', 'plan-v1.json');
        await mkdir(path.dirname(planPath), { recursive: true });
        await writeFile(planPath, JSON.stringify(PLAN));
        const findingId = await raiseSpec('spec-default-dir', sessionId, eventsDir, planPath);
        // D-127: an amendment must add or supersede a task, or `amendPlan`
        // refuses it as a no-op before it reaches the specs-dir question at
        // all -- so name one, the same way the specs-dir-agrees test above
        // does.
        const changesPath = path.join(scratchDir, `${sessionId}-default-dir-changes.json`);
        await writeFile(
          changesPath,
          JSON.stringify({
            supersede: {
              'epic-1/task-2': {
                ...PLAN.tasks[1],
                acceptance_criteria: ['parses `A="x\\ny"` into a single entry'],
              },
            },
          }),
        );
        // A work root of its own, so the pre-fix default (the work root's
        // specs/active) is provably distinct from `ownSpecsDir` rather than
        // coinciding with it by accident of where this suite runs from.
        const smithHome = path.join(scratchDir, `${sessionId}-smith-home`);

        const result = runCli(
          [
            'plan',
            'amend',
            '--plan',
            planPath,
            '--findings',
            findingId,
            '--rationale',
            'no --specs-dir: the new version must land beside --plan',
            '--sites',
            'src/bar/thing.ts',
            '--changes',
            changesPath,
            '--session',
            sessionId,
            '--causal-parent',
            `${sessionId}#0`,
            '--state-dir',
            eventsDir,
          ],
          { SMITH_HOME: smithHome },
        );

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ epic: 'epic-1', version: 2 });
        expect(existsSync(path.join(ownSpecsDir, 'epic-1', 'plan-v2.json'))).toBe(true);
        expect(
          existsSync(path.join(smithHome, 'factory', 'specs', 'active', 'epic-1', 'plan-v2.json')),
        ).toBe(false);
      });

      it('refuses an explicit --specs-dir that disagrees with where --plan already lives (#219)', async () => {
        const { sessionId, eventsDir } = await session();
        const ownSpecsDir = path.join(scratchDir, `${sessionId}-mismatch-own-specs`);
        const planPath = path.join(ownSpecsDir, 'epic-1', 'plan-v1.json');
        await mkdir(path.dirname(planPath), { recursive: true });
        await writeFile(planPath, JSON.stringify(PLAN));
        const findingId = await raiseSpec('spec-mismatch-dir', sessionId, eventsDir, planPath);
        const wrongSpecsDir = path.join(scratchDir, `${sessionId}-mismatch-wrong-specs`);
        // Names a real change (D-127), so the only thing standing between
        // this call and a wrongly-placed v2 is the mismatch check itself.
        const changesPath = path.join(scratchDir, `${sessionId}-mismatch-changes.json`);
        await writeFile(
          changesPath,
          JSON.stringify({
            supersede: {
              'epic-1/task-2': {
                ...PLAN.tasks[1],
                acceptance_criteria: ['parses `A="x\\ny"` into a single entry'],
              },
            },
          }),
        );

        const result = runCli([
          'plan',
          'amend',
          '--plan',
          planPath,
          '--findings',
          findingId,
          '--rationale',
          'a disagreeing --specs-dir must refuse, not silently pick one',
          '--sites',
          'src/bar/thing.ts',
          '--changes',
          changesPath,
          '--specs-dir',
          wrongSpecsDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.specs-dir-mismatch');
        expect(existsSync(path.join(ownSpecsDir, 'epic-1', 'plan-v2.json'))).toBe(false);
        expect(existsSync(path.join(wrongSpecsDir, 'epic-1', 'plan-v2.json'))).toBe(false);
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === 'plan-version-created'),
        ).toEqual([]);
      });

      it("accepts a --specs-dir that reaches the plan's own directory through a symlink (#219)", async () => {
        const { sessionId, eventsDir } = await session();
        const ownSpecsDir = path.join(scratchDir, `${sessionId}-alias-own-specs`);
        const planPath = path.join(ownSpecsDir, 'epic-1', 'plan-v1.json');
        await mkdir(path.dirname(planPath), { recursive: true });
        await writeFile(planPath, JSON.stringify(PLAN));
        const findingId = await raiseSpec('spec-alias-dir', sessionId, eventsDir, planPath);
        // Same directory on disk, different lexical path -- the macOS
        // /tmp -> /private/tmp shape. It names the plan's own tree, so it
        // must not be refused as a disagreement.
        const aliasSpecsDir = path.join(scratchDir, `${sessionId}-alias-link-specs`);
        await symlink(ownSpecsDir, aliasSpecsDir, 'dir');
        const changesPath = path.join(scratchDir, `${sessionId}-alias-changes.json`);
        await writeFile(
          changesPath,
          JSON.stringify({
            supersede: {
              'epic-1/task-2': {
                ...PLAN.tasks[1],
                acceptance_criteria: ['parses `A="x\\ny"` into a single entry'],
              },
            },
          }),
        );

        const result = runCli([
          'plan',
          'amend',
          '--plan',
          planPath,
          '--findings',
          findingId,
          '--rationale',
          'a symlinked --specs-dir naming the same tree is agreement, not a mismatch',
          '--sites',
          'src/bar/thing.ts',
          '--changes',
          changesPath,
          '--specs-dir',
          aliasSpecsDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);

        expect(result.status).toBe(0);
        expect(existsSync(path.join(ownSpecsDir, 'epic-1', 'plan-v2.json'))).toBe(true);
      });

      // Issue #249: a missing --evidence used to be read as "found nothing",
      // so a review that never wrote its file closed as clean. An empty review
      // is now said out loud, one way or the other, never by omission.
      it.each([
        ['neither --evidence nor --no-findings', [], 'cli.missing-flag'],
        [
          'both --evidence and --no-findings',
          ['--evidence', 'review.json', '--no-findings'],
          'cli.incompatible-flags',
        ],
      ])('refuses a closing spec review given %s', async (_label, extra, code) => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'epic',
          'spec-review',
          '--epic',
          'epic-1',
          '--project',
          scratchDir,
          '--plan',
          planPath,
          '--reviewed-by',
          'spec-reviewer',
          ...extra.map((arg) => (arg === 'review.json' ? path.join(scratchDir, arg) : arg)),
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe(code);
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === SPEC_REVIEW_EVENT),
        ).toEqual([]);
      });

      it('refuses a closing spec review it cannot pin to an integration head', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'epic',
          'spec-review',
          '--epic',
          'epic-1',
          // A scratch dir, not a checkout: there is no smith/epic-1/integration
          // here, so there is nothing the review could be shown to cover.
          '--project',
          scratchDir,
          '--plan',
          planPath,
          '--reviewed-by',
          'spec-reviewer',
          '--no-findings',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.no-integration-branch');
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === SPEC_REVIEW_EVENT),
        ).toEqual([]);
      });
    });
  });
});
