import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import {
  analytics,
  errorsPage,
  flowGraph,
  kanban,
  LESSON_BUCKET_FOR_STATUS,
  lessonsPage,
  overview,
  pulse,
  taskDetail,
  timeline,
} from '../../src/db/queries.js';
import { eventsRaw } from '../../src/db/schema.js';
import { appendEvent, type EventOpts, readEvents } from '../../src/events.js';
import type { EventContext } from '../../src/findings.js';
import { raiseFinding, transition } from '../../src/findings.js';
import { loadTaxonomy } from '../../src/taxonomy.js';
import { buildFixture, EPIC_ID, SESSION_ID, TASK_1, TASK_2, TASK_3, TASK_4 } from './fixtures.js';

/** raiseFinding()/transition() return the Finding, not the event id — read the
 * log back so the next event's causal_parent stays accurate (as fixtures.ts does). */
async function lastEventId(opts: EventOpts): Promise<string> {
  const events = await readEvents(SESSION_ID, opts);
  const last = events[events.length - 1];
  if (!last) throw new Error('expected at least one event in the log');
  return last.event_id;
}

/** The projection's own row count, so the pulse assertion is not a magic number
 * that has to be re-counted every time the fixture grows an event. */
function readEventCount(handle: DbHandle): number {
  return handle.db.select().from(eventsRaw).all().length;
}

