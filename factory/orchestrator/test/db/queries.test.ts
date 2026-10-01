import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import {
  analytics,
  artifactById,
  DEFAULT_PROJECT,
  errorsPage,
  flowGraph,
  inboxRows,
  kanban,
  LESSON_BUCKET_FOR_STATUS,
  lessonOwnerSession,
  lessonsPage,
  overview,
  pulse,
  requestQuoteForTask,
  taskDetail,
  taskRuns,
  timeline,
} from '../../src/db/queries.js';
import { eventsRaw, findings, tasks } from '../../src/db/schema.js';
import { appendEvent, type EventOpts, readEvents } from '../../src/events.js';
import type { EventContext } from '../../src/findings.js';
import { LEGAL_TRANSITIONS, raiseFinding, transition } from '../../src/findings.js';
import { loadTaxonomy } from '../../src/taxonomy.js';
import { WAIVABLE_SEVERITIES } from '../../src/waivers.js';
import { buildFixture, EPIC_ID, SESSION_ID, TASK_1, TASK_2, TASK_3, TASK_4 } from './fixtures.js';

/** raiseFinding()/transition() return the Finding, not the event id — read the
 * log back so the next event's causal_parent stays accurate (as fixtures.ts does). */
async function lastEventId(opts: EventOpts): Promise<string> {
  const events = await readEvents(SESSION_ID, opts);
  const last = events[events.length - 1];
  if (!last) throw new Error('expected at least one event in the log');
  return last.event_id;
}

/** A raw log line with the ts spelled out, so a tie is the test's and not the
 * clock's — appendEvent() stamps the moment it is called. */
