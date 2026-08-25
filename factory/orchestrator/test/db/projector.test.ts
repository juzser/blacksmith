import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, openDb, rebuild } from '../../src/db/projector.js';
import { kanban, lessonsPage } from '../../src/db/queries.js';
import * as schema from '../../src/db/schema.js';
import { appendEvent, readEvents } from '../../src/events.js';
import {
  foldFindingsDetailed,
  listFindings,
  REQUIRED_FOLD_FIELDS,
  REQUIRED_PROJECTION_FIELDS,
} from '../../src/findings.js';
import { buildFixture, EPIC_ID, SESSION_ID, TASK_1, TASK_2, TASK_3, TASK_4 } from './fixtures.js';

function allRows(db: ReturnType<typeof openDb>['db']) {
  return {
    events: db.select().from(schema.eventsRaw).all(),
    sessions: db.select().from(schema.sessions).all(),
    prompts: db.select().from(schema.prompts).all(),
    dispatches: db.select().from(schema.dispatches).all(),
    agents: db.select().from(schema.agents).all(),
    tasks: db.select().from(schema.tasks).all(),
    edges: db.select().from(schema.edges).all(),
    errors: db.select().from(schema.errors).all(),
    findings: db.select().from(schema.findings).all(),
    waivers: db.select().from(schema.waivers).all(),
    lessons: db.select().from(schema.lessons).all(),
    artifacts: db.select().from(schema.artifacts).all(),
  };
}

