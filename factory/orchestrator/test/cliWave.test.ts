import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBudgetPolicy } from '../src/budgets.js';
import { runCli, taskStatusFixtures } from './helpers/cliHarness.js';
import { git } from './helpers/process.js';

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

  // D-46/P9-29: a task's life must be readable off the log alone. These two
  // verbs close the last gaps — `plan ingest` is where a task starts
  // existing, and `wave check` is where one becomes ready — and both mint
  // ids from the plan rather than from whatever was typed at them.
  // (This describe is split across cliWave, cliFindings, cliSpec and cliGate;
  // they share the fixtures in helpers/cliHarness.ts.)
  describe('task-status producers (D-46/P9-29)', () => {
    const { PLAN, session, tail, ingest, append } = taskStatusFixtures(() => scratchDir);

    it('plan ingest: writes a task-added per task, and says so; re-running adds nothing', async () => {
      const { sessionId, eventsDir, planPath } = await session();
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
      expect(JSON.parse(ingest.stdout)).toMatchObject({ added: 2, skipped: 0 });

      const added = tail(sessionId, eventsDir).filter((r) => r.event_type === 'task-added');
      expect(added.map((r) => r.task_id)).toEqual(['epic-1/task-1', 'epic-1/task-2']);

      const again = runCli([
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
      expect(again.status).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ added: 0, skipped: 2 });
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'task-added')).toHaveLength(
        2,
      );
    });

    // bs-rename part 1: `--project` resolves the branch prefix per epic, the
    // same way `worktree create` does, instead of always declaring `bs/...`
    // for an epic that already integrates on `smith/<epic>/integration`.
    it('plan ingest --project: declares smith/... for an epic already on a legacy integration branch', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const projectRoot = await mkdtemp(path.join(tmpdir(), 'smith-cli-project-'));
      const originDir = path.join(projectRoot, 'origin.git');
      const projectDir = path.join(projectRoot, 'project');
      try {
        git(projectRoot, ['init', '-q', '--bare', '-b', 'main', originDir]);
        git(projectRoot, ['clone', '-q', originDir, projectDir]);
        git(projectDir, ['config', 'user.email', 'test@example.com']);
        git(projectDir, ['config', 'user.name', 'Test']);
        await writeFile(path.join(projectDir, 'README.md'), '# project\n');
        git(projectDir, ['add', '.']);
        git(projectDir, ['commit', '-q', '-m', 'init']);
        git(projectDir, ['push', '-q', 'origin', 'main']);
        git(projectDir, ['branch', 'smith/epic-1/integration', 'main']);

        const ingest = runCli([
          'plan',
          'ingest',
          planPath,
          '--project',
          projectDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(ingest.status).toBe(0);

        const added = tail(sessionId, eventsDir).filter((r) => r.event_type === 'task-added');
        expect(added.map((r) => r.payload.branch)).toEqual([
          'smith/epic-1/task-1',
          'smith/epic-1/task-2',
        ]);
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    // D-254. The plan declares a DAG; before this the ingest wrote its nodes
    // and dropped its arrows, leaving the db's `edges` table empty in every
    // real session and the Flow page drawing a graph with no dependencies.
    it('plan ingest: writes an edge-recorded per declared edge; re-running adds none', async () => {
      const { sessionId, eventsDir } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-dag.json`);
      await writeFile(
        planPath,
        JSON.stringify({
          ...PLAN,
          edges: [
            {
              task: 'epic-1/task-2',
              dependsOn: 'epic-1/task-1',
              edge_type: 'artifact',
              edge_provenance: 'declared',
            },
          ],
        }),
      );
      const args = [
        'plan',
        'ingest',
        planPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ];

      const ingest = runCli(args);
      expect(ingest.status).toBe(0);
      expect(JSON.parse(ingest.stdout)).toMatchObject({ added: 2, edges: 1 });

      const recorded = tail(sessionId, eventsDir).filter((r) => r.event_type === 'edge-recorded');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.task_id).toBe('epic-1/task-2');
      expect(recorded[0]?.payload.depends_on).toBe('epic-1/task-1');
      expect(recorded[0]?.edge).toEqual({ edge_type: 'artifact', edge_provenance: 'declared' });

      const again = runCli(args);
      expect(again.status).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ added: 0, edges: 0 });
      expect(
        tail(sessionId, eventsDir).filter((r) => r.event_type === 'edge-recorded'),
      ).toHaveLength(1);
    });

    it('plan ingest: prints the event_id of the last event it appended (the edge, after the nodes)', async () => {
      const { sessionId, eventsDir } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-dag-id.json`);
      await writeFile(
        planPath,
        JSON.stringify({
          ...PLAN,
          edges: [
            {
              task: 'epic-1/task-2',
              dependsOn: 'epic-1/task-1',
              edge_type: 'artifact',
              edge_provenance: 'declared',
            },
          ],
        }),
      );
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

      const fullTail = JSON.parse(
        runCli(['event', 'tail', sessionId, '--n', '100', '--state-dir', eventsDir]).stdout,
      );
      const last = fullTail[fullTail.length - 1];
      expect(last.record.event_type).toBe('edge-recorded');
      expect(JSON.parse(ingest.stdout).event_id).toBe(last.event_id);
    });

    it('wave check: logs wave-admitted under the plan spelling of a bare task id', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      ingest(planPath, sessionId, eventsDir);
      const result = runCli([
        'wave',
        'check',
        planPath,
        'task-1',
        'task-2',
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).valid).toBe(true);

      const admitted = tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted');
      expect(admitted).toHaveLength(1);
      expect(admitted[0]?.payload.task_ids).toEqual(['epic-1/task-1', 'epic-1/task-2']);
    });

    // The other half of the same claim. `wave check` says two tasks *may* run
    // at once; nothing until now said whether they *did*. A dispatcher that
    // admits a wave of two and then runs them one after the other reports the
    // same green as one that ran them together, and the log already held the
    // difference — this reads it back. The events go through the CLI rather
    // than a fixture so the producer's payload and the reader's expectations
    // are checked against each other.
    it('wave audit: separates a wave that ran wide from one that ran one at a time', async () => {
      async function ran(order: string[]): Promise<{ sessionId: string; eventsDir: string }> {
        const { sessionId, eventsDir, planPath } = await session();
        ingest(planPath, sessionId, eventsDir);
        const admit = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(admit.status).toBe(0);

        for (const step of order) {
          const [kind, task] = step.split(' ');
          const appended = runCli([
            'event',
            'append',
            JSON.stringify({
              session_id: sessionId,
              actor: 'system',
              plan_version: 1,
              causal_parent: `${sessionId}#0`,
              task_id: `epic-1/${task}`,
              ...(kind === 'dispatch'
                ? {
                    event_type: 'dispatch_decision',
                    payload: {
                      agent_role: 'coder',
                      provider: 'claude',
                      model_tier: 'mid',
                      model: 'claude-sonnet-5',
                    },
                  }
                : {
                    event_type: 'task-result-recorded',
                    payload: { agent: 'coder' },
                  }),
            }),
            '--state-dir',
            eventsDir,
          ]);
          expect(appended.status).toBe(0);
        }
        return { sessionId, eventsDir };
      }

      const audit = (sessionId: string, eventsDir: string, ...rest: string[]) =>
        runCli(['wave', 'audit', '--session', sessionId, '--state-dir', eventsDir, ...rest]);

      // Admitted, and not one dispatch under it. "Ran narrow" and "cannot
      // tell" are different facts, so they get different exit codes.
      const blind = await ran([]);
      const nothing = audit(blind.sessionId, blind.eventsDir);
      expect(nothing.status).toBe(2);
      const nothingSummary = JSON.parse(nothing.stdout);
      expect(nothingSummary.unobserved).toEqual(['epic-1']);
      expect(nothingSummary.serialized).toEqual([]);
      expect(nothingSummary.hint).toContain('dispatch_decision');

      // One task dispatched, finished, and only then the next.
      const serial = await ran([
        'dispatch task-1',
        'result task-1',
        'dispatch task-2',
        'result task-2',
      ]);
      const serialised = audit(serial.sessionId, serial.eventsDir);
      expect(serialised.status).toBe(1);
      const serialSummary = JSON.parse(serialised.stdout);
      expect(serialSummary.serialized).toEqual(['epic-1']);
      expect(serialSummary.widest).toEqual({ declared: 2, observed: 1 });
      expect(serialSummary.waves[0].verdict).toBe('serialized');
      expect(serialSummary.waves[0].declared).toEqual(['epic-1/task-1', 'epic-1/task-2']);

      // Both in flight before either finished: the shape the factory is for.
      const wide = await ran([
        'dispatch task-1',
        'dispatch task-2',
        'result task-1',
        'result task-2',
      ]);
      const parallel = audit(wide.sessionId, wide.eventsDir);
      expect(parallel.status).toBe(0);
      const wideSummary = JSON.parse(parallel.stdout);
      expect(wideSummary.serialized).toEqual([]);
      expect(wideSummary.waves[0].verdict).toBe('parallel');
      expect(wideSummary.widest).toEqual({ declared: 2, observed: 2 });

      // --epic narrows to one epic's waves; an epic with none is not a failure.
      const narrowed = audit(wide.sessionId, wide.eventsDir, '--epic', 'epic-9');
      expect(narrowed.status).toBe(0);
      expect(JSON.parse(narrowed.stdout).waves).toEqual([]);
    });

    // The fourth bracket, and the only one that is not about a session. The
    // three above all answer "the log I am standing in"; this one answers "this
    // workshop", and the flag semantics ARE the feature — so they are checked
    // through the real CLI against a state dir holding two unrelated lineages,
    // which is the only place the difference between the two scopes exists.
    it('epic width: folds every session by default, and one lineage under --session', () => {
      const eventsDir = path.join(
        scratchDir,
        `epic-width-${Math.random().toString(36).slice(2, 8)}`,
      );

      function closed(sessionId: string, epicId: string, concurrency: unknown): void {
        const root = runCli([
          'event',
          'append',
          JSON.stringify({
            session_id: sessionId,
            actor: 'user',
            event_type: 'session-start',
            plan_version: 1,
            causal_parent: null,
            payload: {},
          }),
          '--state-dir',
          eventsDir,
        ]);
        expect(root.status).toBe(0);

        const close = runCli([
          'event',
          'append',
          JSON.stringify({
            session_id: sessionId,
            actor: 'system',
            event_type: 'epic-closed',
            plan_version: 1,
            causal_parent: `${sessionId}#0`,
            payload: {
              epic_id: epicId,
              closed_by: 'verdict',
              machine_verdict: 'ready',
              summary: { concurrency },
            },
          }),
          '--state-dir',
          eventsDir,
        ]);
        expect(close.status).toBe(0);
      }

      const width = (...rest: string[]) =>
        runCli(['epic', 'width', '--state-dir', eventsDir, ...rest]);

      const counts = (over: Partial<Record<string, number>>) => ({
        parallel: 0,
        partial: 0,
        serialized: 0,
        single: 0,
        unlinked: 0,
        unobserved: 0,
        ...over,
      });

      closed('cli-width-wide', 'epic-wide', {
        waves: 1,
        verdicts: counts({ parallel: 1 }),
        widest: { declared: 3, observed: 3 },
        unobserved: [],
        problem: null,
      });
      closed('cli-width-narrow', 'epic-narrow', {
        waves: 1,
        verdicts: counts({ serialized: 1 }),
        widest: { declared: 2, observed: 1 },
        unobserved: [],
        problem: null,
      });

      // No --session: both lineages, and the narrow one still fails the run.
      // A default scoped to one session would have reported this workshop as
      // healthy or as broken depending on which terminal the operator was in.
      const all = width();
      expect(all.status).toBe(1);
      const allSummary = JSON.parse(all.stdout);
      expect(allSummary.epics.map((e: { epicId: string }) => e.epicId).sort()).toEqual([
        'epic-narrow',
        'epic-wide',
      ]);
      expect(allSummary.serialized).toEqual(['epic-narrow']);
      expect(allSummary.widest).toEqual({ declared: 3, observed: 3 });

      // --session narrows to one lineage, which is how an operator asks the
      // old question. The wide session alone passes; the narrow one alone
      // still fails, so the scope changes what is counted and not the rule.
      const wide = width('--session', 'cli-width-wide');
      expect(wide.status).toBe(0);
      expect(JSON.parse(wide.stdout).epics.map((e: { epicId: string }) => e.epicId)).toEqual([
        'epic-wide',
      ]);

      const narrow = width('--session', 'cli-width-narrow');
      expect(narrow.status).toBe(1);
      expect(JSON.parse(narrow.stdout).serialized).toEqual(['epic-narrow']);

      // An unknown session is a typo, not an empty factory: reported as the
      // error it is rather than folded into a confident "nothing here". Checked
      // on the error code and not on the exit status, because a missing session
      // and a serialized epic both leave 1 — the envelope is what tells them
      // apart, and an operator scripting this reads the same field.
      const missing = width('--session', 'cli-width-nobody');
      expect(missing.status).not.toBe(0);
      expect(JSON.parse(missing.stdout).error.code).toBe('events.unknown-session');
    });

    // The third bracket on parallelism, driven through the real CLI. `wave
    // check` certifies a wave someone already picked; `wave audit` reads the
    // log back afterwards. Neither can say whether the plan could EVER have
    // run wide, which is the only one of the three questions that is still
    // answerable in time to change the plan.
    it('wave schedule: reports a plan that runs in one wide round, and exits 0', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const result = runCli([
        'wave',
        'schedule',
        planPath,
        // The symbol graph is read from here rather than the checkout: these
        // claims name no file in this repo, and scanning it would price a
        // question the fixture does not ask.
        '--repo',
        scratchDir,
        '--session',
        sessionId,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(0);
      const schedule = JSON.parse(result.stdout);
      expect(schedule.epicId).toBe('epic-1');
      expect(schedule.rounds).toHaveLength(1);
      expect(schedule.rounds[0].tasks).toEqual(['epic-1/task-1', 'epic-1/task-2']);
      expect(schedule.depth).toBe(1);
      expect(schedule.widest).toBe(2);
      expect(schedule.scheduled).toBe(2);
      expect(schedule.stalled).toEqual([]);
      expect(schedule.constraints).toEqual([]);
      expect(schedule.hint).toBe('');
    });

    // Same two tasks, same dependency graph — nothing changed but where the
    // planner drew the claims, and the plan lost half its width. This is the
    // finding the command exists to make, and it is invisible to every other
    // gate: each wave of one is admitted, and each runs faithfully.
    it('wave schedule: exits 2 and names the pair when claim geometry costs the width', async () => {
      const { sessionId } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-overlap.json`);
      await writeFile(
        planPath,
        JSON.stringify({
          ...PLAN,
          tasks: PLAN.tasks.map((task, index) => ({
            ...task,
            claims: index === 0 ? ['src/foo/**'] : ['src/foo/deep/*.ts'],
          })),
        }),
      );

      const result = runCli(['wave', 'schedule', planPath, '--repo', scratchDir]);
      expect(result.status).toBe(2);
      const schedule = JSON.parse(result.stdout);
      expect(schedule.depth).toBe(2);
      expect(schedule.widest).toBe(1);
      expect(schedule.rounds[0].avoidable[0].taskId).toBe('epic-1/task-2');
      expect(schedule.constraints).toHaveLength(1);
      expect(schedule.constraints[0].reason).toBe('claim-overlap');
      expect(schedule.constraints[0].tasks).toEqual(['epic-1/task-2']);
      expect(schedule.constraints[0].blockedBy).toEqual(['epic-1/task-1']);
      expect(schedule.hint).toContain('claim-overlap');
    });

    // The bug the old filter hid: `taskIds.includes(t.task_id)` matched
    // nothing when the ids were spelled differently, validateWave([]) said
    // "valid", and an empty wave sailed through as if it had been checked.
    it('wave check: refuses a task id the plan does not contain instead of validating an empty wave', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const result = runCli(['wave', 'check', planPath, 'task-9']);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error.message).toContain('no task "task-9"');
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
        [],
      );
    });

    it('wave check: --dry checks admissibility without writing anything', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const result = runCli(['wave', 'check', planPath, 'task-1', '--dry']);
      expect(result.status).toBe(0);
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
        [],
      );
    });

    // #250. With --session the verb admits against the log, so it has to
    // read the log's answer about each id, not only the plan's.
    describe('wave check --session admits only live, ingested tasks (#250)', () => {
      function check(planPath: string, sessionId: string, eventsDir: string, ...ids: string[]) {
        return runCli([
          'wave',
          'check',
          planPath,
          ...ids,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
      }

      it('refuses a plan version the lineage never ingested', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const result = check(planPath, sessionId, eventsDir, 'task-1');

        expect(result.status).toBe(1);
        const { error } = JSON.parse(result.stdout);
        expect(error.code).toBe('cli.plan-not-ingested');
        expect(error.details).toMatchObject({ epic: 'epic-1', version: 1 });
        expect(error.details.pending).toEqual(['epic-1/task-1', 'epic-1/task-2']);
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      it('refuses a superseded task, naming it and its status', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        ingest(planPath, sessionId, eventsDir);
        append(sessionId, eventsDir, {
          event_type: 'task-superseded',
          task_id: 'epic-1/task-2',
          payload: { epic_id: 'epic-1' },
        });

        const result = check(planPath, sessionId, eventsDir, 'task-1', 'task-2');
        expect(result.status).toBe(1);
        const { error } = JSON.parse(result.stdout);
        expect(error.code).toBe('cli.task-not-live');
        expect(error.details.tasks).toEqual([
          { taskId: 'epic-1/task-2', taskStatus: 'superseded' },
        ]);
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      it('refuses a task that already merged', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        ingest(planPath, sessionId, eventsDir);
        append(sessionId, eventsDir, {
          event_type: 'wave-merged',
          payload: { epic_id: 'epic-1', task_ids: ['epic-1/task-1'] },
        });

        const result = check(planPath, sessionId, eventsDir, 'task-1');
        expect(result.status).toBe(1);
        const { error } = JSON.parse(result.stdout);
        expect(error.code).toBe('cli.task-not-live');
        expect(error.details.tasks).toEqual([{ taskId: 'epic-1/task-1', taskStatus: 'completed' }]);
      });

      // HELD_OPEN_BY_AN_OPERATOR: an escalated task is terminal but still held,
      // and the escalation ladder re-admits it. (`failed` shares the rule; no
      // event folds a row to it, so the unit test is where it is pinned.)
      it('admits an escalated task, which an operator still holds', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        ingest(planPath, sessionId, eventsDir);
        append(sessionId, eventsDir, {
          event_type: 'error-logged',
          task_id: 'epic-1/task-1',
          payload: {
            error: 'coordination.deadlock',
            severity: 'S2-major',
            task_ref: 'epic-1/task-1',
            detail: 'worker idle for twenty minutes',
          },
        });

        const result = check(planPath, sessionId, eventsDir, 'task-1');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).valid).toBe(true);
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted'),
        ).toHaveLength(1);
      });

      // A merged task an amendment superseded and `task reinstate` repaired
      // still sits in the plan as dead copies only. That must not leave the
      // plan "not ingested" for every other task.
      it('admits a live task of a plan whose reinstated task survives only as dead copies', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        ingest(planPath, sessionId, eventsDir);
        append(sessionId, eventsDir, {
          event_type: 'wave-merged',
          task_id: 'epic-1/task-1',
          payload: { epic_id: 'epic-1', task_ids: ['epic-1/task-1'] },
        });
        for (const event_type of ['task-superseded', 'task-reinstated']) {
          append(sessionId, eventsDir, {
            event_type,
            task_id: 'epic-1/task-1',
            payload: { epic_id: 'epic-1' },
          });
        }
        const deadPlan = {
          ...PLAN,
          tasks: PLAN.tasks.map((t) =>
            t.task_id === 'epic-1/task-1' ? { ...t, task_status: 'superseded' } : t,
          ),
        };
        await writeFile(planPath, JSON.stringify(deadPlan));

        const result = check(planPath, sessionId, eventsDir, 'task-2');
        expect(result.status, result.stdout).toBe(0);
        expect(JSON.parse(result.stdout).valid).toBe(true);
      });

      it('admits live tasks once the plan is ingested', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        ingest(planPath, sessionId, eventsDir);

        const result = check(planPath, sessionId, eventsDir, 'task-1', 'task-2');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).valid).toBe(true);
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted'),
        ).toHaveLength(1);
      });
    });

    // D-212: `factory/policies/worktree.yml` is the file this verb loads, and
    // it says what a dependency edge means — "tasks with overlapping claims
    // are never scheduled concurrently; they get a dependency edge (edge_type:
    // claim-order) and run serially instead". Cutting that edge is also what
    // narrows the claims, so a planner that took the advice hands this gate a
    // wave whose claims are disjoint and whose tasks may not run together.
    // The plan was in hand from the first line of the verb; `plan.edges` was
    // never read, and the wave was admitted.
    it('wave check: refuses a wave whose plan orders one of its tasks after another', async () => {
      const { sessionId, eventsDir } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-ordered.json`);
      await writeFile(
        planPath,
        JSON.stringify({
          ...PLAN,
          edges: [
            {
              task: 'epic-1/task-2',
              dependsOn: 'epic-1/task-1',
              edge_type: 'claim-order',
              edge_provenance: 'declared',
            },
          ],
        }),
      );
      ingest(planPath, sessionId, eventsDir);

      const result = runCli([
        'wave',
        'check',
        planPath,
        'task-1',
        'task-2',
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout);
      // Named apart, as in the D-48 block in cliSpec.test.ts: exit 1 here must mean
      // "checked, and these two are ordered", not "could not resolve an id".
      expect(parsed.error).toBeUndefined();
      expect(parsed.valid).toBe(false);
      expect(parsed.dependencyViolations).toEqual([
        {
          task: 'epic-1/task-2',
          dependsOn: 'epic-1/task-1',
          chain: ['epic-1/task-2', 'epic-1/task-1'],
        },
      ]);
      // `wave-admitted` is what moves a task to `ready`; a refused wave moves
      // nothing.
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
        [],
      );
    });

    // The plan is read here with a bare `JSON.parse(...) as PlanFile`, and
    // `validatePlan` is reached from `smith plan validate` alone — so the only
    // thing between a misshapen claims field and the disjointness comparison
    // is the comparison itself, which cannot tell. Written as a list these two
    // tasks are refused for overlap; written with one of them as a bare string
    // the same wave was ADMITTED, because iterating a string yields its
    // characters and 's' overlaps no path. Two tasks then went into parallel
    // worktrees both allowed to edit src/foo/a.ts, to collide at merge.
    it('wave check: refuses a claim written as a bare string instead of admitting the wave', async () => {
      const { sessionId, eventsDir } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-string-claims.json`);
      const plan = {
        ...PLAN,
        tasks: PLAN.tasks.map((task, index) => ({
          ...task,
          claims: index === 0 ? 'src/foo/**' : ['src/foo/a.ts'],
        })),
      };
      await writeFile(planPath, JSON.stringify(plan));

      const result = runCli(['wave', 'check', planPath, 'task-1', 'task-2']);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: 'claims.unreadable-claims',
        details: { task_id: 'epic-1/task-1', received: 'string' },
      });
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
        [],
      );
    });

    // Disjoint claims, no declared edge, and still not parallelisable: the
    // conflict lives on the import edge between the two claimed files, which
    // is exactly what a glob comparison cannot see (P9-3).
    it('wave check: refuses two tasks joined by an import edge their claims do not show', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      ingest(planPath, sessionId, eventsDir);
      const coupledRepo = await mkdtemp(path.join(tmpdir(), 'smith-wave-symbols-'));
      try {
        await mkdir(path.join(coupledRepo, 'src', 'foo'), { recursive: true });
        await mkdir(path.join(coupledRepo, 'src', 'bar'), { recursive: true });
        await writeFile(
          path.join(coupledRepo, 'src/foo/a.ts'),
          'export function parse(x: string) { return x; }\n',
        );
        await writeFile(
          path.join(coupledRepo, 'src/bar/b.ts'),
          "import { parse } from '../foo/a.js';\nexport const b = parse('x');\n",
        );
        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--repo',
          coupledRepo,
          '--session',
          sessionId,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stdout);
        // Named apart from the claim check: these claims ARE disjoint.
        expect(parsed.valid).toBe(true);
        expect(parsed.symbolImpact.status).toBe('coupled');
        expect(parsed.symbolImpact.crossings).toEqual([
          {
            producer: 'epic-1/task-1',
            consumer: 'epic-1/task-2',
            exportedBy: 'src/foo/a.ts',
            importedBy: 'src/bar/b.ts',
            symbols: ['parse'],
            typeOnly: false,
            dynamic: false,
          },
        ]);
        // A refused wave moves nothing to `ready`.
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      } finally {
        await rm(coupledRepo, { recursive: true, force: true });
      }
    });

    it('wave check: admits the same wave when the two claimed trees share no edge', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      ingest(planPath, sessionId, eventsDir);
      const looseRepo = await mkdtemp(path.join(tmpdir(), 'smith-wave-symbols-ok-'));
      try {
        await mkdir(path.join(looseRepo, 'src', 'foo'), { recursive: true });
        await mkdir(path.join(looseRepo, 'src', 'bar'), { recursive: true });
        await writeFile(path.join(looseRepo, 'src/foo/a.ts'), 'export const a = 1;\n');
        await writeFile(path.join(looseRepo, 'src/bar/b.ts'), 'export const b = 2;\n');
        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--repo',
          looseRepo,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.symbolImpact.status).toBe('clean');
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted'),
        ).toHaveLength(1);
      } finally {
        await rm(looseRepo, { recursive: true, force: true });
      }
    });

    // The log is the other register, and it used to substitute `[]` for a
    // claims value it could not read — which is the one claim set that
    // overlaps nothing, so the wave was admitted rather than questioned.
    it('wave check: refuses a follow-up whose logged claims the register cannot read', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      ingest(planPath, sessionId, eventsDir);
      const append = runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          actor: 'system',
          event_type: 'task-added',
          task_id: 'epic-1/followup-ab12',
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: { epic_id: 'epic-1', claims: 'src/foo/a.ts' },
        }),
        '--state-dir',
        eventsDir,
      ]);
      expect(append.status).toBe(0);

      const result = runCli([
        'wave',
        'check',
        planPath,
        'task-1',
        'epic-1/followup-ab12',
        '--session',
        sessionId,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: 'claims.unreadable-claims',
        details: { task_id: 'epic-1/followup-ab12', received: 'string' },
      });
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
        [],
      );
    });

    // The epic token cap has been declared in budgets.yml since 2026-08-11 and
    // read since P9-33 — by planQuorum's budget trigger and by `smith budget
    // alarm`, both of which stand downstream of the spend they report and can
    // only describe a bill after it is run up. `wave check` is the one moment
    // upstream of it: before any task in the wave has been dispatched, when
    // there is nothing in flight for a refusal to distort (D-29 draws exactly
    // this line for the task cap). budgets.yml's own comment on
    // `max_in_flight_tasks` already told its reader that "setting it makes
    // `smith wave check` refuse to admit a wave" — and until these tests,
    // nothing in the CLI called checkWaveBudget at all, so that sentence
    // described a gate that did not exist.
    describe('wave check: the epic budget gate', () => {
      /** A budgets.yml with only the fields this gate reads; the rest default. */
      async function policyFile(
        name: string,
        epic: { cap_tokens: number; max_in_flight_tasks?: number },
      ): Promise<string> {
        const policyPath = path.join(scratchDir, `${name}-budgets.yml`);
        const maxInFlight = epic.max_in_flight_tasks ?? null;
        await writeFile(
          policyPath,
          `epic:\n  cap_tokens: ${epic.cap_tokens}\n  alarm_ratio: 0.7\n` +
            `  max_in_flight_tasks: ${maxInFlight === null ? 'null' : maxInFlight}\n`,
        );
        return policyPath;
      }

      /** The two-task fixture plan, repriced so its declared cost is the variable. */
      async function pricedPlan(name: string, tokens: number): Promise<string> {
        const planPath = path.join(scratchDir, `${name}-priced.json`);
        await writeFile(
          planPath,
          JSON.stringify({
            ...PLAN,
            tasks: PLAN.tasks.map((task) => ({ ...task, budget: { tokens, diff_lines: 100 } })),
          }),
        );
        return planPath;
      }

      it('refuses a wave whose own declared cost would cross the epic cap', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = await pricedPlan(sessionId, 3000);
        ingest(planPath, sessionId, eventsDir);
        const budgetPolicy = await policyFile(sessionId, { cap_tokens: 5000 });

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          '--budget-policy',
          budgetPolicy,
        ]);

        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stdout);
        // Named apart from an id failure, as the dependency-order test above
        // is: exit 1 here means "checked, and it does not fit".
        expect(parsed.error).toBeUndefined();
        expect(parsed.valid).toBe(true);
        expect(parsed.budget).toMatchObject({
          status: 'refused',
          capTokens: 5000,
          waveTokens: 6000,
          waveTaskCount: 2,
        });
        expect(parsed.budget.detail).toContain('5,000');
        // The whole point of refusing at admission: nothing moves to ready.
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      // The epic cap is per effort tier (budgets.yml `epic.cap_tokens`), and
      // the tier is the plan's `effort` after effort.yml's security floor
      // (this plan trips no trigger). The same wave, the same policy
      // file: a small epic cannot afford it, a medium one can.
      it("refuses against the cap of the plan's effort tier, not the default tier", async () => {
        const { sessionId: policyName } = await session();
        const budgetPolicy = path.join(scratchDir, `${policyName}-tiered-budgets.yml`);
        await writeFile(
          budgetPolicy,
          'epic:\n  cap_tokens:\n    small: 5000\n    medium: 50000\n    huge: 100000\n' +
            '  alarm_ratio: 0.7\n  max_in_flight_tasks: null\n',
        );
        // One session per tier: wave check under --session admits only the
        // live tasks of an ingested plan, and the two plans share an epic id
        // and version, so each is ingested into a session of its own.
        const tiered = async (effort: string) => {
          const { sessionId, eventsDir } = await session();
          const planPath = path.join(scratchDir, `${sessionId}-${effort}-plan.json`);
          await writeFile(
            planPath,
            JSON.stringify({
              ...PLAN,
              effort,
              tasks: PLAN.tasks.map((task) => ({
                ...task,
                budget: { tokens: 3000, diff_lines: 100 },
              })),
            }),
          );
          ingest(planPath, sessionId, eventsDir);
          return (env: Record<string, string> = {}) =>
            runCli(
              [
                'wave',
                'check',
                planPath,
                'task-1',
                'task-2',
                '--session',
                sessionId,
                '--causal-parent',
                `${sessionId}#0`,
                '--state-dir',
                eventsDir,
                '--budget-policy',
                budgetPolicy,
              ],
              env,
            );
        };
        const checkSmall = await tiered('small');
        const checkMedium = await tiered('medium');

        const small = checkSmall();
        expect(small.status).toBe(1);
        expect(JSON.parse(small.stdout).budget).toMatchObject({
          status: 'refused',
          capTokens: 5000,
          waveTokens: 6000,
        });

        // A per-tier env override for this tier beats the file.
        const raised = checkSmall({ SMITH_EPIC_CAP_TOKENS_SMALL: '7000' });
        expect(JSON.parse(raised.stdout).budget).toMatchObject({ capTokens: 7000 });
        expect(JSON.parse(raised.stdout).budget.status).not.toBe('refused');

        const medium = checkMedium();
        expect(JSON.parse(medium.stdout).budget).toMatchObject({ capTokens: 50000 });
        expect(JSON.parse(medium.stdout).budget.status).not.toBe('refused');
      });

      // Same shape as `epic close` (D-43/P9-27): a machine refusal a human may
      // override, and the log then carries the machine's verdict AND the
      // human's reason — not a silently admitted wave that reads afterward as
      // if it had been within budget all along.
      it('admits a refused wave under --override-rationale and logs both', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = await pricedPlan(sessionId, 3000);
        ingest(planPath, sessionId, eventsDir);
        const budgetPolicy = await policyFile(sessionId, { cap_tokens: 5000 });

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          '--budget-policy',
          budgetPolicy,
          '--override-rationale',
          'Operator: the cap moves next epic; this wave finishes the migration.',
        ]);

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).budget.status).toBe('refused');

        const admitted = tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted');
        expect(admitted).toHaveLength(1);
        expect(admitted[0]?.payload.budget).toMatchObject({
          status: 'refused',
          cap_tokens: 5000,
          wave_tokens: 6000,
          override_rationale:
            'Operator: the cap moves next epic; this wave finishes the migration.',
        });
      });

      it('refuses a blank --override-rationale rather than recording an empty reason', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = await pricedPlan(sessionId, 3000);
        ingest(planPath, sessionId, eventsDir);
        const budgetPolicy = await policyFile(sessionId, { cap_tokens: 5000 });

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          '--budget-policy',
          budgetPolicy,
          '--override-rationale',
          '   ',
        ]);

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.blank-override-rationale');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      // `epic.max_in_flight_tasks` reached budgets.yml as the operator's own
      // wall-clock/rate-limit bound — null by default, because fan-out is
      // bounded by the claim graph and cost by the token cap. Set, it has to
      // mean something.
      it('refuses a wave that would put more tasks in flight than the fan-out cap allows', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = await pricedPlan(sessionId, 1000);
        ingest(planPath, sessionId, eventsDir);
        const budgetPolicy = await policyFile(sessionId, {
          cap_tokens: 4_000_000,
          max_in_flight_tasks: 1,
        });

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          '--budget-policy',
          budgetPolicy,
        ]);

        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.valid).toBe(true);
        expect(parsed.budget).toMatchObject({
          status: 'over-fan-out',
          inFlightTasks: 0,
          maxInFlightTasks: 1,
          waveTaskCount: 2,
        });
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      /** Put a log-only task in the register, the way `findings raise` does. */
      async function logOnlyTask(sessionId: string, eventsDir: string, taskId: string) {
        const append = runCli([
          'event',
          'append',
          JSON.stringify({
            session_id: sessionId,
            actor: 'system',
            event_type: 'task-added',
            task_id: taskId,
            plan_version: 1,
            causal_parent: `${sessionId}#0`,
            payload: { epic_id: 'epic-1', claims: ['src/baz/*.ts'] },
          }),
          '--state-dir',
          eventsDir,
        ]);
        expect(append.status).toBe(0);
      }

      // Two silences that look alike in a sum and are not alike at all, so the
      // pair is asserted together: what the plan left blank, and what no plan
      // ever had a field for.

      // D-48/P9-31: a follow-up minted by `findings raise` exists only in the
      // log, and the log records its claims, never its budget — there was no
      // field to leave blank. Refusing it would make the factory's own repair
      // path reachable only by hand-editing the plan the follow-up exists to
      // avoid, which is guard.sh's deny-on-unavailable trap again: not safe,
      // stuck. The policy prices it at the coder cap instead — the most it may
      // spend — so the cap is enforced against a real number.
      it('prices a log-only follow-up at the coder cap rather than refusing it', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        ingest(planPath, sessionId, eventsDir);
        await logOnlyTask(sessionId, eventsDir, 'epic-1/followup-cd34');

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'epic-1/followup-cd34',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);

        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.valid).toBe(true);
        expect(parsed.budget.status).toBe('ok');
        expect(parsed.budget.unpricedTasks).toEqual([]);
        // 1000 from the fixture plan's task-1, plus the coder cap for the one
        // nothing declared. Read off the policy so the assertion cannot drift
        // from budgets.yml, but pinned as a sum so a silent 0 would fail.
        const coderCap = loadBudgetPolicy(undefined, {}).task.coder.capTokens;
        expect(parsed.budget.waveTokens).toBe(1000 + coderCap);
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted'),
        ).toHaveLength(1);
      });

      // The same wave, against a cap the coder-cap price cannot fit under: the
      // pricing above is a real charge, not a way past the gate.
      it('refuses that same follow-up when the coder cap will not fit under the epic cap', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        ingest(planPath, sessionId, eventsDir);
        await logOnlyTask(sessionId, eventsDir, 'epic-1/followup-cd34');
        const budgetPolicy = await policyFile(sessionId, { cap_tokens: 5000 });

        const result = runCli([
          'wave',
          'check',
          planPath,
          'epic-1/followup-cd34',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          '--budget-policy',
          budgetPolicy,
        ]);

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).budget.status).toBe('refused');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      // The other silence. `task-spec.schema.json` requires `budget.tokens`,
      // so a plan reaching this gate without one never passed `smith plan
      // validate` — and `wave check` reads its plan with a bare cast rather
      // than re-validating it. An unpriced spec is a plan defect one edit
      // fixes, so refusing names it where it can be acted on.
      it('refuses a wave whose plan declares a task with no budget at all', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = path.join(scratchDir, `${sessionId}-unpriced.json`);
        const [first, second] = PLAN.tasks;
        await writeFile(
          planPath,
          JSON.stringify({
            ...PLAN,
            tasks: [first, { ...second, budget: { diff_lines: 100 } }],
          }),
        );
        ingest(planPath, sessionId, eventsDir);

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);

        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.error).toBeUndefined();
        expect(parsed.valid).toBe(true);
        expect(parsed.budget.status).toBe('unverifiable');
        expect(parsed.budget.unpricedTasks).toEqual(['epic-1/task-2']);
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      // F0's lesson, applied to this gate: one silent yes for both "checked,
      // and it fits" and "could not check" is the failure mode, not the
      // convenience. Without --session there is no log to read the epic's
      // spend from, so `ok` would be an answer the gate never reached.
      it('reports a session-less check as unchecked rather than ok', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const result = runCli(['wave', 'check', planPath, 'task-1', '--dry']);

        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.valid).toBe(true);
        expect(parsed.budget.status).toBe('unchecked');
        expect(parsed.budget.detail).toMatch(/--session/);
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      // An admission that passed the gate has to be as readable afterward as
      // one that was overridden — otherwise the log records only refusals,
      // and "was this ever checked?" has no answer for the waves that were.
      it('records what the gate saw on an admission that fits', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = await pricedPlan(sessionId, 1000);
        ingest(planPath, sessionId, eventsDir);
        const budgetPolicy = await policyFile(sessionId, { cap_tokens: 4_000_000 });

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          '--budget-policy',
          budgetPolicy,
        ]);

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).budget.status).toBe('ok');

        const admitted = tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted');
        expect(admitted).toHaveLength(1);
        expect(admitted[0]?.payload.budget).toEqual({
          status: 'ok',
          // PLAN declares no `effort` and trips no security trigger, so the
          // cap was sized for effort.yml's `default_tier`.
          tier: 'medium',
          cap_tokens: 4_000_000,
          projected_tokens: 0,
          wave_tokens: 2000,
          headroom_tokens: 4_000_000,
        });
      });

      // `cap_tokens` is a number for one tier, and the log never said which.
      // A reader of the log alone (no plan file, no DB) could not tell a small
      // epic's cap from a huge one's, so the admission records the tier its
      // cap was sized for beside the cap itself.
      describe('records the tier the cap was sized for', () => {
        /** One cap per tier, far enough apart that the recorded cap names the tier too. */
        async function tieredPolicy(name: string): Promise<string> {
          const policyPath = path.join(scratchDir, `${name}-tier-budgets.yml`);
          await writeFile(
            policyPath,
            'epic:\n  cap_tokens:\n    small: 50000\n    medium: 500000\n    huge: 5000000\n' +
              '  alarm_ratio: 0.7\n  max_in_flight_tasks: null\n',
          );
          return policyPath;
        }

        /** The two-task fixture under `effort`, with `task-1` given `taskOneCase`. */
        async function effortPlan(name: string, effort: string, taskOneCase = 'feature') {
          const planPath = path.join(scratchDir, `${name}-${effort}-${taskOneCase}-plan.json`);
          await writeFile(
            planPath,
            JSON.stringify({
              ...PLAN,
              effort,
              tasks: PLAN.tasks.map((task, i) => (i === 0 ? { ...task, case: taskOneCase } : task)),
            }),
          );
          return planPath;
        }

        function check(planPath: string, budgetPolicy: string, extra: string[] = []) {
          return runCli([
            'wave',
            'check',
            planPath,
            'task-1',
            'task-2',
            '--budget-policy',
            budgetPolicy,
            ...extra,
          ]);
        }

        it("records the plan's own effort tier", async () => {
          const { sessionId, eventsDir } = await session();
          const planPath = await effortPlan(sessionId, 'small');
          ingest(planPath, sessionId, eventsDir);
          const budgetPolicy = await tieredPolicy(sessionId);

          const result = check(planPath, budgetPolicy, [
            '--session',
            sessionId,
            '--causal-parent',
            `${sessionId}#0`,
            '--state-dir',
            eventsDir,
          ]);
          expect(result.status).toBe(0);

          const admitted = tail(sessionId, eventsDir).filter(
            (r) => r.event_type === 'wave-admitted',
          );
          expect(admitted).toHaveLength(1);
          expect(admitted[0]?.payload.budget).toEqual({
            status: 'ok',
            tier: 'small',
            cap_tokens: 50_000,
            projected_tokens: 0,
            wave_tokens: 2000,
            headroom_tokens: 50_000,
          });
          expect(JSON.parse(result.stdout).budget).toMatchObject({
            tier: 'small',
            capTokens: 50_000,
          });
        });

        it('records the tier the security floor raised it to, not the one the plan asked for', async () => {
          const { sessionId, eventsDir } = await session();
          // effort.yml: an `infra` task trips a crosscheck.yml security
          // trigger, and the floor lifts `small` to `security_floor: medium`.
          const planPath = await effortPlan(sessionId, 'small', 'infra');
          ingest(planPath, sessionId, eventsDir);
          const budgetPolicy = await tieredPolicy(sessionId);

          const result = check(planPath, budgetPolicy, [
            '--session',
            sessionId,
            '--causal-parent',
            `${sessionId}#0`,
            '--state-dir',
            eventsDir,
          ]);
          expect(result.status).toBe(0);

          const admitted = tail(sessionId, eventsDir).filter(
            (r) => r.event_type === 'wave-admitted',
          );
          expect(admitted).toHaveLength(1);
          expect(admitted[0]?.payload.budget).toMatchObject({
            tier: 'medium',
            cap_tokens: 500_000,
          });
        });

        // No session means a `--dry` question, no admission and nothing
        // logged, but the printed `capTokens` is still a number for one tier:
        // the tier rides with it.
        it('prints the tier on a session-less dry check too', async () => {
          const { sessionId } = await session();
          const planPath = await effortPlan(sessionId, 'huge');
          const budgetPolicy = await tieredPolicy(sessionId);

          const result = check(planPath, budgetPolicy, ['--dry']);
          expect(result.status).toBe(0);
          expect(JSON.parse(result.stdout).budget).toMatchObject({
            status: 'unchecked',
            tier: 'huge',
            capTokens: 5_000_000,
          });
        });
      });
    });

    // A lineage carries every epic that ever ran a session in it, not just
    // the one the plan in hand belongs to. `wave next` reads `--session`
    // lineage-wide (D-119) so a resumed session still sees its own follow-up
    // tasks and live statuses -- but that read must not hand a DIFFERENT
    // epic's rows to THIS plan's proposal. An older epic's task, left
    // non-terminal in the log (never merged, abandoned, or superseded), is
    // exactly the row `wave check` never sees either: it only ever looks at
    // the ids an operator names, which is why bypassing the stall with `wave
    // check <plan> <task-id>` alone admitted the task `wave next` refused.
    describe("wave next: scoped to the plan's own epic", () => {
      it('never proposes, defers, or occupies a task logged under a different epic', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        // Simulates epic-0's leftover row: a `task-added` for another epic,
        // in the same session lineage, whose claim overlaps task-1's -- and
        // which never advanced past `todo`, so it is exactly the "abandoned,
        // never merged, never superseded" row the bug report describes.
        const leak = runCli([
          'event',
          'append',
          JSON.stringify({
            session_id: sessionId,
            actor: 'system',
            event_type: 'task-added',
            task_id: 'epic-0/task-9',
            plan_version: 1,
            causal_parent: `${sessionId}#0`,
            payload: { epic_id: 'epic-0', claims: ['src/foo/*.ts'] },
          }),
          '--state-dir',
          eventsDir,
        ]);
        expect(leak.status).toBe(0);
        // A genuine follow-up of THIS epic, log-only the way `findings raise`
        // mints one: the filter must keep adopting it.
        const own = runCli([
          'event',
          'append',
          JSON.stringify({
            session_id: sessionId,
            actor: 'system',
            event_type: 'task-added',
            task_id: 'epic-1/followup-cd34',
            plan_version: 1,
            causal_parent: `${sessionId}#0`,
            payload: { epic_id: 'epic-1', claims: ['src/qux/*.ts'] },
          }),
          '--state-dir',
          eventsDir,
        ]);
        expect(own.status).toBe(0);

        const result = runCli([
          'wave',
          'next',
          planPath,
          '--repo',
          scratchDir,
          '--session',
          sessionId,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        const proposal = JSON.parse(result.stdout);
        expect(proposal.epicId).toBe('epic-1');

        // The other epic's row must not appear anywhere in the answer --
        // not admitted, not deferred, not counted as done or occupied.
        const seen = [
          ...proposal.wave,
          ...proposal.deferred.map((d: { taskId: string }) => d.taskId),
          ...proposal.done,
          ...proposal.occupied,
        ];
        expect(seen).not.toContain('epic-0/task-9');

        // And its claim on `src/foo/*.ts` must not have cost task-1 its
        // admission: all of this epic's tasks run, the log-only one included, claim-disjoint from each
        // other, exactly as `wave check` already treats a stale foreign row
        // -- it never once compares against it.
        expect(proposal.wave.sort()).toEqual([
          'epic-1/followup-cd34',
          'epic-1/task-1',
          'epic-1/task-2',
        ]);
        expect(proposal.deferred).toEqual([]);
      });
    });
  });
});