describe('db/queries.ts', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-queries-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-queries-db-'));
    await buildFixture({ stateDir });
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  describe('overview()', () => {
    it('reports the two live agents, epics in flight, token spend vs budget, and alerts', () => {
      const result = overview(handle.db);

      expect(result.liveAgentCount).toBe(2); // task-2 and task-4 still have no terminal event
      expect(result.liveAgents.sort((a, b) => a.provider.localeCompare(b.provider))).toEqual([
        { agentRole: 'coder', provider: 'claude', modelTier: 'mid', count: 1 }, // task-4
        { agentRole: 'coder', provider: 'codex', modelTier: 'small', count: 1 }, // task-2
      ]);
      // Phase 6b round 4 — per-agent entries (Overview's compact live-agents
      // grid needs each running agent's own task id, not just role/tier
      // counts).
      expect(
        result.liveAgentEntries
          .map((a) => ({ agentRole: a.agentRole, modelTier: a.modelTier, taskId: a.taskId }))
          .sort((a, b) => (a.taskId ?? '').localeCompare(b.taskId ?? '')),
      ).toEqual([
        { agentRole: 'coder', modelTier: 'small', taskId: TASK_2 },
        { agentRole: 'coder', modelTier: 'mid', taskId: TASK_4 },
      ]);
      expect(result.epicsInFlight).toEqual([EPIC_ID]); // task-2 "reviewing", task-4 "in-progress"
      expect(result.tokensByEpic).toEqual([
        { epicId: EPIC_ID, tokensSpent: 2000, tokensBudget: 4300 },
      ]);
      expect(result.alerts).toEqual({ escalations: 1, pendingWaivers: 0 });
    });

    it('scopes to one session when a sessionId is given', () => {
      const result = overview(handle.db, { sessionId: SESSION_ID });
      expect(result.liveAgentCount).toBe(2);

      const empty = overview(handle.db, { sessionId: 'no-such-session' });
      expect(empty.liveAgentCount).toBe(0);
      expect(empty.epicsInFlight).toEqual([]);
    });
  });

  describe('timeline()', () => {
    it('interleaves task-1 events in ts order, including finding-transitioned and gate-outcome', () => {
      const entries = timeline(handle.db, { sessionId: SESSION_ID, taskId: TASK_1 });
      const types = entries.map((e) => e.eventType);

      expect(types).toEqual([
        'task-added',
        'dispatch_decision',
        'schema-check-result',
        'testgate-result',
        'finding-raised',
        'severity-decisions',
        'gate-outcome',
        'finding-transitioned',
        'finding-transitioned',
        'finding-transitioned',
        'finding-transitioned',
        // The worker's own Result, which the eventType filter used to drop:
        // the timeline showed every gate's opinion of the work and never the
        // work. FREE_TIMELINE_EVENT_TYPES now carries it.
        'task-result-recorded',
        'gate-outcome',
        'severity-decisions', // the same-mistake decision, also tagged task-1
      ]);
      // Non-decreasing timestamps (interleaved chronologically).
      const timestamps = entries.map((e) => e.ts);
      expect([...timestamps].sort()).toEqual(timestamps);
    });

    it('includes the error-logged event on task-3', () => {
      const entries = timeline(handle.db, { sessionId: SESSION_ID, taskId: TASK_3 });
      expect(entries.map((e) => e.eventType)).toEqual([
        'task-added',
        'dispatch_decision',
        'error-logged',
      ]);
    });

    // -----------------------------------------------------------------------
    // D-206: the epic lens read the epic out of the *task id* prefix, so an
    // event that belongs to the epic itself -- and therefore carries no task
    // id at all -- vanished from it. `wave-admitted` and `wave-merged` name
    // their epic in the payload; the graph events are the ones an operator
    // opens an epic timeline to see.
    // -----------------------------------------------------------------------

    it('keeps the epic-level graph events, which name the epic in the payload (D-206)', () => {
      const types = timeline(handle.db, { sessionId: SESSION_ID, epicId: EPIC_ID }).map(
        (e) => e.eventType,
      );
      expect(types).toContain('wave-admitted');
      expect(types).toContain('wave-merged');
    });

    it('still returns every task-scoped event of that epic (D-206)', () => {
      const entries = timeline(handle.db, { sessionId: SESSION_ID, epicId: EPIC_ID });
      const taskIds = new Set(entries.map((e) => e.taskId).filter(Boolean));
      expect(taskIds).toEqual(new Set([TASK_1, TASK_2, TASK_3, TASK_4]));
    });

    it('does not widen the lens: another epic id matches nothing (D-206)', () => {
      expect(timeline(handle.db, { sessionId: SESSION_ID, epicId: 'epic-2' })).toEqual([]);
    });

    it('does not let a bare task id answer for an epic of the same name (D-206)', async () => {
      // The log carries unqualified task ids from before D-46/P9-10, and the
      // hand-rolled `split('/')[0]` this filter used to spell read one as an
      // epic named after itself. `epicOfTaskId` says null instead (D-49).
      await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'operator',
          event_type: 'operator-note',
          task_id: 'task-9-legacy',
          plan_version: 1,
          causal_parent: await lastEventId({ stateDir }),
          payload: { note: 'A note on a task id written before ids were qualified.' },
        },
        { stateDir },
      );
      const dbPath = path.join(dbDir, 'bare-task-id.db');
      await rebuild(dbPath, 'all', { stateDir });
      const bareHandle = openDb(dbPath);
      try {
        const all = timeline(bareHandle.db, { sessionId: SESSION_ID });
        expect(all.map((e) => e.taskId)).toContain('task-9-legacy');
        expect(timeline(bareHandle.db, { sessionId: SESSION_ID, epicId: 'task-9-legacy' })).toEqual(
          [],
        );
      } finally {
        bareHandle.sqlite.close();
      }
    });

    it('expands the causal-parent chain for one event, oldest first, ending at that event', () => {
      const entries = timeline(handle.db, { sessionId: SESSION_ID, taskId: TASK_3 });
      const errorEntry = entries.find((e) => e.eventType === 'error-logged');
      expect(errorEntry).toBeDefined();

      const chain = timeline(handle.db, {
        sessionId: SESSION_ID,
        causalChainFor: (errorEntry as (typeof entries)[number]).eventId,
      });
      expect(chain[0]?.eventType).toBe('session-start');
      expect(chain[chain.length - 1]?.eventId).toBe(errorEntry?.eventId);
      // Every entry's causal_parent (except the root) is the previous entry's id.
      for (let i = 1; i < chain.length; i++) {
        expect(chain[i]?.causalParent).toBe(chain[i - 1]?.eventId);
      }
    });
  });

  describe('kanban()', () => {
    it("groups the epic's tasks by task_status with case/origin/severity tags", () => {
      const columns = kanban(handle.db, EPIC_ID);
      const byStatus = Object.fromEntries(columns.map((c) => [c.taskStatus, c.tasks]));

      expect(byStatus.completed).toEqual([
        {
          taskId: TASK_1,
          taskStatus: 'completed',
          title: 'Add the widget renderer.',
          agentRole: 'coder',
          agentModelTier: 'mid',
          milestoneId: null,
          tags: { case: 'feature', origin: 'user', severity: null },
        },
      ]);
      // task-2's only finding is waived (not "open"), so no severity chip.
      expect(byStatus.reviewing).toEqual([
        {
          taskId: TASK_2,
          taskStatus: 'reviewing',
          title: 'Simplify the config loader.',
          agentRole: 'coder',
          agentModelTier: 'small',
          milestoneId: null,
          tags: { case: 'refactor', origin: 'user', severity: null },
        },
      ]);
      expect(byStatus.escalated).toEqual([
        {
          taskId: TASK_3,
          taskStatus: 'escalated',
          title: 'Fix the flaky import resolution.',
          agentRole: 'coder',
          agentModelTier: 'small',
          milestoneId: null,
          tags: { case: 'bugfix', origin: 'user', severity: null },
        },
      ]);
      // task-4's finding-4 sits at "confirmed" — open, not waived/fixed — so
      // its severity DOES surface as a chip (reviewer finding: a fixture gap
      // meant no test ever exercised the 'confirmed' branch of the open-
      // finding-statuses check).
      expect(byStatus['in-progress']).toEqual([
        {
          taskId: TASK_4,
          taskStatus: 'in-progress',
          title: 'Add the settings panel.',
          agentRole: 'coder',
          agentModelTier: 'mid',
          milestoneId: null,
          tags: { case: 'feature', origin: 'user', severity: 'S2-major' },
        },
      ]);
    });

    it('supports an "all epics" mode when epicId is omitted', () => {
      const columns = kanban(handle.db);
      const allTaskIds = columns.flatMap((c) => c.tasks.map((t) => t.taskId)).sort();
      expect(allTaskIds).toEqual([TASK_1, TASK_2, TASK_3, TASK_4].sort());
    });

    it('surfaces the worst open finding severity as a tag chip', () => {
      // finding-1 passes through raised (S2) before being fixed; while still
      // open its severity is the kanban chip on whatever status task-1 was in.
      const columns = kanban(handle.db, EPIC_ID);
      const allTasks = columns.flatMap((c) => c.tasks);
      expect(allTasks.find((t) => t.taskId === TASK_1)?.tags.severity).toBeNull(); // fix-verified is closed
      // finding-4 stays "confirmed" (never fixed or waived) — still open.
      expect(allTasks.find((t) => t.taskId === TASK_4)?.tags.severity).toBe('S2-major');
    });

    it('counts an amend-pending finding as open (D-127)', async () => {
      // `amend-pending` is the state an unwaivable finding sits in between the
      // plan amendment being written and the tasks it obligates actually
      // landing. Nothing is discharged yet — the amendment is a promise, not a
      // fix — so the chip must still show the severity. Dropping the status
      // from OPEN_FINDING_STATUSES makes writing an amendment look, on the
      // board, exactly like fixing the finding, which is D-127 itself.
      const ctx: EventContext = {
        sessionId: SESSION_ID,
        planVersion: 1,
        causalParent: await lastEventId({ stateDir }),
      };
      const raised = await raiseFinding(
        {
          finding: {
            finding_id: 'finding-amend',
            task_id: TASK_3,
            finding_category: 'correctness',
            finding_scope: 'spec',
            spec_ref: {
              plan_version: 1,
              criterion_ref: 'a claim conflict resolves deterministically',
            },
            severity: 'S1-stop-the-line',
            finding_status: 'raised',
            summary: 'the plan never says what happens on a deadlocked claim',
            failure_scenario: {
              inputs: 'two workers claim the same path',
              expected: 'the spec names a winner',
              actual: 'the spec is silent',
            },
            found_by: 'spec-reviewer',
          },
          filePath: 'src/claims.ts',
        },
        ctx,
        { stateDir },
      );
      if (raised.suppressed) throw new Error('finding-amend unexpectedly suppressed');
      await transition(
        'finding-amend',
        'amend-pending',
        { ...ctx, causalParent: await lastEventId({ stateDir }) },
        { stateDir },
        { amendsTaskIds: [TASK_3], amendsPlanVersion: 2 },
      );

      const dbPath = path.join(dbDir, 'amend-pending.db');
      await rebuild(dbPath, 'all', { stateDir });
      const amendHandle = openDb(dbPath);
      try {
        const tasks = kanban(amendHandle.db, EPIC_ID).flatMap((c) => c.tasks);
        expect(tasks.find((t) => t.taskId === TASK_3)?.tags.severity).toBe('S1-stop-the-line');
      } finally {
        amendHandle.sqlite.close();
      }
    });
  });

  describe('flowGraph() (Phase 6b Flow page)', () => {
    it('returns every scoped task as a node, the dependency edge, and wave bands', () => {
      const graph = flowGraph(handle.db, { epicId: EPIC_ID });
      const nodeIds = graph.nodes.map((n) => n.taskId).sort();
      expect(nodeIds).toEqual([TASK_1, TASK_2, TASK_3, TASK_4].sort());
      // fixtures.ts records TASK_2 depends_on TASK_1.
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ task: TASK_2, dependsOn: TASK_1, edgeType: 'artifact' }),
      );
      const task1 = graph.nodes.find((n) => n.taskId === TASK_1);
      const task2 = graph.nodes.find((n) => n.taskId === TASK_2);
      expect(task1?.wave).toBe(0);
      expect(task2?.wave).toBe(1); // depends on task-1 -> one wave later
      expect(graph.waves[0]).toEqual(expect.arrayContaining([TASK_1]));
    });
  });

  describe('taskDetail()', () => {
    it('returns spec fields, claims, attempts, findings, artifacts, and branch for task-1', () => {
      const detail = taskDetail(handle.db, TASK_1);
      expect(detail).not.toBeNull();
      expect(detail?.task.objective).toBe('Add the widget renderer.');
      expect(detail?.claims).toEqual(['src/widget.ts']);
      expect(detail?.attempts).toHaveLength(1);
      // task-1's one dispatch was closed by a task-result-recorded -> 'done' in the agents fold.
      expect(detail?.attempts[0]).toMatchObject({
        agentRole: 'coder',
        provider: 'claude',
        agentStatus: 'done',
      });
      expect(detail?.attempts[0]?.terminalAt).not.toBeNull();
      expect(detail?.agents).toHaveLength(1);
      expect(detail?.agents[0]).toMatchObject({ agentRole: 'coder', status: 'done' });
      expect(detail?.findings).toHaveLength(1);
      expect(detail?.findings[0]).toMatchObject({
        findingId: 'finding-1',
        findingStatus: 'fix-verified',
      });
      expect(detail?.artifacts).toHaveLength(1);
      expect(detail?.branch).toBe(`smith/${EPIC_ID}/task-1`);
    });

    it('returns null for an unknown task', () => {
      expect(taskDetail(handle.db, 'epic-1/does-not-exist')).toBeNull();
    });
  });

  describe('lessonsPage()', () => {
    it('lists the approved lesson with its times-prevented counter', () => {
      const result = lessonsPage(handle.db);
      expect(result.pending).toEqual([]);
      expect(result.approved).toHaveLength(1);
      expect(result.approved[0]).toMatchObject({ lessonId: 'lesson-1', timesPrevented: 1 });
    });

    /**
     * D-220. The page buckets lessons for the operator, and a lesson that is
     * in no bucket is a lesson no surface can render. `invalidated` is what the
     * Lessons page's own Reject button writes, so dropping it means rejecting a
     * lesson makes it vanish rather than close — the opposite of architecture
     * §9.6's "traceable rollback, never silent deletion".
     */
    it('keeps a rejected lesson reachable in the closed bucket', () => {
      const result = lessonsPage(handle.db);
      expect(result.closed.map((l) => l.lessonId)).toEqual(['lesson-2']);
      expect(result.closed[0]).toMatchObject({ lessonStatus: 'invalidated' });
    });

    it('buckets every lesson_status the taxonomy declares', () => {
      const declared = loadTaxonomy().dimensions.lesson_status as string[];
      expect(declared.length).toBeGreaterThan(0);
      expect(
        declared.filter((s) => !(s in LESSON_BUCKET_FOR_STATUS)),
        'lesson statuses no bucket claims — rows in them reach no surface',
      ).toEqual([]);
      expect(Object.keys(LESSON_BUCKET_FOR_STATUS).sort()).toEqual([...declared].sort());
    });
  });

  describe('errorsPage()', () => {
    it('groups the one error by class and buckets it by day', () => {
      const result = errorsPage(handle.db);
      expect(result.byClass).toEqual([
        {
          id: 'coordination.deadlock|S1-stop-the-line',
          errorGroup: 'coordination',
          errorClass: 'deadlock',
          severity: 'S1-stop-the-line',
          count: 1,
        },
      ]);
      expect(result.byDay).toHaveLength(1);
      expect(result.byDay[0]?.count).toBe(1);
    });
  });

  describe('pulse()', () => {
    it('names the newest event and counts what the shell watches for arrivals', () => {
      const result = pulse(handle.db);

      // The same event overview()'s session row reports as the fixture's last.
      expect(result.lastEventType).toBe('finding-transitioned');
      expect(result.lastEventAt).not.toBeNull();
      expect(result.counts.events).toBe(readEventCount(handle));
      expect(result.counts.errors).toBe(1); // the one error errorsPage() groups
      // lesson-1 is approved and lesson-2 invalidated — nothing is waiting.
      expect(result.lessonsPending).toBe(0);
    });

    it('answers for an empty scope without pretending the log said something', () => {
      const result = pulse(handle.db, { sessionId: 'no-such-session' });
      expect(result).toEqual({
        lastEventAt: null,
        lastEventType: null,
        counts: { events: 0, errors: 0 },
        lessonsPending: 0,
      });
    });

    it('counts a lesson still waiting on the operator', async () => {
      const parent = await lastEventId({ stateDir });
      await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'scribe',
          event_type: 'lesson-candidate-raised',
          plan_version: 1,
          causal_parent: parent,
          payload: {
            lesson_id: 'lesson-3',
            lesson_type: 'rule',
            lesson_level: 'principle',
            lesson_status: 'candidate',
            lesson_scope: 'stack-wide',
            statement: 'Read the tail of check.sh, not its exit code.',
            valid_from: '2026-08-27T00:00:00.000Z',
            provenance_event_ids: [parent],
          },
        },
        { stateDir },
      );
      const dbPath = path.join(dbDir, 'smith-pulse.db');
      await rebuild(dbPath, 'all', { stateDir });
      const fresh = openDb(dbPath);
      try {
        expect(pulse(fresh.db).lessonsPending).toBe(1);
      } finally {
        fresh.sqlite.close();
      }
    });
  });

  describe('analytics()', () => {
    it('computes throughput, cost per model_tier/provider, same-mistake rate, and recheck outcomes', () => {
      const result = analytics(handle.db);

      expect(result.throughput).toHaveLength(1);
      expect(result.throughput[0]?.completed).toBe(1); // task-1 completed

      expect(result.costByModelTierAndProvider).toEqual([
        {
          modelTier: 'mid',
          provider: 'claude',
          taskCount: 1,
          totalTokens: 2000,
          avgTokensPerTask: 2000,
        },
      ]);

      // Three severity-decisions events fire across the session: task-1's
      // initial one, task-2's waiver-batch one, and task-1's later
      // same-mistake one that matches lesson-1 — analytics() is session-wide,
      // not scoped to one task.
      const totalDecisions = result.sameMistakeRateByDay.reduce((sum, d) => sum + d.decisions, 0);
      const totalSameMistake = result.sameMistakeRateByDay.reduce(
        (sum, d) => sum + d.sameMistake,
        0,
      );
      expect(totalDecisions).toBe(3);
      expect(totalSameMistake).toBe(1);

      expect(result.recheckOutcomes).toEqual([]); // fixture has no origin:recheck tasks
      // Every fixture intake decided something, so every day has a denominator.
      expect(result.sameMistakeRateByDay.every((d) => d.rate !== null)).toBe(true);
    });

    it('reports no rate at all — not zero — for a day whose intakes decided nothing', async () => {
      // D-31. An intake with `decisions: []` is the gate saying "I looked and
      // found nothing to decide". Bucketing that day at rate 0 makes it read
      // identically to a day the gate saw findings and cleared every one, and
      // that is the number `smith stats analytics` has been printing.
      //
      // Written raw rather than through appendEvent because the point is the
      // DAY: appendEvent stamps `new Date()`, which would fold this event into
      // the fixture's own day and leave the zero-denominator bucket unreachable.
      const logFile = path.join(stateDir, `${SESSION_ID}.jsonl`);
      await appendFile(
        logFile,
        `${JSON.stringify({
          session_id: SESSION_ID,
          actor: 'orchestrator',
          event_type: 'severity-decisions',
          task_id: TASK_1,
          plan_version: 1,
          causal_parent: `${SESSION_ID}#0`,
          payload: { decisions: [] },
          ts: '2020-01-01T00:00:00.000Z',
        })}\n`,
        'utf8',
      );
      const dbPath = path.join(dbDir, 'silent-day.db');
      await rebuild(dbPath, 'all', { stateDir });
      const silentHandle = openDb(dbPath);
      try {
        const day = analytics(silentHandle.db).sameMistakeRateByDay.find(
          (d) => d.day === '2020-01-01',
        );
        expect(day).toEqual({ day: '2020-01-01', decisions: 0, sameMistake: 0, rate: null });
      } finally {
        silentHandle.sqlite.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// D-43/P9-27. `epicsInFlight` was computed from non-terminal task statuses
// alone, so an epic closed by operator override — which is exactly the case
// where a task is left non-terminal — stayed "in flight" forever. The Overview
// StatCard, the Overview list, and both epic pickers all read this one field.
// ---------------------------------------------------------------------------
describe('overview() — closed epics (D-43/P9-27)', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-close-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-close-db-'));
    await buildFixture({ stateDir });
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  async function project(): Promise<DbHandle> {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    return openDb(dbPath);
  }

  it('reports the epic in flight while no close is on the log', async () => {
    handle = await project();
    const result = overview(handle.db);
    expect(result.epicsInFlight).toEqual([EPIC_ID]);
    expect(result.closedEpics).toEqual([]);
  });

  it('drops a closed epic out of in-flight and reports how it was closed', async () => {
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'operator',
        event_type: 'epic-closed',
        task_id: `${EPIC_ID}/integration`,
        plan_version: 1,
        causal_parent: `${SESSION_ID}#0`,
        payload: {
          epic_id: EPIC_ID,
          closed_by: 'operator-override',
          machine_verdict: 'hold',
          machine_reason: 'mechanical-blockers',
          override_rationale: 'Remaining blockers are carry-forward defects.',
          blockers: ['Task "epic-1/task-4" is not terminal-OK (status: in-progress).'],
        },
      },
      { stateDir },
    );
    handle = await project();

    const result = overview(handle.db);
    expect(result.epicsInFlight).toEqual([]);
    expect(result.closedEpics).toHaveLength(1);
    expect(result.closedEpics[0]).toMatchObject({
      epicId: EPIC_ID,
      closedBy: 'operator-override',
      machineVerdict: 'hold',
      overrideRationale: 'Remaining blockers are carry-forward defects.',
    });
  });
});