describe('db/projector.ts', () => {
  let stateDir: string;
  let dbDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-projector-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-projector-db-'));
    await buildFixture({ stateDir });
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('round-trips every table from the synthesized event log', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    const events = await readEvents(SESSION_ID, { stateDir });
    const result = await rebuild(dbPath, 'all', { stateDir });
    // `skippedFindings` is present and empty, not absent: a caller must be able
    // to tell "nothing was held back" from "this build predates the field".
    expect(result).toEqual({
      sessionsProcessed: 1,
      eventsApplied: events.length,
      skippedFindings: [],
    });

    const handle = openDb(dbPath);
    const rows = allRows(handle.db);
    handle.sqlite.close();

    expect(rows.events).toHaveLength(events.length);
    expect(rows.sessions).toEqual([
      {
        sessionId: SESSION_ID,
        startedAt: events[0]?.record.ts,
        lastEventAt: events[events.length - 1]?.record.ts,
        eventCount: events.length,
      },
    ]);
    expect(rows.prompts).toHaveLength(1);
    expect(rows.prompts[0]?.prompt).toBe('Build the widget and fix the flaky import.');
    expect(rows.dispatches).toHaveLength(4);
    expect(rows.agents).toHaveLength(4);
    expect(rows.tasks).toHaveLength(4);
    expect(rows.edges).toHaveLength(1);
    expect(rows.errors).toHaveLength(1);
    expect(rows.findings).toHaveLength(3); // finding-1, finding-2, finding-4 — finding-3 was suppressed, never lands here
    expect(rows.waivers).toHaveLength(2); // one granted, one denied
    expect(rows.lessons).toHaveLength(2); // lesson-1 approved, lesson-2 invalidated
    expect(rows.artifacts).toHaveLength(1);

    const taskById = Object.fromEntries(rows.tasks.map((t) => [t.taskId, t]));
    expect(taskById[TASK_1]).toMatchObject({
      epicId: EPIC_ID,
      caseTag: 'feature',
      taskStatus: 'completed',
      branch: `smith/${EPIC_ID}/task-1`,
      budgetTokens: 2000,
    });
    expect(taskById[TASK_2]).toMatchObject({ taskStatus: 'reviewing', caseTag: 'refactor' });
    expect(taskById[TASK_3]).toMatchObject({ taskStatus: 'escalated', caseTag: 'bugfix' });
    expect(taskById[TASK_4]).toMatchObject({ taskStatus: 'in-progress', caseTag: 'feature' });

    const findingById = Object.fromEntries(rows.findings.map((f) => [f.findingId, f]));
    expect(findingById['finding-1']).toMatchObject({
      findingStatus: 'fix-verified',
      severity: 'S2-major',
    });
    expect(findingById['finding-2']).toMatchObject({
      findingStatus: 'waived',
      waiverId: expect.any(String),
    });
    expect(findingById['finding-4']).toMatchObject({
      findingStatus: 'confirmed',
      severity: 'S2-major',
    });

    const agentByTask = Object.fromEntries(rows.agents.map((a) => [a.taskId, a]));
    expect(agentByTask[TASK_1]).toMatchObject({ status: 'done' });
    expect(agentByTask[TASK_2]).toMatchObject({ status: 'live' });
    expect(agentByTask[TASK_3]).toMatchObject({ status: 'error' });
    expect(agentByTask[TASK_4]).toMatchObject({ status: 'live' });

    expect(rows.lessons[0]).toMatchObject({
      lessonId: 'lesson-1',
      lessonStatus: 'approved',
      timesPrevented: 1,
    });
  });

  it('is idempotent: rebuilding twice yields identical rows', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle1 = openDb(dbPath);
    const first = allRows(handle1.db);
    handle1.sqlite.close();

    await rebuild(dbPath, 'all', { stateDir });
    const handle2 = openDb(dbPath);
    const second = allRows(handle2.db);
    handle2.sqlite.close();

    expect(second).toEqual(first);
  });

  it('incremental apply() on a fresh db produces the same rows as a full rebuild()', async () => {
    const rebuiltPath = path.join(dbDir, 'rebuilt.db');
    await rebuild(rebuiltPath, 'all', { stateDir });
    const rebuiltHandle = openDb(rebuiltPath);
    const rebuiltRows = allRows(rebuiltHandle.db);
    rebuiltHandle.sqlite.close();

    const appliedPath = path.join(dbDir, 'applied.db');
    await apply(appliedPath, SESSION_ID, { stateDir });
    const appliedHandle = openDb(appliedPath);
    const appliedRows = allRows(appliedHandle.db);
    appliedHandle.sqlite.close();

    expect(appliedRows).toEqual(rebuiltRows);
  });

  it('never materialises a task row for the reserved <epic>/integration ref, but a normal task id still gets one', async () => {
    const { appendEvent, readEvents } = await import('../../src/events.js');
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'dispatch_decision',
        task_id: `${EPIC_ID}/integration`,
        plan_version: 1,
        causal_parent: (await readEvents(SESSION_ID, { stateDir })).at(-1)?.event_id ?? null,
        payload: {
          agent_role: 'verifier',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
          reason: 'epic verdict',
        },
      },
      { stateDir },
    );

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const rows = allRows(handle.db);
    handle.sqlite.close();

    const taskIds = rows.tasks.map((t) => t.taskId);
    expect(taskIds).not.toContain(`${EPIC_ID}/integration`);
    expect(taskIds).toContain(TASK_1);
  });

  it('never materialises a task row for the reserved <epic>/plan-v<n> ref', async () => {
    const { appendEvent, readEvents } = await import('../../src/events.js');
    // planQuorum.ts's runPlanQuorum() stamps this ref onto the
    // dispatch_decision/judge-verdict/quorum-decision events its quorum case
    // emits. Same phantom-row hazard as <epic>/integration above: a plan is
    // not a task and must never surface as a kanban card.
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'dispatch_decision',
        task_id: `${EPIC_ID}/plan-v2`,
        plan_version: 2,
        causal_parent: (await readEvents(SESSION_ID, { stateDir })).at(-1)?.event_id ?? null,
        payload: {
          agent_role: 'verifier',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
          reason: 'plan quorum',
        },
      },
      { stateDir },
    );

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const rows = allRows(handle.db);
    handle.sqlite.close();

    const taskIds = rows.tasks.map((t) => t.taskId);
    expect(taskIds).not.toContain(`${EPIC_ID}/plan-v2`);
    expect(taskIds).toContain(TASK_1);
  });

  it('apply() only refreshes the named session, leaving other sessions untouched', async () => {
    // A second, unrelated session in the same events dir.
    const { appendEvent } = await import('../../src/events.js');
    await appendEvent(
      {
        session_id: 'sess-other',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });

    const handleBefore = openDb(dbPath);
    const otherBefore = handleBefore.db.select().from(schema.sessions).all();
    handleBefore.sqlite.close();
    expect(otherBefore.map((s) => s.sessionId).sort()).toEqual(['sess-fixture', 'sess-other']);

    await apply(dbPath, SESSION_ID, { stateDir });

    const handleAfter = openDb(dbPath);
    const afterRows = handleAfter.db.select().from(schema.sessions).all();
    handleAfter.sqlite.close();
    expect(afterRows.map((s) => s.sessionId).sort()).toEqual(['sess-fixture', 'sess-other']);
  });
});