function tiedLine(
  eventType: string,
  ts: string,
  payload: Record<string, unknown>,
  session: string = SESSION_ID,
): string {
  return `${JSON.stringify({
    session_id: session,
    actor: 'user',
    event_type: eventType,
    plan_version: 1,
    causal_parent: eventType === 'session-start' ? null : `${session}#0`,
    payload,
    ts,
  })}\n`;
}

/**
 * A session whose whole log is one burst: `count` operator-notes that all
 * share a ts, so nothing but the log index separates them. The notes take
 * indices 1..count (session-start takes #0), which is why the rows below ask
 * for twelve — a burst that stops at nine cannot tell a tiebreak on the index
 * as a number from a tiebreak on it as text.
 */
async function burstLog(dir: string, session: string, ts: string, count: number): Promise<void> {
  let body = tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session);
  for (let i = 1; i <= count; i += 1) {
    body += tiedLine('operator-note', ts, { note_kind: 'scope-check', note: `note ${i}` }, session);
  }
  await appendFile(path.join(dir, `${session}.jsonl`), body, 'utf8');
}

/** The same burst, in task-added — the shape a re-plan writes, one budget per row. */
async function budgetBurst(
  dir: string,
  session: string,
  ts: string,
  task: string,
  budgets: readonly number[],
): Promise<void> {
  let body = tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session);
  for (const budget of budgets) {
    body += tiedLine('task-added', ts, { task_id: task, budget_tokens: budget }, session);
  }
  await appendFile(path.join(dir, `${session}.jsonl`), body, 'utf8');
}

/**
 * The same burst, in dispatch_decision — the shape a wave admission writes.
 * Each task is declared once first: a dispatch moves a task, it never mints
 * one, so a burst at an undeclared id would fold to no row at all.
 */
async function dispatchBurst(
  dir: string,
  session: string,
  ts: string,
  rows: readonly { task: string; role: string; tier: string }[],
): Promise<void> {
  let body = tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session);
  for (const task of new Set(rows.map((r) => r.task))) {
    body += tiedLine('task-added', ts, { task_id: task }, session);
  }
  for (const r of rows) {
    body += tiedLine(
      'dispatch_decision',
      ts,
      { task_id: r.task, agent_role: r.role, provider: 'claude', model_tier: r.tier },
      session,
    );
  }
  await appendFile(path.join(dir, `${session}.jsonl`), body, 'utf8');
}

/**
 * Move one row to the end of its table's physical order by deleting it and
 * writing it back unchanged. Nothing about the row changes; the only thing
 * that does is the order a scan reaches it in, which is the whole of what
 * these rows are about.
 */
function rewriteLast(h: DbHandle, table: string, eventId: string): void {
  const row = h.sqlite.prepare(`select * from ${table} where event_id = ?`).get(eventId) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) throw new Error(`rewriteLast: no ${table} row for ${eventId}`);
  const cols = Object.keys(row);
  h.sqlite.prepare(`delete from ${table} where event_id = ?`).run(eventId);
  h.sqlite
    .prepare(`insert into ${table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]));
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
        { epicId: EPIC_ID, tokensSpent: 2000, tokensBudget: 4300, unmeasured: 0 },
      ]);
      expect(result.alerts).toEqual({ escalations: 1, pendingWaivers: 0 });
    });

    it('sums a measured result exactly and counts an unmeasured one instead of folding it in as zero spend (issue #220)', async () => {
      // A Result the orchestrator could not measure arrives as
      // `token_usage: { measured: false }` (result.schema.json since #220),
      // not as an absent field. epicTokenMaps() must add that Result to
      // `unmeasuredByEpic` rather than `?? 0`-ing it into spentByEpic, or the
      // epic's total silently reads as a smaller, fabricated number instead of
      // an honest floor.
      const session = 'sess-unmeasured';
      const epicId = 'epic-unmeasured';
      const taskMeasured = `${epicId}/task-measured`;
      const taskUnmeasured = `${epicId}/task-unmeasured`;
      const ts = '2029-06-01T00:00:00.000Z';
      await appendFile(
        path.join(stateDir, `${session}.jsonl`),
        tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session) +
          tiedLine('task-added', ts, { task_id: taskMeasured, budget_tokens: 1000 }, session) +
          tiedLine('task-added', ts, { task_id: taskUnmeasured, budget_tokens: 500 }, session) +
          tiedLine(
            'task-result-recorded',
            ts,
            {
              task_id: taskMeasured,
              run_status: 'done',
              token_usage: { input_tokens: 700, output_tokens: 300, total_tokens: 1000 },
            },
            session,
          ) +
          tiedLine(
            'task-result-recorded',
            ts,
            { task_id: taskUnmeasured, run_status: 'done', token_usage: { measured: false } },
            session,
          ),
        'utf8',
      );

      const dbPath = path.join(dbDir, 'unmeasured.db');
      await rebuild(dbPath, 'all', { stateDir });
      const unmeasured = openDb(dbPath);
      try {
        const result = overview(unmeasured.db);
        expect(result.tokensByEpic).toContainEqual({
          epicId,
          tokensSpent: 1000,
          tokensBudget: 1500,
          unmeasured: 1,
        });
      } finally {
        unmeasured.sqlite.close();
      }
    });

    it('scopes to one session when a sessionId is given', () => {
      const result = overview(handle.db, { sessionId: SESSION_ID });
      expect(result.liveAgentCount).toBe(2);

      const empty = overview(handle.db, { sessionId: 'no-such-session' });
      expect(empty.liveAgentCount).toBe(0);
      expect(empty.epicsInFlight).toEqual([]);
    });

    it('counts an agent dispatched after an epic closed in the same ms as live', async () => {
      // The live-agent delta re-runs agents-registry.ts's fold over a slice of
      // events_raw, and that fold is a state machine: `epic-closed` abandons
      // whatever is open when it arrives, so when it arrives decides the
      // answer. Ordered on `ts` alone the two tied rows arrive in whatever
      // order the scan reaches them -- today that is grouped by event type,
      // which puts every dispatch ahead of every terminal whatever the log
      // says -- and the dispatch that in fact came *after* the verdict was
      // swept closed by it. The historical half of the subtraction then
      // disagreed with the agents table the projector folded from the same
      // log, and the card announced an arrival that never happened.
      const session = 'sess-live';
      const tied = '2030-01-01T00:00:00.000Z';
      await appendFile(
        path.join(stateDir, `${session}.jsonl`),
        tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session) +
          tiedLine('epic-closed', tied, { epic_id: 'epic-9' }, session) +
          tiedLine(
            'dispatch_decision',
            tied,
            {
              task_id: 'epic-9/task-late',
              agent_role: 'coder',
              provider: 'claude',
              model_tier: 'small',
            },
            session,
          ),
        'utf8',
      );

      const dbPath = path.join(dbDir, 'live.db');
      await rebuild(dbPath, 'all', { stateDir });
      const live = openDb(dbPath);
      try {
        // The cutoff is past every event in the log, so the snapshot is the
        // present: the two halves of the subtraction have to agree.
        expect(
          overview(live.db, {}, { nowIso: '2031-01-01T00:00:00.000Z' }).liveAgentCountDelta5m,
        ).toBe(0);
      } finally {
        live.sqlite.close();
      }
    });

    it('reads the budget an hour ago from the log, not from the event id as text', async () => {
      // The historical denominator behind the budget card's 1h delta folds
      // `task-added` up to the cutoff, last write per task wins -- the fold the
      // projector already did to fill `tasks.budget_tokens`. The tie between a
      // re-plan's rows was broken on the event id as *text*, so `#9` came after
      // `#12` and the two folds ended on different budgets. With the cutoff
      // past every event in the log, nothing has happened in the last hour and
      // the only honest reading is no change at all.
      const session = 'sess-budget';
      const tied = '2030-01-01T00:00:00.000Z';
      await budgetBurst(
        stateDir,
        session,
        tied,
        `${EPIC_ID}/task-budget`,
        Array.from({ length: 12 }, (_, i) => (i + 1) * 1000),
      );

      const dbPath = path.join(dbDir, 'budget.db');
      await rebuild(dbPath, 'all', { stateDir });
      const budget = openDb(dbPath);
      try {
        expect(
          overview(budget.db, {}, { nowIso: '2031-01-01T00:00:00.000Z' }).budgetUsedPctPointDelta1h,
        ).toBe(0);
      } finally {
        budget.sqlite.close();
      }
    });

    it('reports the newest of a tied burst as recent, not the first ten of it', async () => {
      // recentDispatches sorts newest-first and keeps ten. Array.prototype.sort
      // is stable, so when a wave writes twelve dispatch_decisions inside one
      // millisecond every comparison returns 0 and the list keeps the order the
      // rows came back in -- ascending -- and the ten it then slices off the
      // front are the *oldest* ten of the burst, under a heading that says
      // recent. The two newest dispatches in the factory are the two the
      // operator cannot see.
      const session = 'sess-wave';
      const tied = '2030-01-01T00:00:00.000Z';
      await dispatchBurst(
        stateDir,
        session,
        tied,
        Array.from({ length: 12 }, (_, i) => ({
          task: `epic-9/task-${i + 1}`,
          role: 'coder',
          tier: 'small',
        })),
      );

      const dbPath = path.join(dbDir, 'wave.db');
      await rebuild(dbPath, 'all', { stateDir });
      const wave = openDb(dbPath);
      try {
        // The fixture's own dispatches are older than 2030, so the whole slice
        // comes from the burst, newest first. The burst declares its twelve
        // tasks (#1-#12) before it dispatches at them (#13-#24).
        const last = 24;
        expect(overview(wave.db).recentDispatches.map((d) => d.eventId)).toEqual(
          Array.from({ length: 10 }, (_, i) => `${session}#${last - i}`),
        );
      } finally {
        wave.sqlite.close();
      }
    });

    // Task 3 (dispatch reason fallback): the Overview card's fallback line
    // ("<role> on <task> · round N") needs the round a redispatch is on —
    // agents.round, joined in by dispatch event id (agents.id IS the dispatch
    // event id, agents-registry.ts's foldAgents()).
    it('carries the dispatch round for the UI’s no-reason fallback line', async () => {
      const session = 'sess-round';
      const ts = '2030-02-01T00:00:00.000Z';
      const taskId = 'epic-9/task-round';
      await appendFile(
        path.join(stateDir, `${session}.jsonl`),
        tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session) +
          tiedLine('task-added', ts, { task_id: taskId }, session) +
          tiedLine(
            'dispatch_decision',
            ts,
            {
              task_id: taskId,
              agent_role: 'coder',
              provider: 'claude',
              model_tier: 'mid',
              round: 2,
            },
            session,
          ),
        'utf8',
      );

      const dbPath = path.join(dbDir, 'round.db');
      await rebuild(dbPath, 'all', { stateDir });
      const built = openDb(dbPath);
      try {
        const dispatch = overview(built.db).recentDispatches.find((d) => d.taskId === taskId);
        expect(dispatch?.round).toBe(2);
      } finally {
        built.sqlite.close();
      }
    });
  });

  describe('the pending-waiver count and the roster it is about', () => {
    /**
     * The statuses LEGAL_TRANSITIONS lets a waiver be granted from, read off
     * the table here rather than imported from findings.ts's derivation of
     * it. That makes this test a second *reader* of the table instead of a
     * second copy of its answer: the count under test has to move when the
     * table moves, and the moment that count is spelled out beside the table
     * rather than read from it, these two stop agreeing.
     */
    const waivableByTable = Object.entries(LEGAL_TRANSITIONS)
      .filter(([, next]) => next.includes('waived'))
      .map(([status]) => status);

    /** Raise one finding into the fixture's own log and walk it along `steps`. */
    async function raiseInto(
      findingId: string,
      severity: string,
      summary: string,
      steps: readonly string[],
      scope?: 'spec',
    ): Promise<void> {
      const ctx: EventContext = {
        sessionId: SESSION_ID,
        planVersion: 1,
        causalParent: await lastEventId({ stateDir }),
      };
      const raised = await raiseFinding(
        {
          finding: {
            finding_id: findingId,
            task_id: TASK_1,
            finding_category: 'correctness',
            severity,
            finding_status: 'raised',
            summary,
            failure_scenario: { inputs: 'n=5', expected: '5 items', actual: '4 items' },
            found_by: 'reviewer',
            ...(scope === 'spec'
              ? { finding_scope: 'spec', spec_ref: { plan_version: 1, criterion_ref: summary } }
              : {}),
          },
          filePath: `src/${findingId}.ts`,
        },
        ctx,
        { stateDir },
      );
      if (raised.suppressed) throw new Error(`${findingId} unexpectedly suppressed`);
      for (const step of steps) {
        await transition(
          findingId,
          step,
          { ...ctx, causalParent: await lastEventId({ stateDir }) },
          { stateDir },
          step === 'amend-pending' ? { amendsTaskIds: [TASK_3], amendsPlanVersion: 2 } : {},
        );
      }
    }

    it('counts exactly the findings the waiver machinery would act on', async () => {
      // Two the count is about, and three it must leave out: one held out by
      // its status, one by its severity, and one -- the spec finding parked at
      // `amend-pending` -- that is held out today and would be counted the
      // moment LEGAL_TRANSITIONS grew that status a `waived` edge. That last
      // one is what this test is for. A roster restated beside the table
      // instead of read from it would not move with the table, and the
      // disagreement is silent: the operator's card says one number and the
      // batch `/bs waivers` offers holds another.
      await raiseInto('pw-raised', 'S3-minor', 'a stray console.log in the loader', []);
      await raiseInto('pw-confirmed', 'S3-minor', 'the retry count is off by one', ['confirmed']);
      await raiseInto(
        'pw-amend',
        'S3-minor',
        'the spec never says which of two tied claims wins',
        ['amend-pending'],
        'spec',
      );
      await raiseInto('pw-fixing', 'S3-minor', 'the error message names the wrong file', [
        'confirmed',
        'fix-pending',
      ]);
      await raiseInto('pw-major', 'S1-stop-the-line', 'the claim lock is never released', []);

      const dbPath = path.join(dbDir, 'pending-waivers.db');
      await rebuild(dbPath, 'all', { stateDir });
      const pw = openDb(dbPath);
      try {
        const rows = pw.db.select().from(findings).all();
        const expected = rows.filter(
          (f) =>
            WAIVABLE_SEVERITIES.includes(f.severity) &&
            waivableByTable.includes(f.findingStatus) &&
            f.waiverId === null,
        ).length;

        // Anti-vacuity, three ways: the filter has something to count, and
        // something of each kind to leave out. Without these a roster that
        // matched nothing at all would read here as agreement.
        expect(expected).toBeGreaterThan(0);
        expect(
          rows.filter(
            (f) =>
              WAIVABLE_SEVERITIES.includes(f.severity) &&
              !waivableByTable.includes(f.findingStatus),
          ).length,
        ).toBeGreaterThan(0);
        expect(
          rows.filter(
            (f) =>
              !WAIVABLE_SEVERITIES.includes(f.severity) &&
              waivableByTable.includes(f.findingStatus),
          ).length,
        ).toBeGreaterThan(0);

        const result = overview(pw.db);
        expect(result.alerts.pendingWaivers).toBe(expected);
        // The per-project rows are a second counter over the same findings,
        // and the operator sees both -- the project card's number and the
        // global one. Summed rather than indexed, so this does not also
        // assert how many projects the fixture happens to declare.
        const perProject = (result.projects ?? []).reduce(
          (sum, p) => sum + p.alerts.pendingWaivers,
          0,
        );
        expect(perProject).toBe(expected);
      } finally {
        pw.sqlite.close();
      }
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
        // The fixture's operator-feedback pair on task-1 (recorded, then
        // resolved as a follow-up) -- both free-listed onto the timeline.
        'operator-feedback-recorded',
        'operator-feedback-resolved',
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

    it('shows the integration PR the epic opened (run.md step 17)', async () => {
      // The PR is the epic's terminal deliverable — the one thing the operator
      // is asked to merge — and run.md step 17 records it with `smith event
      // append` as `integration-pr-opened`. A timeline whose free list does not
      // name that type ends at `epic-closed` and never shows the PR at all.
      await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'operator',
          event_type: 'integration-pr-opened',
          task_id: `${EPIC_ID}/integration`,
          plan_version: 1,
          causal_parent: await lastEventId({ stateDir }),
          payload: {
            step: 17,
            pr_url: 'https://github.com/juzser/example/pull/54',
            pr_number: 54,
            repo: 'juzser/example',
            base_ref: 'main',
            head_ref: `smith/${EPIC_ID}/integration`,
            head_sha: '0123456',
          },
        },
        { stateDir },
      );
      const dbPath = path.join(dbDir, 'integration-pr.db');
      await rebuild(dbPath, 'all', { stateDir });
      const prHandle = openDb(dbPath);
      try {
        const all = timeline(prHandle.db, { sessionId: SESSION_ID });
        const row = all.find((e) => e.eventType === 'integration-pr-opened');
        expect(row?.taskId).toBe(`${EPIC_ID}/integration`);
        expect((row?.payload as Record<string, unknown> | undefined)?.pr_number).toBe(54);
        // And it is the epic's row, not an orphan: filtering by epic keeps it.
        expect(
          timeline(prHandle.db, { sessionId: SESSION_ID, epicId: EPIC_ID }).map((e) => e.eventType),
        ).toContain('integration-pr-opened');
      } finally {
        prHandle.sqlite.close();
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

    it('orders a burst the way the log wrote it, not the way the rows come back', async () => {
      // `ts` is stamped at millisecond resolution, so a burst of appends shares
      // one and `ORDER BY ts` alone has nothing left to say about the rest.
      // SQLite's sort is not stable and makes no promise here: the tied rows
      // come back in whatever order the scan reached them, which is not a
      // decision anything made and stops matching the log the moment a row is
      // rewritten. Twelve notes rather than a handful, because the tiebreak has
      // to read the log index as a number -- as text, `#9` sorts after `#10`.
      const session = 'sess-burst';
      const tied = '2030-01-01T00:00:00.000Z';
      await burstLog(stateDir, session, tied, 12);

      const dbPath = path.join(dbDir, 'burst.db');
      await rebuild(dbPath, 'all', { stateDir });
      const burst = openDb(dbPath);
      try {
        rewriteLast(burst, 'events_raw', `${session}#1`);
        const notes = timeline(burst.db, { sessionId: session }).filter(
          (e) => e.eventType === 'operator-note',
        );
        expect(notes.map((e) => e.eventId)).toEqual(
          Array.from({ length: 12 }, (_, i) => `${session}#${i + 1}`),
        );
      } finally {
        burst.sqlite.close();
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
          agentActivity: null,
          milestoneId: null,
          tags: { case: 'feature', origin: 'user', severity: null },
          updatedAt: expect.any(String),
          project: null,
          attemptCount: 1,
          judgeRound: null,
          commentCount: 1,
          prUrl: null,
          dependencies: [],
          epicLabel: 'black-smith: Epic 1',
          hasRequest: true,
          requestFirstLine: 'Build the widget and fix the flaky import.',
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
          agentActivity: 'working',
          milestoneId: null,
          tags: { case: 'refactor', origin: 'user', severity: null },
          updatedAt: expect.any(String),
          project: null,
          attemptCount: 1,
          judgeRound: null,
          commentCount: 0,
          prUrl: null,
          dependencies: [
            {
              taskId: TASK_1,
              title: 'Add the widget renderer.',
              status: 'completed',
              edgeType: 'artifact',
            },
          ],
          epicLabel: 'black-smith: Epic 1',
          hasRequest: true,
          requestFirstLine: 'Build the widget and fix the flaky import.',
        },
      ]);
      expect(byStatus.escalated).toEqual([
        {
          taskId: TASK_3,
          taskStatus: 'escalated',
          title: 'Fix the flaky import resolution.',
          agentRole: 'coder',
          agentModelTier: 'small',
          agentActivity: null,
          milestoneId: null,
          tags: { case: 'bugfix', origin: 'user', severity: null },
          updatedAt: expect.any(String),
          project: null,
          attemptCount: 1,
          judgeRound: null,
          commentCount: 0,
          prUrl: null,
          dependencies: [],
          epicLabel: 'black-smith: Epic 1',
          hasRequest: true,
          requestFirstLine: 'Build the widget and fix the flaky import.',
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
          agentActivity: 'working',
          milestoneId: null,
          tags: { case: 'feature', origin: 'user', severity: 'S2-major' },
          updatedAt: expect.any(String),
          project: null,
          attemptCount: 1,
          judgeRound: null,
          commentCount: 1,
          prUrl: null,
          dependencies: [],
          epicLabel: 'black-smith: Epic 1',
          hasRequest: true,
          requestFirstLine: 'Build the widget and fix the flaky import.',
        },
      ]);
    });

    // epicLabelFor must read a tagged project through projectOf() (DEFAULT_PROJECT),
    // not re-hardcode 'black-smith' as its own fallback literal.
    it('labels a tagged task with its own project, not the hard-coded default', () => {
      handle.db.update(tasks).set({ project: 'other-project' }).where(eq(tasks.taskId, TASK_1)).run();
      const columns = kanban(handle.db, EPIC_ID);
      const byStatus = Object.fromEntries(columns.map((c) => [c.taskStatus, c.tasks]));
      expect(byStatus.completed?.[0]?.epicLabel).toBe('other-project: Epic 1');
    });

    // Cross-provider UI check of 2026-09-14, fix (n): the card's chip read
    // "coder · mid" on a completed task as though someone were still on it.
    // The dispatch row says who was last sent; only the agents row says who
    // is still there, and the card needs the second answer next to the first.
    it('says whether an agent is still on the task, not only who was last sent', () => {
      const byId = (columns: ReturnType<typeof kanban>) =>
        new Map(columns.flatMap((c) => c.tasks).map((t) => [t.taskId, t]));

      const now = byId(kanban(handle.db, EPIC_ID));
      // task-1's coder returned a result and task-3's logged an error: both
      // dispatches are the latest for their task, and nobody is on either.
      expect(now.get(TASK_1)?.agentActivity).toBeNull();
      expect(now.get(TASK_3)?.agentActivity).toBeNull();
      // task-2 and task-4 have no terminal event, so their coders are working.
      expect(now.get(TASK_2)?.agentActivity).toBe('working');
      expect(now.get(TASK_4)?.agentActivity).toBe('working');

      // The same live rows seen from a clock years on are stalled, not gone:
      // the registry still says live, the stale window says nothing recent.
      const later = byId(kanban(handle.db, EPIC_ID, {}, { nowIso: '2031-01-01T00:00:00.000Z' }));
      expect(later.get(TASK_4)?.agentActivity).toBe('stalled');
      expect(later.get(TASK_2)?.agentActivity).toBe('stalled');
      expect(later.get(TASK_1)?.agentActivity).toBeNull();
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

    it('chips the later of two dispatches that share a ts', async () => {
      // The chip names "the most recent dispatch_decision for this task". The
      // fold walked the rows keeping a strict `>`, which on a tie keeps the
      // first row the scan reached -- so the chip reported whichever of the two
      // the store happened to hand over first, and the operator read a role the
      // task had already left.
      const session = 'sess-chip';
      const tied = '2030-01-01T00:00:00.000Z';
      // A task of its own: the fixture's tasks are written by another session,
      // and the projector inserts a task row per session.
      const task = `${EPIC_ID}/task-chip`;
      await dispatchBurst(stateDir, session, tied, [
        { task, role: 'coder', tier: 'small' },
        { task, role: 'reviewer', tier: 'mid' },
      ]);

      const dbPath = path.join(dbDir, 'chip.db');
      await rebuild(dbPath, 'all', { stateDir });
      const chip = openDb(dbPath);
      try {
        const row = kanban(chip.db, EPIC_ID)
          .flatMap((c) => c.tasks)
          .find((t) => t.taskId === task);
        expect(row?.agentRole).toBe('reviewer');
        expect(row?.agentModelTier).toBe('mid');
      } finally {
        chip.sqlite.close();
      }
    });

    // DS3 Slice A item 3 — deterministic ordering: newest updatedAt first,
    // task id as the tiebreak when two rows share a ts exactly.
    it('orders a column by updatedAt desc, then taskId asc on a tie', async () => {
      const session = 'sess-order';
      const taskA = `${EPIC_ID}/task-order-a`;
      const taskB = `${EPIC_ID}/task-order-b`;
      const taskC = `${EPIC_ID}/task-order-c`;
      let body = tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session);
      body += tiedLine(
        'task-added',
        '2030-01-01T00:00:00.000Z',
        { task_id: taskA, task_status: 'in-progress' },
        session,
      );
      body += tiedLine(
        'task-added',
        '2030-01-02T00:00:00.000Z',
        { task_id: taskB, task_status: 'in-progress' },
        session,
      );
      // taskC shares taskB's exact ts: the tiebreak alone must separate them.
      body += tiedLine(
        'task-added',
        '2030-01-02T00:00:00.000Z',
        { task_id: taskC, task_status: 'in-progress' },
        session,
      );
      await appendFile(path.join(stateDir, `${session}.jsonl`), body, 'utf8');

      const dbPath = path.join(dbDir, 'order.db');
      await rebuild(dbPath, 'all', { stateDir });
      const ordered = openDb(dbPath);
      try {
        const column = kanban(ordered.db, EPIC_ID)
          .find((c) => c.taskStatus === 'in-progress')
          ?.tasks.filter((t) => [taskA, taskB, taskC].includes(t.taskId));
        expect(column?.map((t) => t.taskId)).toEqual([taskB, taskC, taskA]);
      } finally {
        ordered.sqlite.close();
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
        // What TaskDetailPage reads to label a spec finding — a diff finding
        // carries the scope and no criterion.
        findingScope: 'diff',
        specPlanVersion: null,
        criterionRef: null,
      });
      expect(detail?.artifacts).toHaveLength(1);
      expect(detail?.feedback).toHaveLength(1);
      expect(detail?.feedback[0]).toMatchObject({
        taskId: TASK_1,
        kind: 'nice-to-have',
        source: 'github',
        externalId: 'gh-comment:42',
        author: 'sonnh',
        resolution: 'follow-up',
        followUpTaskId: 'epic-1/task-5',
      });
      // Fixture task-added payload carries no `branch` field: legacy
      // fallback, not the current `bs` default (bs-rename part 1).
      expect(detail?.branch).toBe(`smith/${EPIC_ID}/task-1`);
      // DS3 §4.7 — the operator prompt that led to this task.
      expect(detail?.requestQuote).toMatchObject({
        prompt: 'Build the widget and fix the flaky import.',
        source: 'task',
      });
    });

    it('returns null for an unknown task', () => {
      expect(taskDetail(handle.db, 'epic-1/does-not-exist')).toBeNull();
    });

    it('artifactById looks up one projected artifact row by its id', () => {
      const detail = taskDetail(handle.db, TASK_1);
      const artifactId = detail?.artifacts[0]?.id;
      expect(artifactId).toBeDefined();
      expect(artifactById(handle.db, artifactId as string)).toMatchObject({
        taskId: TASK_1,
        path: 'artifacts/task-1.diff',
      });
      expect(artifactById(handle.db, 'no-such-id')).toBeNull();
    });

    it('lists tied attempts in log order, not in the order the rows come back', async () => {
      // A task's attempt list is a history, so its order is the whole of what
      // it says. Ordered on `ts` alone, a re-dispatch inside the same
      // millisecond as the one it replaces lands wherever the scan puts it.
      const session = 'sess-attempts';
      const tied = '2030-01-01T00:00:00.000Z';
      const task = `${EPIC_ID}/task-attempts`;
      await dispatchBurst(
        stateDir,
        session,
        tied,
        Array.from({ length: 12 }, () => ({ task, role: 'coder', tier: 'small' })),
      );

      const dbPath = path.join(dbDir, 'attempts.db');
      await rebuild(dbPath, 'all', { stateDir });
      const attemptsHandle = openDb(dbPath);
      try {
        // #0 is the session-start, #1 the task-added the burst declares.
        const first = 2;
        rewriteLast(attemptsHandle, 'dispatches', `${session}#${first}`);
        const tiedAttempts = taskDetail(attemptsHandle.db, task)?.attempts ?? [];
        expect(tiedAttempts.map((a) => a.eventId)).toEqual(
          Array.from({ length: 12 }, (_, i) => `${session}#${first + i}`),
        );
      } finally {
        attemptsHandle.sqlite.close();
      }
    });
  });

  describe('requestQuoteForTask() (DS3 §4.7)', () => {
    it('terminates on a causal_parent cycle instead of looping forever, and finds no quote', async () => {
      // Two events that point at each other: the task-added row at #2 names
      // #1 as its parent, and #1 names #2 right back. Neither is a
      // user_prompt and there is none anywhere else in the session, so the
      // honest answer is null -- the test passing at all is the proof the
      // `seen` guard stopped the walk rather than spinning.
      const session = 'sess-cycle';
      const task = 'epic-cycle/task-1';
      await appendFile(
        path.join(stateDir, `${session}.jsonl`),
        tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session) +
          `${JSON.stringify({
            session_id: session,
            actor: 'user',
            event_type: 'operator-note',
            plan_version: 1,
            causal_parent: `${session}#2`,
            payload: { note_kind: 'scope-check', note: 'cycle half A' },
            ts: '2029-06-01T00:00:00.000Z',
          })}\n` +
          `${JSON.stringify({
            session_id: session,
            actor: 'user',
            event_type: 'task-added',
            plan_version: 1,
            causal_parent: `${session}#1`,
            payload: { task_id: task },
            ts: '2029-06-01T00:00:01.000Z',
          })}\n`,
        'utf8',
      );

      const dbPath = path.join(dbDir, 'cycle.db');
      await rebuild(dbPath, 'all', { stateDir });
      const cycleHandle = openDb(dbPath);
      try {
        expect(requestQuoteForTask(cycleHandle.db, task, session)).toBeNull();
      } finally {
        cycleHandle.sqlite.close();
      }
    });

    it('falls back to the epic source prompt when the task-added row names a missing parent', async () => {
      // #2's causal_parent names an event id that was never written. The walk
      // has to stop there without crashing, and `requestQuoteForTask` then
      // falls back to the session's own earliest user_prompt (#1) rather
      // than reporting no quote at all.
      const session = 'sess-missing-parent';
      const task = 'epic-missing/task-1';
      await appendFile(
        path.join(stateDir, `${session}.jsonl`),
        tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session) +
          tiedLine(
            'user_prompt',
            '2029-06-01T00:00:00.000Z',
            { prompt: 'Epic started from this prompt.' },
            session,
          ) +
          `${JSON.stringify({
            session_id: session,
            actor: 'user',
            event_type: 'task-added',
            plan_version: 1,
            causal_parent: `${session}#99`,
            payload: { task_id: task },
            ts: '2029-06-01T00:00:02.000Z',
          })}\n`,
        'utf8',
      );

      const dbPath = path.join(dbDir, 'missing-parent.db');
      await rebuild(dbPath, 'all', { stateDir });
      const missingHandle = openDb(dbPath);
      try {
        expect(requestQuoteForTask(missingHandle.db, task, session)).toMatchObject({
          prompt: 'Epic started from this prompt.',
          source: 'epic',
        });
      } finally {
        missingHandle.sqlite.close();
      }
    });
  });

  describe('taskRuns() (DS3 §4.7)', () => {
    it('scopes dispatch/judge-report/result/error rows to one task, in log order', async () => {
      const session = 'sess-runs';
      const task = 'epic-runs/task-1';
      const other = 'epic-runs/task-2';
      const ts = '2029-06-01T00:00:00.000Z';
      await appendFile(
        path.join(stateDir, `${session}.jsonl`),
        tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session) +
          tiedLine('task-added', ts, { task_id: task }, session) +
          tiedLine('task-added', ts, { task_id: other }, session) +
          tiedLine(
            'dispatch_decision',
            ts,
            { task_id: task, agent_role: 'coder', provider: 'claude', model_tier: 'mid' },
            session,
          ) +
          tiedLine(
            'judge-reported',
            ts,
            {
              task_id: task,
              agent_role: 'spec-reviewer',
              round: 1,
              finding_count: 2,
              artifact_path: 'state/artifacts/epic-runs/task-1/judge.json',
            },
            session,
          ) +
          tiedLine(
            'task-result-recorded',
            ts,
            { task_id: task, run_status: 'done', token_usage: { measured: false } },
            session,
          ) +
          tiedLine(
            'error-logged',
            ts,
            { task_id: other, error: 'execution.flaky-test', agent_role: 'coder' },
            session,
          ),
        'utf8',
      );

      const dbPath = path.join(dbDir, 'runs.db');
      await rebuild(dbPath, 'all', { stateDir });
      const runsHandle = openDb(dbPath);
      try {
        const runs = taskRuns(runsHandle.db, task);
        expect(runs.map((r) => r.kind)).toEqual(['dispatch', 'judge-report', 'result']);
        const judgeRun = runs.find((r) => r.kind === 'judge-report');
        expect(judgeRun).toMatchObject({
          agentRole: 'spec-reviewer',
          round: 1,
          outcome: '2-findings',
        });
      } finally {
        runsHandle.sqlite.close();
      }
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
      expect(result.lastEventType).toBe('operator-feedback-resolved');
      expect(result.lastEventAt).not.toBeNull();
      expect(result.counts.events).toBe(readEventCount(handle));
      expect(result.counts.errors).toBe(1); // the one error errorsPage() groups
      // lesson-1 is approved and lesson-2 invalidated — nothing is waiting.
      expect(result.lessonsPending).toBe(0);
    });

    it('breaks a tie on the log order, not on the order the rows come back', async () => {
      // `ts` is stamped at millisecond resolution (events.ts), so events
      // written in one burst routinely share one — the fixture's own last two
      // do it in roughly one build of three. A strict `>` keeps whichever of
      // the tied rows the scan reached first, which is not a decision anything
      // made. Written raw rather than through appendEvent because the point is
      // the tie, and appendEvent takes the clock rather than a stamp.
      const logFile = path.join(stateDir, `${SESSION_ID}.jsonl`);
      const tied = '2030-01-01T00:00:00.000Z';
      await appendFile(
        logFile,
        tiedLine('operator-note', tied, { note_kind: 'scope-check', note: 'written first' }),
        'utf8',
      );
      await appendFile(logFile, tiedLine('severity-decisions', tied, { decisions: [] }), 'utf8');

      const dbPath = path.join(dbDir, 'tied.db');
      await rebuild(dbPath, 'all', { stateDir });
      const tiedHandle = openDb(dbPath);
      try {
        const result = pulse(tiedHandle.db);
        expect(result.lastEventAt).toBe(tied);
        // The later append is the later event: an event id is
        // `<session>#<index>` and the index is its position in the log.
        expect(result.lastEventType).toBe('severity-decisions');
        // And both readings of "what just happened" name the same event, which
        // is what the first assertion in this block has been assuming.
        const row = overview(tiedHandle.db).runningSessions.find((s) => s.sessionId === SESSION_ID);
        expect(row?.lastEventType).toBe('severity-decisions');
      } finally {
        tiedHandle.sqlite.close();
      }
    });

    it('gives the same answer when the rows come back in another order', async () => {
      // The row above proves a tie needs an answer of its own; this one proves
      // where the answer comes from. `events_raw` has no sequence column and
      // neither reader sorts, so "the last row" is whichever the scan reaches
      // last — and SQLite is free to hand them back in any order it likes. So
      // the tied pair is deliberately stored backwards here, and the log still
      // decides.
      const logFile = path.join(stateDir, `${SESSION_ID}.jsonl`);
      const tied = '2030-01-01T00:00:00.000Z';
      await appendFile(
        logFile,
        tiedLine('operator-note', tied, { note_kind: 'scope-check', note: 'written first' }),
        'utf8',
      );
      await appendFile(logFile, tiedLine('severity-decisions', tied, { decisions: [] }), 'utf8');

      const dbPath = path.join(dbDir, 'reordered.db');
      await rebuild(dbPath, 'all', { stateDir });
      const reordered = openDb(dbPath);
      try {
        // Rewriting the earlier row moves it to the end of the table. Every
        // column is carried across by name so this keeps working when the
        // table grows one.
        const row = reordered.sqlite
          .prepare(`select * from events_raw where ts = ? and event_type = 'operator-note'`)
          .get(tied) as Record<string, unknown>;
        const cols = Object.keys(row);
        reordered.sqlite.prepare('delete from events_raw where event_id = ?').run(row.event_id);
        reordered.sqlite
          .prepare(
            `insert into events_raw (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`,
          )
          .run(...cols.map((c) => row[c]));

        // Guard the guard: without this the row could go on passing for the
        // wrong reason the day the rewrite stops reordering anything.
        const scanned = reordered.sqlite
          .prepare('select event_type from events_raw where ts = ?')
          .all(tied)
          .map((r) => (r as { event_type: string }).event_type);
        expect(scanned).toEqual(['severity-decisions', 'operator-note']);

        expect(pulse(reordered.db).lastEventType).toBe('severity-decisions');
        const session = overview(reordered.db).runningSessions.find(
          (s) => s.sessionId === SESSION_ID,
        );
        expect(session?.lastEventType).toBe('severity-decisions');
      } finally {
        reordered.sqlite.close();
      }
    });

    it('breaks a tie across two logs the same way on every call', async () => {
      // In global scope — the normal one, per this module's header — a tie can
      // straddle two sessions, and there the index means nothing: the logs are
      // separate files and nothing interleaves them. The session id is what
      // makes the answer the same on every call instead of a re-roll of
      // whatever order the rows arrived in. The session with the *shorter* log
      // wins here, so index order and session order disagree and only one of
      // them can be what decided it.
      const tied = '2030-01-01T00:00:00.000Z';
      await appendFile(
        path.join(stateDir, `${SESSION_ID}.jsonl`),
        tiedLine('severity-decisions', tied, { decisions: [] }),
        'utf8',
      );
      const other = 'sess-zzz'; // sorts after SESSION_ID, on two lines to its forty
      await appendFile(
        path.join(stateDir, `${other}.jsonl`),
        tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, other) +
          tiedLine('operator-note', tied, { note_kind: 'scope-check', note: 'later' }, other),
        'utf8',
      );

      const dbPath = path.join(dbDir, 'two-sessions.db');
      await rebuild(dbPath, 'all', { stateDir });
      const both = openDb(dbPath);
      try {
        const result = pulse(both.db);
        expect(result.lastEventAt).toBe(tied);
        expect(result.lastEventType).toBe('operator-note');
      } finally {
        both.sqlite.close();
      }
    });

    it('sorts an unreadable event id low rather than throwing on it', async () => {
      // `/api/pulse` is the app shell's poll, on every page, every 5s. An
      // event id it cannot read is a corrupt row, and a corrupt row should
      // cost the operator a wrong tie-break at worst — never the shell. The id
      // here is a session id with its `#index` missing, which is the shape
      // that makes the point: it parses far enough to tie on session and then
      // has nothing left to say about order, so it loses to a row that does.
      const logFile = path.join(stateDir, `${SESSION_ID}.jsonl`);
      const tied = '2030-01-01T00:00:00.000Z';
      await appendFile(
        logFile,
        tiedLine('operator-note', tied, { note_kind: 'scope-check', note: 'readable' }),
        'utf8',
      );
      await appendFile(logFile, tiedLine('severity-decisions', tied, { decisions: [] }), 'utf8');

      const dbPath = path.join(dbDir, 'corrupt-id.db');
      await rebuild(dbPath, 'all', { stateDir });
      const corrupt = openDb(dbPath);
      try {
        // Row 1 established that this is the event that wins the tie. Take its
        // place in the log away and it should stop winning, not start.
        corrupt.sqlite
          .prepare(`update events_raw set event_id = ? where ts = ? and event_type = ?`)
          .run(SESSION_ID, tied, 'severity-decisions');

        expect(() => pulse(corrupt.db)).not.toThrow();
        expect(pulse(corrupt.db).lastEventType).toBe('operator-note');
      } finally {
        corrupt.sqlite.close();
      }
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
          unmeasuredTaskCount: 0,
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

    it('excludes an unmeasured result from avgTokensPerTask instead of diluting it toward zero (issue #220)', async () => {
      // Same bug, analytics()'s own bucket: a Result with
      // `token_usage: { measured: false }` must grow taskCount and
      // unmeasuredTaskCount without a `?? 0` folding it into totalTokens, and
      // avgTokensPerTask must divide by the measured tasks only.
      const session = 'sess-cost-unmeasured';
      const ts = '2029-06-01T00:00:00.000Z';
      await appendFile(
        path.join(stateDir, `${session}.jsonl`),
        tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session) +
          tiedLine(
            'task-result-recorded',
            ts,
            {
              task_id: 'cost-epic/task-measured',
              run_status: 'done',
              provider: 'claude',
              model_tier: 'small',
              token_usage: { input_tokens: 400, output_tokens: 200, total_tokens: 600 },
            },
            session,
          ) +
          tiedLine(
            'task-result-recorded',
            ts,
            {
              task_id: 'cost-epic/task-unmeasured',
              run_status: 'done',
              provider: 'claude',
              model_tier: 'small',
              token_usage: { measured: false },
            },
            session,
          ),
        'utf8',
      );

      const dbPath = path.join(dbDir, 'cost-unmeasured.db');
      await rebuild(dbPath, 'all', { stateDir });
      const costUnmeasured = openDb(dbPath);
      try {
        const result = analytics(costUnmeasured.db);
        expect(result.costByModelTierAndProvider).toContainEqual({
          modelTier: 'small',
          provider: 'claude',
          taskCount: 2,
          totalTokens: 600,
          avgTokensPerTask: 600,
          unmeasuredTaskCount: 1,
        });
      } finally {
        costUnmeasured.sqlite.close();
      }
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

describe('inboxRows() (DS2 §4.1 NeedsYouInbox)', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-inbox-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-inbox-db-'));
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

  it('lists the fixture escalated task (task-3) as the only row', () => {
    const rows = inboxRows(handle.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'escalation', taskId: TASK_3 });
    expect(rows[0]?.title.length).toBeGreaterThan(0);
  });

  it('projects an untagged escalated task to DEFAULT_PROJECT, same as every other query, and it appears when scoped to that project', () => {
    const rows = inboxRows(handle.db);
    expect(rows[0]?.project).toBe(DEFAULT_PROJECT);
    const scoped = inboxRows(handle.db, { project: DEFAULT_PROJECT });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({ kind: 'escalation', taskId: TASK_3 });
  });

  it('adds a per-task pending-waiver row and a pending lesson-candidate row, sorted escalation < waiver < lesson_candidate', async () => {
    const ctx: EventContext = {
      sessionId: SESSION_ID,
      planVersion: 1,
      causalParent: await lastEventId({ stateDir }),
    };
    const raised = await raiseFinding(
      {
        finding: {
          finding_id: 'inbox-pw-1',
          task_id: TASK_1,
          finding_category: 'correctness',
          severity: 'S3-minor',
          finding_status: 'raised',
          summary: 'a stray console.log in the widget renderer',
          failure_scenario: { inputs: 'n=5', expected: '5 items', actual: '4 items' },
          found_by: 'reviewer',
        },
        filePath: 'src/widget.ts',
      },
      ctx,
      { stateDir },
    );
    if (raised.suppressed) throw new Error('inbox-pw-1 unexpectedly suppressed');

    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'scribe',
        event_type: 'lesson-candidate-raised',
        plan_version: 1,
        causal_parent: await lastEventId({ stateDir }),
        payload: {
          lesson_id: 'inbox-lesson-1',
          lesson_type: 'rule',
          lesson_level: 'principle',
          lesson_status: 'candidate',
          lesson_scope: 'claim-path',
          claim_path: 'src/**',
          statement: 'Always run the linter before raising a finding.',
          valid_from: new Date().toISOString(),
          provenance_event_ids: ['inbox-pw-1'],
        },
      },
      { stateDir },
    );

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const fresh = openDb(dbPath);
    try {
      const rows = inboxRows(fresh.db);
      expect(rows.map((r) => r.kind)).toEqual(['escalation', 'waiver', 'lesson_candidate']);
      const waiverRow = rows.find((r) => r.kind === 'waiver');
      expect(waiverRow).toMatchObject({ taskId: TASK_1, project: DEFAULT_PROJECT });
      const scoped = inboxRows(fresh.db, { project: DEFAULT_PROJECT });
      expect(scoped.some((r) => r.kind === 'waiver' && r.taskId === TASK_1)).toBe(true);
      const lessonRow = rows.find((r) => r.kind === 'lesson_candidate');
      expect(lessonRow).toMatchObject({ taskId: null, project: null });
      expect(lessonRow?.title).toContain('linter');
    } finally {
      fresh.sqlite.close();
    }
  });

  it('reports the empty-inbox shape when nothing is pending', async () => {
    // No escalated task, no pending waiver, no pending lesson candidate.
    const emptyStateDir = await mkdtemp(path.join(tmpdir(), 'smith-inbox-empty-events-'));
    const emptyDbDir = await mkdtemp(path.join(tmpdir(), 'smith-inbox-empty-db-'));
    try {
      await appendEvent(
        {
          session_id: 'sess-empty',
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        },
        { stateDir: emptyStateDir },
      );
      const dbPath = path.join(emptyDbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir: emptyStateDir });
      const empty = openDb(dbPath);
      try {
        expect(inboxRows(empty.db)).toEqual([]);
      } finally {
        empty.sqlite.close();
      }
    } finally {
      await rm(emptyStateDir, { recursive: true, force: true });
      await rm(emptyDbDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The same field, read the other way round. `epicsInFlight` was computed by
// naming the *open* statuses and asking `includes()`, so a status this build
// does not recognise answered "not open": the epic left `epicsInFlight`, no
// close put it in `closedEpics`, and ui/src/lib/api.ts's `selectableEpics()`
// — in-flight ∪ closed — stopped offering it on Kanban or Flow at all.
//
// That is reachable without touching this file: factory/policies/taxonomy.yml
// declares the `task_status` vocabulary and events.ts validates `task-added`
// against the declaration, so a thirteenth status is accepted on the wire the
// day it is added there. Five other rosters over this dimension name the
// closed side and ask `!has()`, which defaults an unknown status to "still
// open" — the direction that loses nothing.
// ---------------------------------------------------------------------------
describe('overview() — a task_status this build does not recognise', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-unknown-status-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-unknown-status-db-'));
    await buildFixture({ stateDir });
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  /**
   * Statuses are set on the projected rows rather than appended to the log:
   * the wire path for an unrecognised status runs through taxonomy.yml, and a
   * test may not edit a policy file. The row state is identical either way,
   * and the subject here is the reader — db/soleWriter.test.ts sets
   * `taskStatus` by hand for the same reason. Nothing is rebuilt afterwards,
   * because a rebuild replacing these values is soleWriter's subject, not
   * this one.
   */
  async function projectWithStatuses(statuses: Record<string, string>): Promise<DbHandle> {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const projected = openDb(dbPath);
    for (const [taskId, taskStatus] of Object.entries(statuses)) {
      projected.db.update(tasks).set({ taskStatus }).where(eq(tasks.taskId, taskId)).run();
    }
    return projected;
  }

  it('still reports the epic in flight: unrecognised is not finished', async () => {
    handle = await projectWithStatuses({
      [TASK_1]: 'completed',
      [TASK_2]: 'completed',
      [TASK_3]: 'completed',
      [TASK_4]: 'queued',
    });

    const result = overview(handle.db);
    expect(result.epicsInFlight).toEqual([EPIC_ID]);
    // And so it stays reachable: an epic in neither list is one no operator
    // can pick a board for.
    expect(result.closedEpics).toEqual([]);
  });

  it('cannot pass vacuously: the same four tasks all terminal are not in flight', async () => {
    handle = await projectWithStatuses({
      [TASK_1]: 'completed',
      [TASK_2]: 'completed',
      [TASK_3]: 'completed',
      [TASK_4]: 'completed',
    });

    expect(overview(handle.db).epicsInFlight).toEqual([]);
  });

  // DS2 / ds-spec.md §4.1 "Data/API note", audit item 2 — an epic whose last
  // open task went `escalated` (or `failed`) is a person's queue item, not a
  // finished epic: no `epic-closed` event exists for it, so it used to fall
  // OUT of both `epicsInFlight` and `closedEpics` the moment the last task hit
  // one of those two statuses — TERMINAL_TASK_STATUSES (db/projector.ts's "the
  // projector will not overwrite this") counts them terminal, but
  // taskStatus.ts's own HELD_OPEN_BY_AN_OPERATOR says a person is still
  // expected to come back to them. The epic disappeared from every picker
  // Home/Kanban/Flow read `epicsInFlight`/`closedEpics` from.
  it('keeps an epic in flight when its last open task is escalated, not closed', async () => {
    handle = await projectWithStatuses({
      [TASK_1]: 'completed',
      [TASK_2]: 'completed',
      [TASK_3]: 'completed',
      [TASK_4]: 'escalated',
    });

    const result = overview(handle.db);
    expect(result.epicsInFlight).toEqual([EPIC_ID]);
    expect(result.closedEpics).toEqual([]);
  });

  it('keeps an epic in flight when its last open task failed, not closed', async () => {
    handle = await projectWithStatuses({
      [TASK_1]: 'completed',
      [TASK_2]: 'completed',
      [TASK_3]: 'completed',
      [TASK_4]: 'failed',
    });

    expect(overview(handle.db).epicsInFlight).toEqual([EPIC_ID]);
  });

  // DS2 review F1: `epicsInFlight` keeps the epic reachable on Kanban/Flow —
  // asserted above — but Home's "Running now" must not present it as running
  // when nothing is actually running in it. `epicsActivelyRunning` is the
  // narrower signal Home reads for that.
  it('drops an epic out of epicsActivelyRunning when its only open task is escalated, though it stays in epicsInFlight', async () => {
    handle = await projectWithStatuses({
      [TASK_1]: 'completed',
      [TASK_2]: 'completed',
      [TASK_3]: 'completed',
      [TASK_4]: 'escalated',
    });

    const result = overview(handle.db);
    expect(result.epicsInFlight).toEqual([EPIC_ID]);
    expect(result.epicsActivelyRunning).toEqual([]);
  });

  it('drops an epic out of epicsActivelyRunning when its only open task failed, though it stays in epicsInFlight', async () => {
    handle = await projectWithStatuses({
      [TASK_1]: 'completed',
      [TASK_2]: 'completed',
      [TASK_3]: 'completed',
      [TASK_4]: 'failed',
    });

    const result = overview(handle.db);
    expect(result.epicsInFlight).toEqual([EPIC_ID]);
    expect(result.epicsActivelyRunning).toEqual([]);
  });

  it('keeps an epic in epicsActivelyRunning when it has a truly open task alongside an escalated one', async () => {
    handle = await projectWithStatuses({
      [TASK_1]: 'completed',
      [TASK_2]: 'in-progress',
      [TASK_3]: 'completed',
      [TASK_4]: 'escalated',
    });

    const result = overview(handle.db);
    expect(result.epicsInFlight).toEqual([EPIC_ID]);
    expect(result.epicsActivelyRunning).toEqual([EPIC_ID]);
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
 * Operator directive (dogfood round 2): "the overview never updates, and the
 * now-running block should show the sessions that are running right now, with
 * an animated indicator."
 *
 * The Overview's "Now running" card was fed by `liveAgentEntries` sorted
 * longest-running-first, and the `agents` table keeps a row `live` until a
 * terminal event closes it out. In the real state/smith.db the twelve oldest
 * `live` rows are all from a session whose last event was five days ago, so
 * the card was permanently occupied by ghosts and never changed — exactly the
 * "never updates" the operator reported. `runningSessions` answers the
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
      lastEventType: 'operator-feedback-resolved',
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

describe('lessonOwnerSession()', () => {
  const OTHER = 'sess-owner-later';
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-lesson-owner-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-lesson-owner-db-'));
    await buildFixture({ stateDir });

    // A second session that raises a lesson (lesson-owned-2) SESSION_ID never
    // touches, then changes that lesson's status within the same session —
    // the projection must still resolve it to OTHER, not SESSION_ID.
    const start = await appendEvent(
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
    const raised = await appendEvent(
      {
        session_id: OTHER,
        actor: 'scribe',
        event_type: 'lesson-candidate-raised',
        plan_version: 1,
        causal_parent: start.event_id,
        payload: {
          lesson_id: 'lesson-owned-2',
          lesson_type: 'rule',
          lesson_level: 'principle',
          lesson_status: 'candidate',
          lesson_scope: 'claim-path',
          statement: 'Owned by the second session, not the fixture one.',
          valid_from: new Date().toISOString(),
          provenance_event_ids: [start.event_id],
          evidence: 'test fixture',
        },
      },
      { stateDir },
    );
    await appendEvent(
      {
        session_id: OTHER,
        actor: 'user',
        event_type: 'lesson-status-changed',
        plan_version: 1,
        causal_parent: raised.event_id,
        payload: { lesson_id: 'lesson-owned-2', to_status: 'approved' },
      },
      { stateDir },
    );

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('returns the session that owns the lesson, not any other projected session', () => {
    expect(lessonOwnerSession(handle.db, 'lesson-owned-2')).toBe(OTHER);
    expect(lessonOwnerSession(handle.db, 'lesson-1')).toBe(SESSION_ID);
  });

  it('returns null for an unknown lesson id', () => {
    expect(lessonOwnerSession(handle.db, 'no-such-lesson')).toBeNull();
  });

  it('still resolves to the owning session after its status changed in that same session', () => {
    // lesson-owned-2's status moved candidate -> approved above, both events
    // in OTHER's own log — the owner must not shift with the status.
    expect(lessonOwnerSession(handle.db, 'lesson-owned-2')).toBe(OTHER);
  });
});