// P9-37: the timeline's event-type allowlist is a hand-written copy of the
// taxonomy's `gate_event` dimension, and it had fallen eight values behind —
// `deps-check-result` even has an icon and a title in ui/src/lib/
// timelineDisplay.ts that could never fire, because the query dropped the row
// before the renderer saw it. §7 calls the interleaved timeline "a hard
// requirement" and says "errors and gate results attach to the same timeline";
// a gate result the operator cannot see is one the factory may as well not
// have logged. This test is the standing guard on that copy.
describe('timeline() covers the gate/graph event vocabulary (P9-37)', () => {
  const DRIFT_TASK = `${EPIC_ID}/task-drift`;
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-drift-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-drift-db-'));
    await buildFixture({ stateDir });
  });

  afterEach(async () => {
    handle?.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  /**
   * An empty payload is enough for every event whose only reader here is the
   * timeline — the exceptions are the ones a reader also rehydrates into a
   * typed record, which need every field that schema declares required.
   *
   * D-135: `finding-raised` used to carry only the fields the projector's
   * fold reads, and appendEvent accepted it, because the event schema types
   * `payload` as an open object. It is now checked against
   * finding.schema.json at write time, so this fixture has to be a real
   * finding rather than the subset one reader happened to need.
   */
  const PAYLOADS: Record<string, Record<string, unknown>> = {
    'finding-raised': {
      finding_id: 'F-drift',
      task_id: DRIFT_TASK,
      epic_id: EPIC_ID,
      fingerprint: 'drift-fp',
      file_path: 'src/drift.ts',
      finding_category: 'correctness',
      severity: 'S3-minor',
      finding_status: 'raised',
      summary: 'Drift guard fixture finding.',
      failure_scenario: {
        inputs: 'the drift fixture',
        expected: 'the timeline lists the event',
        actual: 'the timeline lists the event',
      },
      found_by: 'reviewer',
    },
  };

  async function projectWithOneEventPerType(eventTypes: string[]): Promise<Set<string>> {
    for (const eventType of eventTypes) {
      await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'system',
          event_type: eventType,
          task_id: DRIFT_TASK,
          plan_version: 1,
          causal_parent: `${SESSION_ID}#0`,
          payload: PAYLOADS[eventType] ?? {},
        },
        { stateDir },
      );
    }

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);

    return new Set(
      timeline(handle.db, { sessionId: SESSION_ID, taskId: DRIFT_TASK }).map((e) => e.eventType),
    );
  }

  it('returns every gate_event value the taxonomy declares', async () => {
    const gateEvents = loadTaxonomy().dimensions.gate_event as string[];
    expect(gateEvents.length).toBeGreaterThan(0);

    const shown = await projectWithOneEventPerType(gateEvents);
    expect(
      gateEvents.filter((t) => !shown.has(t)),
      'gate events the timeline silently drops',
    ).toEqual([]);
  });

  it('returns every graph_event value the taxonomy declares', async () => {
    const graphEvents = loadTaxonomy().dimensions.graph_event as string[];
    expect(graphEvents.length).toBeGreaterThan(0);

    const shown = await projectWithOneEventPerType(graphEvents);
    expect(
      graphEvents.filter((t) => !shown.has(t)),
      'graph events the timeline silently drops',
    ).toEqual([]);
  });
});