// ---------------------------------------------------------------------------
// D-141. The fold and the projection disagreed about what a finding record must
// carry. `REQUIRED_FOLD_FIELDS` is deliberately short — a reader coping with
// history should not quarantine a record over a field no reader dereferences —
// but `db/schema.ts` declares eight payload-sourced columns `notNull()`, so a
// record the fold happily returns could still abort the INSERT. On this repo's
// own event store that is exactly what happened: 18 of 57 `finding-raised`
// records predate `fingerprint`, and `smith db rebuild` died on the first one
// with `SqliteError: NOT NULL constraint failed: findings.fingerprint` — the
// documented recovery verb, unusable.
//
// D-135's rule applies unchanged: a loud undercount beats a crash, and both
// beat a quiet one. So the record is quarantined and named, not dropped and not
// fatal — and `smith findings list` keeps showing it, because the fold's own
// requirements have not moved.
// ---------------------------------------------------------------------------

describe('db/projector.ts — a legacy finding that cannot fill a notNull column', () => {
  let stateDir: string;
  let dbDir: string;

  const LEGACY_ID = 'finding-legacy';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-projector-d141-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-projector-d141-db-'));
    await buildFixture({ stateDir });
    // Written straight to the log, bypassing appendEvent: this is a record from
    // before the write-time guard existed, and no test can produce one through
    // the guarded path. Everything but `fingerprint` is well-formed.
    const priorEvents = await readEvents(SESSION_ID, { stateDir });
    const legacy = {
      session_id: SESSION_ID,
      actor: 'reviewer',
      event_type: 'finding-raised',
      task_id: TASK_1,
      plan_version: 1,
      causal_parent: priorEvents.at(-1)?.event_id ?? null,
      ts: '2026-08-15T00:00:00.000Z',
      payload: {
        finding_id: LEGACY_ID,
        task_id: TASK_1,
        finding_category: 'correctness',
        severity: 'S2-major',
        finding_status: 'raised',
        summary: 'raised before findings carried a fingerprint',
        failure_scenario: { inputs: 'n=5', expected: '5 items', actual: '4 items' },
        found_by: 'reviewer',
      },
    };
    await appendFile(path.join(stateDir, `${SESSION_ID}.jsonl`), `${JSON.stringify(legacy)}\n`);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('the fold still returns it — this is a projection limit, not a fold one', async () => {
    const events = await readEvents(SESSION_ID, { stateDir });
    const { findings, skipped } = foldFindingsDetailed(events, {});
    expect(findings.map((f) => f.finding_id)).toContain(LEGACY_ID);
    expect(skipped).toHaveLength(0);
  });

  it('rebuild() completes instead of aborting the whole projection', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    const result = await rebuild(dbPath, 'all', { stateDir });

    const handle = openDb(dbPath);
    const rows = allRows(handle.db);
    handle.sqlite.close();

    // Every well-formed finding still lands; only the one that cannot fill a
    // notNull column is held back.
    expect(rows.findings.map((f) => f.findingId).sort()).toEqual([
      'finding-1',
      'finding-2',
      'finding-4',
    ]);
    expect(result.sessionsProcessed).toBe(1);
  });

  it('names the quarantined record, the field it lacks, and the event it came from', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    const result = await rebuild(dbPath, 'all', { stateDir });

    expect(result.skippedFindings).toHaveLength(1);
    const [only] = result.skippedFindings;
    expect(only?.finding_id).toBe(LEGACY_ID);
    expect(only?.reason).toContain('fingerprint');
    // The event id is what an operator greps the log for.
    expect(only?.event_id).toMatch(/^sess-fixture#\d+$/);
  });

  it('apply() reports the same quarantine as rebuild(), not a silently shorter table', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const applied = await apply(dbPath, SESSION_ID, { stateDir });
    expect(applied.skippedFindings.map((s) => s.finding_id)).toEqual([LEGACY_ID]);
  });
});

// ---------------------------------------------------------------------------
// The other half of D-141's fix shape: "the two lists should be derived from
// one place, so a notNull() column cannot be added without the fold learning to
// skip records that cannot fill it". This is that guarantee — it fails the
// moment someone adds a notNull() column to the findings table without adding
// the payload field that fills it to REQUIRED_PROJECTION_FIELDS.
// ---------------------------------------------------------------------------

describe('findings table notNull columns vs REQUIRED_PROJECTION_FIELDS', () => {
  // Filled by the projector itself, never read off the payload, so they can
  // never be the reason a record is unprojectable.
  const PROJECTOR_SUPPLIED = ['session_id', 'raised_at', 'updated_at'];

  it('every notNull column is either projector-supplied or a required payload field', () => {
    const notNullColumns = Object.values(getTableColumns(schema.findings))
      .filter((c) => c.notNull)
      .map((c) => c.name);

    const unaccounted = notNullColumns.filter(
      (name) =>
        !PROJECTOR_SUPPLIED.includes(name) &&
        !(REQUIRED_PROJECTION_FIELDS as readonly string[]).includes(name),
    );
    expect(unaccounted).toEqual([]);
  });

  it('covers the fold requirements too, so the projection can never accept less', () => {
    for (const field of REQUIRED_FOLD_FIELDS) {
      expect(REQUIRED_PROJECTION_FIELDS as readonly string[]).toContain(field);
    }
  });
});

/**
 * D-199. `transitionLesson` reads the LINEAGE on purpose — approving from a
 * continuation the candidate the parent raised "is the ordinary shape of a
 * long epic". The projector folded one session at a time, so the approval
 * landed in session B's log and was dropped: `foldLessons` sees a
 * `lesson-status-changed` for a lesson_id it has no row for and continues.
 *
 * The projection is what every reader reads. `lessonsPage` buckets by the
 * projected status, and `smith lessons compile` writes `lessons.md` from
 * `lessonsPage(...).approved` — so the drop does not stop at the UI, it
 * decides which lessons reach an agent's prompt.
 */