/**
 * Operator directive (dogfood round 2): "Không thấy overview update, và nên
 * thay thông tin trong block now running bằng các session đang chạy hiện tại,
 * có animation indicator."
 *
 * The Overview's "Now running" card was fed by `liveAgentEntries` sorted
 * longest-running-first, and the `agents` table keeps a row `live` until a
 * terminal event closes it out. In the real state/smith.db the twelve oldest
 * `live` rows are all from a session whose last event was five days ago, so
 * the card was permanently occupied by ghosts and never changed — exactly the
 * "không thấy update" the operator reported. `runningSessions` answers the
 * question the card should have been answering: which SESSIONS have appended
 * anything lately.
 */
describe('overview() — running sessions (dogfood round 2)', () => {
  const OTHER = 'sess-later';
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-sessions-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-sessions-db-'));
    await buildFixture({ stateDir });
    // A second session, appended after the fixture's — so its `lastEventAt`
    // is genuinely later and the ordering assertion means something.
    // events.ts stamps `ts` with `new Date().toISOString()` and takes no
    // clock injection, so without this pause the fixture's last event and
    // this one land in the same millisecond often enough to make the
    // ordering assertion flaky (observed 1 in 3 runs).
    await new Promise((resolve) => setTimeout(resolve, 5));
    await appendEvent(
      {
        session_id: OTHER,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  async function project(): Promise<DbHandle> {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    return openDb(dbPath);
  }

  it('reports every projected session, most recently active first', async () => {
    handle = await project();
    const result = overview(handle.db);

    expect(result.runningSessions.map((s) => s.sessionId)).toEqual([OTHER, SESSION_ID]);
    const fixture = result.runningSessions.find((s) => s.sessionId === SESSION_ID);
    expect(fixture).toMatchObject({
      liveAgentCount: 2, // same two agents overview() already counts
      projects: ['black-smith'],
      lastEventType: 'finding-transitioned',
    });
    expect(fixture?.eventCount).toBeGreaterThan(0);
    expect(fixture && fixture.lastEventAt >= fixture.startedAt).toBe(true);
  });

  it('carries what the session just did, so a row can say more than "still there"', async () => {
    handle = await project();
    const other = overview(handle.db).runningSessions.find((s) => s.sessionId === OTHER);
    expect(other).toMatchObject({
      lastEventType: 'session-start',
      eventCount: 1,
      liveAgentCount: 0,
      projects: [], // no tasks yet — a session carries no project column of its own
    });
  });

  it('scopes to one session when a sessionId is given', async () => {
    handle = await project();
    expect(
      overview(handle.db, { sessionId: OTHER }).runningSessions.map((s) => s.sessionId),
    ).toEqual([OTHER]);
    expect(overview(handle.db, { sessionId: 'no-such-session' }).runningSessions).toEqual([]);
  });

  it('under a project scope, keeps only sessions that touched that project', async () => {
    handle = await project();
    // The sessions table has no project column, so a session belongs to the
    // projects of its tasks. OTHER has none yet, so it is not this project's.
    expect(
      overview(handle.db, { project: 'black-smith' }).runningSessions.map((s) => s.sessionId),
    ).toEqual([SESSION_ID]);
    expect(overview(handle.db, { project: 'other-project' }).runningSessions).toEqual([]);
  });

  it('tags every live agent entry with the session that dispatched it', async () => {
    handle = await project();
    const entries = overview(handle.db).liveAgentEntries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((a) => a.sessionId === SESSION_ID)).toBe(true);
  });
});