describe('D-199: a lesson approved from a continuation session', () => {
  let stateDir: string;
  let dbDir: string;
  const RAISER = 'sess-d199-a';
  const APPROVER = 'sess-d199-b';

  /**
   * Two sessions, chained: the approver's `session-start` names an event in
   * the raiser's log as its causal_parent, which is exactly what makes it a
   * continuation as far as `walkLineage` is concerned.
   */
  async function buildTwoSessionLesson(): Promise<void> {
    const opts = { stateDir };
    const rootA = await appendEvent(
      {
        session_id: RAISER,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      opts,
    );
    await appendEvent(
      {
        session_id: RAISER,
        actor: 'scribe',
        event_type: 'lesson-candidate-raised',
        plan_version: 1,
        causal_parent: rootA.event_id,
        payload: {
          lesson_id: 'lesson-d199',
          lesson_type: 'rule',
          lesson_level: 'principle',
          lesson_status: 'candidate',
          lesson_scope: 'claim-path',
          statement: 'Read the scope the writer wrote at, not the one you fold at.',
          valid_from: '2026-01-01T00:00:00.000Z',
          provenance_event_ids: [rootA.event_id],
        },
      },
      opts,
    );
    const rootB = await appendEvent(
      {
        session_id: APPROVER,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: rootA.event_id,
        payload: {},
      },
      opts,
    );
    await appendEvent(
      {
        session_id: APPROVER,
        actor: 'user',
        event_type: 'lesson-status-changed',
        plan_version: 1,
        causal_parent: rootB.event_id,
        payload: { lesson_id: 'lesson-d199', to_status: 'approved' },
      },
      opts,
    );
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-d199-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-d199-db-'));
    await buildTwoSessionLesson();
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('is approved in the projection, and still owned by the session that raised it', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.lessons).all();
    handle.sqlite.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lessonId: 'lesson-d199',
      // The raiser still owns the row: `lessonsPage({ sessionId })` means
      // "lessons raised here", and the approval must not move a lesson.
      sessionId: RAISER,
      lessonStatus: 'approved',
    });
  });

  it('does not depend on the order the sessions happen to be replayed in', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    // The descendant first — `listSessionIds` orders by nothing causal, so a
    // fix that only works parents-first is a fix that works by luck.
    await rebuild(dbPath, [APPROVER, RAISER], { stateDir });
    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.lessons).all();
    handle.sqlite.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.lessonStatus).toBe('approved');
  });

  it('survives an incremental apply() of the session that raised it', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    // ui/server calls apply() after every lesson event, and the raiser is a
    // live session that can keep writing. Re-folding it must not walk the
    // approval back to `candidate`.
    await apply(dbPath, RAISER, { stateDir });
    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.lessons).all();
    handle.sqlite.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.lessonStatus).toBe('approved');
  });

  it('is not offered to the operator as still pending', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const page = lessonsPage(handle.db);
    handle.sqlite.close();

    // The contradiction this closes: `lessonsPage` said "pending", and
    // `transitionLesson` — which reads the lineage — answers a click on that
    // card with "illegal transition approved -> approved".
    expect(page.pending).toHaveLength(0);
    expect(page.approved.map((l) => l.lessonId)).toEqual(['lesson-d199']);
  });
});

/**
 * D-200, the same shape as D-199 one table over. `transition()` reads the
 * LINEAGE on purpose ("a finding raised in the first session of a
 * cross-session epic is otherwise not FOUND from the second") and appends the
 * `finding-transitioned` event to the session it was called in — the
 * continuation. The projector folded one session at a time, so that event
 * arrived at `foldFindingsDetailed` without the `finding-raised` it amends,
 * and the fold correctly continued past a transition for an id it holds no
 * row for.
 *
 * What the operator sees is the pre-transition status, forever: the Kanban
 * hangs a worst-open-severity chip on the task from the projected status, so
 * a refuted S2 keeps flagging a task nobody needs to look at, and `smith
 * findings list` — which reads the lineage — disagrees with the board.
 */
describe('D-200: a finding transitioned from a continuation session', () => {
  let stateDir: string;
  let dbDir: string;
  const RAISER = 'sess-d200-a';
  const CLOSER = 'sess-d200-b';
  const EPIC = 'epic-d200';
  const TASK = `${EPIC}/task-1`;

  /**
   * Two sessions, chained the way `walkLineage` reads a continuation: the
   * closer's `session-start` names the raiser's root event as its
   * causal_parent. `raised -> refuted` is one legal hop (LEGAL_TRANSITIONS)
   * and lands in a CLOSED status, which is what makes the Kanban chip below
   * an observable difference rather than a field comparison.
   */
  async function buildTwoSessionFinding(): Promise<void> {
    const opts = { stateDir };
    const rootA = await appendEvent(
      {
        session_id: RAISER,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      opts,
    );
    const added = await appendEvent(
      {
        session_id: RAISER,
        actor: 'planner',
        event_type: 'task-added',
        task_id: TASK,
        plan_version: 1,
        causal_parent: rootA.event_id,
        payload: {
          epic_id: EPIC,
          case: 'bugfix',
          origin: 'user',
          task_status: 'todo',
          plan_version: 1,
          objective: 'Fold the finding at the scope its id is unique at.',
          claims: ['src/db/projector.ts'],
          budget_tokens: 2000,
        },
      },
      opts,
    );
    await appendEvent(
      {
        session_id: RAISER,
        actor: 'reviewer',
        event_type: 'finding-raised',
        task_id: TASK,
        plan_version: 1,
        causal_parent: added.event_id,
        payload: {
          finding_id: 'f-d200',
          fingerprint: 'fp-d200',
          task_id: TASK,
          file_path: 'src/db/projector.ts',
          severity: 'S2-major',
          finding_category: 'correctness',
          finding_status: 'raised',
          summary: 'the projection folds findings one session at a time',
          failure_scenario: {
            inputs: 'a finding transitioned from a continuation session',
            expected: 'the projected row carries the new status',
            actual: 'the projected row keeps the raised status',
          },
          found_by: 'reviewer',
        },
      },
      opts,
    );
    const rootB = await appendEvent(
      {
        session_id: CLOSER,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: rootA.event_id,
        payload: {},
      },
      opts,
    );
    await appendEvent(
      {
        session_id: CLOSER,
        actor: 'verifier',
        event_type: 'finding-transitioned',
        task_id: TASK,
        plan_version: 1,
        causal_parent: rootB.event_id,
        payload: { finding_id: 'f-d200', to_status: 'refuted' },
      },
      opts,
    );
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-d200-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-d200-db-'));
    await buildTwoSessionFinding();
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('is refuted in the projection, and still owned by the session that raised it', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.findings).all();
    handle.sqlite.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      findingId: 'f-d200',
      // The raiser keeps the row: a findings query scoped to a session means
      // "findings raised here", and closing one must not move it.
      sessionId: RAISER,
      findingStatus: 'refuted',
    });
  });

  it('does not depend on the order the sessions happen to be replayed in', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    // The descendant first. `listSessionIds` sorts by filename, which is
    // nothing causal, so a fix that only works parents-first works by luck.
    await rebuild(dbPath, [CLOSER, RAISER], { stateDir });
    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.findings).all();
    handle.sqlite.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.findingStatus).toBe('refuted');
  });

  it('survives an incremental apply() of the session that raised it', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    // ui/server calls apply() after every event, and the raiser is a live
    // session that keeps writing. Re-folding it must not walk the finding
    // back to `raised`.
    await apply(dbPath, RAISER, { stateDir });
    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.findings).all();
    handle.sqlite.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.findingStatus).toBe('refuted');
  });

  it('stops flagging its task on the board as having an open finding', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const columns = kanban(handle.db, EPIC);
    handle.sqlite.close();

    const task = columns.flatMap((c) => c.tasks).find((t) => t.taskId === TASK);
    expect(task?.tags.severity).toBeNull();
  });

  it('agrees with the reader `smith findings list` prints from', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const projected = handle.db.select().from(schema.findings).all();
    handle.sqlite.close();

    // listFindings reads the lineage (D-119). The board and the CLI answering
    // differently about the same finding is the contradiction this closes.
    const listed = await listFindings(CLOSER, {}, { stateDir });
    expect(listed.map((f) => [f.finding_id, f.finding_status])).toEqual([['f-d200', 'refuted']]);
    expect(projected.map((f) => [f.findingId, f.findingStatus])).toEqual(
      listed.map((f) => [f.finding_id, f.finding_status]),
    );
  });
});
