// Phase 6b — project dimension. A small, self-contained two-project fixture
// (deliberately NOT layered onto fixtures.ts's single-project fixture, to
// keep this the one place project-scoping behaviour is asserted without
// risking a drift-prone edit to the shared fixture every other test file
// depends on).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, openDb } from '../../src/db/projector.js';
import {
  analytics,
  errorsPage,
  kanban,
  overview,
  roadmapPage,
  timeline,
} from '../../src/db/queries.js';
import * as schema from '../../src/db/schema.js';
import { appendEvent, type EventInput, type EventOpts, readEvents } from '../../src/events.js';

const SESSION_ID = 'sess-project-fixture';

async function buildTwoProjectFixture(opts: EventOpts): Promise<void> {
  let parent: string | null = null;
  const root = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    },
    opts,
  );
  parent = root.event_id;

  // Project A: black-smith (default — every event omits `project`).
  const taskA = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'task-added',
      task_id: 'epic-a/task-1',
      plan_version: 1,
      causal_parent: parent,
      payload: {
        epic_id: 'epic-a',
        case: 'feature',
        origin: 'user',
        task_status: 'completed',
        budget_tokens: 1000,
      },
    },
    opts,
  );
  parent = taskA.event_id;

  const dispatchA = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'dispatch_decision',
      task_id: 'epic-a/task-1',
      plan_version: 1,
      causal_parent: parent,
      payload: {
        agent_role: 'coder',
        provider: 'claude',
        model_tier: 'mid',
        model: 'claude-sonnet-5',
        reason: 'a',
      },
    },
    opts,
  );
  parent = dispatchA.event_id;

  const errorA = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'coder',
      event_type: 'error-logged',
      task_id: 'epic-a/task-1',
      plan_version: 1,
      causal_parent: parent,
      payload: { error: 'execution.test-failure', severity: 'S2-major', task_ref: 'epic-a/task-1' },
    },
    opts,
  );
  parent = errorA.event_id;

  // D-207. The two events analytics() aggregates that are NOT tasks: a result
  // (cost) and a decisions batch (same-mistake rate). Neither carries a
  // project of its own here -- like every such row logged before Phase 6b --
  // so the only thing that can place them is the task they name.
  const resultA = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'coder',
      event_type: 'task-result-recorded',
      task_id: 'epic-a/task-1',
      plan_version: 1,
      causal_parent: parent,
      payload: {
        task_id: 'epic-a/task-1',
        run_status: 'done',
        structured_output: {},
        artifacts: [],
        token_usage: { input_tokens: 800, output_tokens: 200, total_tokens: 1000 },
        agent: 'coder',
        provider: 'claude',
        model_tier: 'mid',
      },
    },
    opts,
  );
  parent = resultA.event_id;

  const decisionsA = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'orchestrator',
      event_type: 'severity-decisions',
      task_id: 'epic-a/task-1',
      plan_version: 1,
      causal_parent: parent,
      payload: { decisions: [{ same_mistake: false }, { same_mistake: true }] },
    },
    opts,
  );
  parent = decisionsA.event_id;

  // Project B: demo-hub (every event explicitly stamped `project: 'demo-hub'`).
  const taskB = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'task-added',
      task_id: 'epic-b/task-1',
      plan_version: 1,
      causal_parent: parent,
      project: 'demo-hub',
      payload: {
        epic_id: 'epic-b',
        case: 'feature',
        origin: 'user',
        task_status: 'in-progress',
        budget_tokens: 2000,
      },
    },
    opts,
  );
  parent = taskB.event_id;

  const dispatchB = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'dispatch_decision',
      task_id: 'epic-b/task-1',
      plan_version: 1,
      causal_parent: parent,
      project: 'demo-hub',
      payload: {
        agent_role: 'coder',
        provider: 'codex',
        model_tier: 'small',
        model: 'codex:default',
        reason: 'b',
      },
    },
    opts,
  );
  parent = dispatchB.event_id;

  const errorB = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'coder',
      event_type: 'error-logged',
      task_id: 'epic-b/task-1',
      plan_version: 1,
      causal_parent: parent,
      project: 'demo-hub',
      payload: { error: 'judgment.hallucination', severity: 'S3-minor', task_ref: 'epic-b/task-1' },
    },
    opts,
  );
  parent = errorB.event_id;

  const resultB = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'coder',
      event_type: 'task-result-recorded',
      task_id: 'epic-b/task-1',
      plan_version: 1,
      causal_parent: parent,
      project: 'demo-hub',
      payload: {
        task_id: 'epic-b/task-1',
        run_status: 'done',
        structured_output: {},
        artifacts: [],
        token_usage: { input_tokens: 1600, output_tokens: 400, total_tokens: 2000 },
        agent: 'coder',
        provider: 'codex',
        model_tier: 'small',
      },
    },
    opts,
  );
  parent = resultB.event_id;

  await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'orchestrator',
      event_type: 'severity-decisions',
      task_id: 'epic-b/task-1',
      plan_version: 1,
      causal_parent: parent,
      project: 'demo-hub',
      payload: { decisions: [{ same_mistake: false }] },
    },
    opts,
  );
}

describe('project dimension (Phase 6b)', () => {
  let stateDir: string;
  let dbDir: string;
  let dbPath: string;
  /** Named but never written by default, so projectMilestones() skips it:
   * without an explicit path the projector falls back to the repo's OWN
   * factory/specs/roadmap.md, which would make these assertions depend on
   * whatever phases the roadmap happens to declare today. The one test that
   * wants milestones writes this file itself. */
  let roadmapPath: string;
  let db: ReturnType<typeof openDb>['db'];
  let sqlite: ReturnType<typeof openDb>['sqlite'];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-project-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-project-db-'));
    dbPath = path.join(dbDir, 'smith.db');
    roadmapPath = path.join(dbDir, 'roadmap.md');
    await buildTwoProjectFixture({ stateDir });
    await apply(dbPath, SESSION_ID, { stateDir, roadmapPath });
    const handle = openDb(dbPath);
    db = handle.db;
    sqlite = handle.sqlite;
  });

  afterEach(async () => {
    sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('stamps project on tasks/dispatches/errors/events_raw; absent project reads back null', () => {
    const taskA = db
      .select()
      .from(schema.tasks)
      .all()
      .find((t) => t.taskId === 'epic-a/task-1');
    expect(taskA?.project).toBeNull();

    const taskB = db
      .select()
      .from(schema.tasks)
      .all()
      .find((t) => t.taskId === 'epic-b/task-1');
    expect(taskB?.project).toBe('demo-hub');
  });

  it("overview() scoped to a project only sees that project's data", () => {
    const resultA = overview(db, { project: 'black-smith' });
    expect(resultA.epicsInFlight).toEqual([]); // task-1 in epic-a is completed, not in-flight
    expect(resultA.tokensByEpic.map((e) => e.epicId)).toEqual(['epic-a']);

    const resultB = overview(db, { project: 'demo-hub' });
    expect(resultB.epicsInFlight).toEqual(['epic-b']);
    expect(resultB.tokensByEpic.map((e) => e.epicId)).toEqual(['epic-b']);
  });

  it('overview() global mode (no project filter) aggregates + returns a per-project breakdown', () => {
    const result = overview(db);
    expect(result.tokensByEpic.map((e) => e.epicId).sort()).toEqual(['epic-a', 'epic-b']);
    expect(result.projects).toBeDefined();
    const projects = (result.projects ?? []).map((p) => p.project).sort();
    expect(projects).toEqual(['black-smith', 'demo-hub']);
    const demoHub = result.projects?.find((p) => p.project === 'demo-hub');
    expect(demoHub?.epicsInFlight).toEqual(['epic-b']);
  });

  it('kanban() supports an epicId-less "all epics" mode, still scoped by project', () => {
    const columnsB = kanban(db, undefined, { project: 'demo-hub' });
    const allTaskIds = columnsB.flatMap((c) => c.tasks.map((t) => t.taskId));
    expect(allTaskIds).toEqual(['epic-b/task-1']);
  });

  it('timeline() accepts a project filter', () => {
    const entriesA = timeline(db, { project: 'black-smith' });
    expect(entriesA.every((e) => e.taskId === null || e.taskId === 'epic-a/task-1')).toBe(true);
    const entriesB = timeline(db, { project: 'demo-hub' });
    expect(entriesB.some((e) => e.taskId === 'epic-b/task-1')).toBe(true);
    expect(entriesB.every((e) => e.taskId !== 'epic-a/task-1')).toBe(true);
  });

  it('errorsPage() and roadmapPage() accept a project filter', () => {
    const errA = errorsPage(db, { project: 'black-smith' });
    expect(errA.byClass.map((c) => `${c.errorGroup}.${c.errorClass}`)).toEqual([
      'execution.test-failure',
    ]);
    const errB = errorsPage(db, { project: 'demo-hub' });
    expect(errB.byClass.map((c) => `${c.errorGroup}.${c.errorClass}`)).toEqual([
      'judgment.hallucination',
    ]);

    expect(() => roadmapPage(db, { project: 'demo-hub' })).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // D-207. analytics() scoped its TASK-derived figures (throughput, recheck
  // outcomes) and left its EVENT-derived ones (cost, same-mistake rate)
  // reading every project. One result object, half of it answering the
  // question that was asked.
  // -------------------------------------------------------------------------

  it('scopes cost per model_tier/provider to the project (D-207)', () => {
    expect(analytics(db, { project: 'black-smith' }).costByModelTierAndProvider).toEqual([
      {
        modelTier: 'mid',
        provider: 'claude',
        taskCount: 1,
        totalTokens: 1000,
        avgTokensPerTask: 1000,
      },
    ]);
    expect(analytics(db, { project: 'demo-hub' }).costByModelTierAndProvider).toEqual([
      {
        modelTier: 'small',
        provider: 'codex',
        taskCount: 1,
        totalTokens: 2000,
        avgTokensPerTask: 2000,
      },
    ]);
  });

  it('scopes the same-mistake rate to the project (D-207)', () => {
    const a = analytics(db, { project: 'black-smith' }).sameMistakeRateByDay;
    expect(a.reduce((s, d) => s + d.decisions, 0)).toBe(2);
    expect(a.reduce((s, d) => s + d.sameMistake, 0)).toBe(1);

    const b = analytics(db, { project: 'demo-hub' }).sameMistakeRateByDay;
    expect(b.reduce((s, d) => s + d.decisions, 0)).toBe(1);
    expect(b.reduce((s, d) => s + d.sameMistake, 0)).toBe(0);
  });

  it('partitions the global figures: the projects sum to the whole (D-207)', () => {
    const global = analytics(db);
    const parts = [
      analytics(db, { project: 'black-smith' }),
      analytics(db, { project: 'demo-hub' }),
    ];

    const tokens = (r: typeof global) =>
      r.costByModelTierAndProvider.reduce((s, b) => s + b.totalTokens, 0);
    const decisions = (r: typeof global) =>
      r.sameMistakeRateByDay.reduce((s, d) => s + d.decisions, 0);

    expect(tokens(global)).toBe(3000);
    expect(parts.reduce((s, r) => s + tokens(r), 0)).toBe(tokens(global));
    expect(decisions(global)).toBe(3);
    expect(parts.reduce((s, r) => s + decisions(r), 0)).toBe(decisions(global));
  });

  it('places an event that spells its task id bare (D-130/D-207)', async () => {
    // The real logs carry both spellings for the same task, so the scope has
    // to ask taskId.ts whether two ids name the same task rather than compare
    // raw -- a `Set.has()` on the qualified ids drops the bare rows, and a
    // dropped row belongs to no project at all, which breaks the partition
    // above in the direction that looks like a smaller bill.
    let parent = (await readEvents(SESSION_ID, { stateDir })).at(-1)?.event_id ?? null;
    const added = await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'planner',
        event_type: 'task-added',
        task_id: 'epic-b/task-9',
        plan_version: 1,
        causal_parent: parent,
        project: 'demo-hub',
        payload: {
          epic_id: 'epic-b',
          case: 'feature',
          origin: 'user',
          task_status: 'completed',
          budget_tokens: 500,
        },
      },
      { stateDir },
    );
    parent = added.event_id;
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'coder',
        event_type: 'task-result-recorded',
        task_id: 'task-9', // bare, as every pre-D-46 producer wrote it
        plan_version: 1,
        causal_parent: parent,
        payload: {
          task_id: 'task-9',
          run_status: 'done',
          structured_output: {},
          artifacts: [],
          token_usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
          agent: 'coder',
          provider: 'codex',
          model_tier: 'small',
        },
      },
      { stateDir },
    );

    const barePath = path.join(dbDir, 'bare-spelling.db');
    await apply(barePath, SESSION_ID, { stateDir, roadmapPath });
    const bareHandle = openDb(barePath);
    try {
      const demoHub = analytics(bareHandle.db, { project: 'demo-hub' });
      const codex = demoHub.costByModelTierAndProvider.find((b) => b.provider === 'codex');
      expect(codex?.taskCount).toBe(2);
      expect(codex?.totalTokens).toBe(2100);
      expect(
        analytics(bareHandle.db, { project: 'black-smith' }).costByModelTierAndProvider.some(
          (b) => b.provider === 'codex',
        ),
      ).toBe(false);
    } finally {
      bareHandle.sqlite.close();
    }
  });

  // -------------------------------------------------------------------------
  // D-233. The fixture above stamps every one of project B's events, which is
  // not what a real log looks like: only the writers holding the plan stamp
  // anything (taskEvents.ts, D-232), so a task's own `task-added` carries the
  // project and the gate outcomes, results and errors that follow it carry
  // nothing. filterByProject() then normalizes those nulls to the DEFAULT
  // project and files a whole epic's history under black-smith -- the exact
  // move D-170 already ruled out for one query, stated here for the column.
  // -------------------------------------------------------------------------

  it('gives an unstamped event the project of the task it names', async () => {
    let parent = (await readEvents(SESSION_ID, { stateDir })).at(-1)?.event_id ?? null;
    const added = await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'planner',
        event_type: 'task-added',
        task_id: 'epic-b/task-2',
        plan_version: 1,
        causal_parent: parent,
        project: 'demo-hub',
        payload: {
          epic_id: 'epic-b',
          case: 'bugfix',
          origin: 'user',
          task_status: 'in-progress',
          budget_tokens: 300,
        },
      },
      { stateDir },
    );
    parent = added.event_id;
    // Everything after the add is written by a caller that never saw the plan.
    const dispatched = await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'planner',
        event_type: 'dispatch_decision',
        task_id: 'epic-b/task-2',
        plan_version: 1,
        causal_parent: parent,
        payload: {
          agent_role: 'tester',
          provider: 'codex',
          model_tier: 'small',
          model: 'codex:default',
          reason: 'c',
        },
      },
      { stateDir },
    );
    parent = dispatched.event_id;
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'tester',
        event_type: 'error-logged',
        task_id: 'epic-b/task-2',
        plan_version: 1,
        causal_parent: parent,
        payload: {
          error: 'execution.test-failure',
          severity: 'S2-major',
          task_ref: 'epic-b/task-2',
        },
      },
      { stateDir },
    );

    const derivedPath = path.join(dbDir, 'derived-child.db');
    await apply(derivedPath, SESSION_ID, { stateDir, roadmapPath });
    const handle = openDb(derivedPath);
    try {
      const events = handle.db
        .select()
        .from(schema.eventsRaw)
        .all()
        .filter((e) => e.taskId === 'epic-b/task-2');
      expect(events.map((e) => e.project)).toEqual(['demo-hub', 'demo-hub', 'demo-hub']);

      const dispatch = handle.db
        .select()
        .from(schema.dispatches)
        .all()
        .find((d) => d.taskId === 'epic-b/task-2');
      expect(dispatch?.project).toBe('demo-hub');

      const error = handle.db
        .select()
        .from(schema.errors)
        .all()
        .find((e) => e.taskRef === 'epic-b/task-2');
      expect(error?.project).toBe('demo-hub');

      // And the whole point: the errors page for the other project stops
      // counting a failure it never had. Both projects now carry an
      // execution.test-failure, so only the count tells them apart.
      const classCount = (project: string) =>
        errorsPage(handle.db, { project })
          .byClass.filter((c) => `${c.errorGroup}.${c.errorClass}` === 'execution.test-failure')
          .reduce((n, c) => n + c.count, 0);
      expect(classCount('black-smith')).toBe(1);
      expect(classCount('demo-hub')).toBe(1);
    } finally {
      handle.sqlite.close();
    }
  });

  // An epic-closed names an epic, not a task, and epic.ts writes it without a
  // plan in hand. Its tasks are the only thing that can place it.
  it('gives an unstamped epic-closed the project of the epic it closes', async () => {
    const parent = (await readEvents(SESSION_ID, { stateDir })).at(-1)?.event_id ?? null;
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'orchestrator',
        event_type: 'epic-closed',
        plan_version: 1,
        causal_parent: parent,
        payload: { epic_id: 'epic-b', closed_by: 'operator', machine_verdict: 'pass' },
      },
      { stateDir },
    );

    const closedPath = path.join(dbDir, 'derived-epic.db');
    await apply(closedPath, SESSION_ID, { stateDir, roadmapPath });
    const handle = openDb(closedPath);
    try {
      const epic = handle.db
        .select()
        .from(schema.epics)
        .all()
        .find((e) => e.epicId === 'epic-b');
      expect(epic?.project).toBe('demo-hub');
    } finally {
      handle.sqlite.close();
    }
  });

  // -------------------------------------------------------------------------
  // D-252. A ref that names an epic and no task -- `<epic>/integration`,
  // `<epic>/plan-v2`, `<epic>/epic`, or the bare epic id -- has no task row to
  // resolve through, so events_raw, dispatches and errors filed it as NULL.
  // NULL is not "unscoped": queries.ts's projectOf() reads a null back as the
  // DEFAULT project, so every one of those rows landed on black-smith's Errors
  // page and black-smith's Timeline -- another project's work, attributed. The
  // `epics` insert and projectFindings() already fall back to the epic map
  // built two lines above them in projectSession(); these three did not.
  // -------------------------------------------------------------------------

  /**
   * Appends one epic-level event and re-projects into a db of its own, so each
   * leg below reads a table nothing else has written to.
   */
  async function projectEpicRef(
    dbName: string,
    event: Omit<EventInput, 'session_id' | 'plan_version' | 'causal_parent'>,
  ): Promise<ReturnType<typeof openDb>> {
    const parent = (await readEvents(SESSION_ID, { stateDir })).at(-1)?.event_id ?? null;
    await appendEvent(
      { session_id: SESSION_ID, plan_version: 1, causal_parent: parent, ...event },
      { stateDir },
    );
    const derived = path.join(dbDir, `${dbName}.db`);
    await apply(derived, SESSION_ID, { stateDir, roadmapPath });
    return openDb(derived);
  }

  function projectOfEvent(
    handle: ReturnType<typeof openDb>,
    taskId: string,
  ): string | null | undefined {
    return handle.db
      .select()
      .from(schema.eventsRaw)
      .all()
      .find((e) => e.taskId === taskId)?.project;
  }

  it("gives an error raised on an epic's integration branch the epic's project", async () => {
    const handle = await projectEpicRef('derived-integration-error', {
      actor: 'orchestrator',
      event_type: 'error-logged',
      task_id: 'epic-b/integration',
      payload: {
        error: 'execution.test-failure',
        severity: 'S2-major',
        task_ref: 'epic-b/integration',
      },
    });
    try {
      const row = handle.db
        .select()
        .from(schema.errors)
        .all()
        .find((e) => e.taskRef === 'epic-b/integration');
      expect(row?.project).toBe('demo-hub');
      // Same event, the other table the same resolver feeds.
      expect(projectOfEvent(handle, 'epic-b/integration')).toBe('demo-hub');

      // And what the operator sees: the failure counts for the project that
      // had it, and stops counting for the project that did not.
      const failures = (project: string) =>
        errorsPage(handle.db, { project })
          .byClass.filter((c) => `${c.errorGroup}.${c.errorClass}` === 'execution.test-failure')
          .reduce((n, c) => n + c.count, 0);
      expect(failures('demo-hub')).toBe(1);
      expect(failures('black-smith')).toBe(1);
    } finally {
      handle.sqlite.close();
    }
  });

  // A planner dispatched against `<epic>/plan-v2` is the single commonest
  // taskless dispatch in a real run, and foldTasks() deliberately refuses to
  // mint a task row for a plan ref (D-250), so the task leg can never answer.
  it('gives a dispatch against a plan ref the project of the epic it plans', async () => {
    const handle = await projectEpicRef('derived-planref-dispatch', {
      actor: 'orchestrator',
      event_type: 'dispatch_decision',
      task_id: 'epic-b/plan-v1',
      payload: {
        agent_role: 'planner',
        provider: 'claude',
        model_tier: 'frontier',
        model: 'claude-opus-5',
        reason: 're-plan',
      },
    });
    try {
      const row = handle.db
        .select()
        .from(schema.dispatches)
        .all()
        .find((d) => d.taskId === 'epic-b/plan-v1');
      expect(row?.project).toBe('demo-hub');
      expect(projectOfEvent(handle, 'epic-b/plan-v1')).toBe('demo-hub');
    } finally {
      handle.sqlite.close();
    }
  });

  // The bare spelling: an id with no `/` at all, which epicOfTaskId() cannot
  // split. It is the epic id itself, so it keys the epic map directly.
  it("gives an event that names a bare epic id that epic's project", async () => {
    const handle = await projectEpicRef('derived-bare-epic', {
      actor: 'orchestrator',
      event_type: 'error-logged',
      task_id: 'epic-b',
      payload: { error: 'execution.test-failure', severity: 'S2-major', task_ref: 'epic-b' },
    });
    try {
      const row = handle.db
        .select()
        .from(schema.errors)
        .all()
        .find((e) => e.taskRef === 'epic-b');
      expect(row?.project).toBe('demo-hub');
      expect(projectOfEvent(handle, 'epic-b')).toBe('demo-hub');
    } finally {
      handle.sqlite.close();
    }
  });

  // The other side of the same fallback: an epic nothing in the log places
  // stays NULL, exactly as before. A guess would be worse than a default.
  it('leaves a ref unscoped when its epic has no scoped task either', async () => {
    const handle = await projectEpicRef('derived-unknown-epic', {
      actor: 'orchestrator',
      event_type: 'error-logged',
      task_id: 'epic-z/integration',
      payload: {
        error: 'execution.test-failure',
        severity: 'S2-major',
        task_ref: 'epic-z/integration',
      },
    });
    try {
      const row = handle.db
        .select()
        .from(schema.errors)
        .all()
        .find((e) => e.taskRef === 'epic-z/integration');
      expect(row?.project).toBeNull();
      expect(projectOfEvent(handle, 'epic-z/integration')).toBeNull();
    } finally {
      handle.sqlite.close();
    }
  });

  // Precedence, unchanged: what the event actually stamped outranks anything
  // derived. The fallback only ever fills a blank.
  it('keeps a stamped project on an epic ref ahead of the epic it names', async () => {
    const handle = await projectEpicRef('derived-stamped-epic-ref', {
      actor: 'orchestrator',
      event_type: 'error-logged',
      task_id: 'epic-b/integration',
      project: 'demo-hub-fork',
      payload: {
        error: 'execution.test-failure',
        severity: 'S2-major',
        task_ref: 'epic-b/integration',
      },
    });
    try {
      const row = handle.db
        .select()
        .from(schema.errors)
        .all()
        .find((e) => e.taskRef === 'epic-b/integration');
      expect(row?.project).toBe('demo-hub-fork');
      expect(projectOfEvent(handle, 'epic-b/integration')).toBe('demo-hub-fork');
    } finally {
      handle.sqlite.close();
    }
  });

  // -------------------------------------------------------------------------
  // D-234. Half the dispatches in a real run name an epic and no task -- a
  // planner, a spec-reviewer, a scribe, the epic-close judges. `agents` has no
  // project column, so this scope derived one through agents.taskId, and every
  // one of those rows was dropped the moment a project was selected: the
  // Overview showed no live agents for the project actually running.
  // -------------------------------------------------------------------------

  it("keeps an epic-level agent in its epic's project", async () => {
    const parent = (await readEvents(SESSION_ID, { stateDir })).at(-1)?.event_id ?? null;
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'orchestrator',
        event_type: 'dispatch_decision',
        plan_version: 1,
        causal_parent: parent,
        payload: {
          agent_role: 'planner',
          provider: 'claude',
          model_tier: 'frontier',
          model: 'claude-opus-5',
          epic_id: 'epic-b',
        },
      },
      { stateDir },
    );

    const agentsPath = path.join(dbDir, 'derived-agents.db');
    await apply(agentsPath, SESSION_ID, { stateDir, roadmapPath });
    const handle = openDb(agentsPath);
    try {
      const rolesFor = (project: string) =>
        overview(handle.db, { project }).liveAgentEntries.map((a) => a.agentRole);
      expect(rolesFor('demo-hub')).toContain('planner');
      expect(rolesFor('black-smith')).not.toContain('planner');
      // And unscoped it is still one agent, not two.
      expect(
        overview(handle.db, {}).liveAgentEntries.filter((a) => a.agentRole === 'planner'),
      ).toHaveLength(1);
    } finally {
      handle.sqlite.close();
    }
  });

  // A session-start, a user_prompt, a lesson: no task, no epic, nothing in the
  // envelope. The session itself is the last thing that can place them -- but
  // only when it is unambiguous. This fixture's session runs two projects at
  // once, so it stays null and reads back as the default, unchanged.
  it('leaves a taskless event alone when the session runs more than one project', () => {
    const start = db
      .select()
      .from(schema.eventsRaw)
      .all()
      .find((e) => e.eventType === 'session-start');
    expect(start?.project).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The project switcher (ui/src/App.vue's loadProjectOptions) is populated
  // from GET /api/projects, which returns exactly this list. Deriving it from
  // the `tasks` table alone meant a project could only be SELECTED once one
  // of its tasks existed -- while roadmap.md's `- project:` bullet declares a
  // project before any of its work is planned, and milestoneProgressRows()
  // already filters phases by that same bullet. So the operator could add a
  // phase for another project, see nothing but "All projects" in the
  // switcher, and have no way to reach the very rows the scope was built to
  // serve.
  // -------------------------------------------------------------------------

  it('lists a project a roadmap milestone declares before its first task exists', async () => {
    await writeFile(
      roadmapPath,
      `# Roadmap

## Phase 1 -- Smith's own work
- id: phase-smith
- status: in-progress
- epics: [epic-a, epic-b]
- goal: The projects the fixture already has tasks for.

## Phase 2 -- Acme web
- id: phase-acme
- status: planned
- project: acme-web
- epics: []
- goal: Declared on the roadmap; not one task planned against it yet.
`,
      'utf8',
    );

    const withRoadmapPath = path.join(dbDir, 'with-roadmap.db');
    await apply(withRoadmapPath, SESSION_ID, { stateDir, roadmapPath });
    const handle = openDb(withRoadmapPath);
    try {
      const listed = (overview(handle.db).projects ?? []).map((p) => p.project);
      expect(listed).toEqual(['acme-web', 'black-smith', 'demo-hub']);

      // A declared-but-unstarted project reports zeroes, not absence.
      const acme = overview(handle.db).projects?.find((p) => p.project === 'acme-web');
      expect(acme?.epicsInFlight).toEqual([]);
      expect(acme?.tokensSpent).toBe(0);

      // And selecting it reaches the phase that declared it.
      expect(roadmapPage(handle.db, { project: 'acme-web' }).map((m) => m.milestoneId)).toEqual([
        'phase-acme',
      ]);
    } finally {
      handle.sqlite.close();
    }
  });

  // -------------------------------------------------------------------------
  // D-246. D-232 stamps the project onto `task-added` at write time, which
  // repairs every run started after it and nothing that came before. A real
  // state dir is mostly "before": not one of dogfood-demo-rpg-1's thirteen
  // task-added events carries a project, so foldTasks leaves tasks.project
  // NULL, projectResolver hands that NULL down to every dispatch and error
  // under it, and db/queries.ts's projectOf() resolves the lot to the DEFAULT
  // project -- demo-rpg's board empty, demo-rpg's work filed under
  // black-smith. No rebuild can repair that from the log alone, because the
  // log never held the answer. The epic's plan file held it the whole time.
  // -------------------------------------------------------------------------

  /** A plan file on disk, the way `plan ingest` would have found it. */
  async function writePlan(specsDir: string, epicId: string, project?: string): Promise<void> {
    await mkdir(path.join(specsDir, epicId), { recursive: true });
    await writeFile(
      path.join(specsDir, epicId, 'plan-v1.json'),
      JSON.stringify({
        epic_id: epicId,
        version: 1,
        status: 'endorsed',
        tasks: [],
        edges: [],
        ...(project === undefined ? {} : { project }),
      }),
      'utf8',
    );
  }

  /**
   * A pre-D-232 task: no `project` on the add, nor on anything that follows
   * it. `stamped` writes the post-D-232 shape instead, for the override test.
   */
  async function appendUnstampedTask(
    epicId: string,
    stamped?: string,
    suffix = 'task-1',
  ): Promise<string> {
    const taskId = `${epicId}/${suffix}`;
    let parent = (await readEvents(SESSION_ID, { stateDir })).at(-1)?.event_id ?? null;
    const added = await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'planner',
        event_type: 'task-added',
        task_id: taskId,
        plan_version: 1,
        causal_parent: parent,
        ...(stamped === undefined ? {} : { project: stamped }),
        payload: {
          epic_id: epicId,
          case: 'feature',
          origin: 'user',
          task_status: 'in-progress',
          budget_tokens: 500,
        },
      },
      { stateDir },
    );
    parent = added.event_id;
    const dispatched = await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'orchestrator',
        event_type: 'dispatch_decision',
        task_id: taskId,
        plan_version: 1,
        causal_parent: parent,
        payload: {
          agent_role: 'coder',
          provider: 'codex',
          model_tier: 'small',
          model: 'codex:default',
          reason: 'plan-declared project',
        },
      },
      { stateDir },
    );
    parent = dispatched.event_id;
    // A finding on the same task: projectFindings() derives findings.project
    // from its own fold of the very same events, so the backfill has to reach
    // both folds or the two tables disagree about one task.
    const raised = await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'reviewer',
        event_type: 'finding-raised',
        task_id: taskId,
        plan_version: 1,
        causal_parent: parent,
        payload: {
          finding_id: `f-${epicId}-1`,
          task_id: taskId,
          epic_id: epicId,
          fingerprint: `${epicId}:correctness:1`,
          file_path: 'src/story.ts',
          finding_category: 'correctness',
          severity: 'S3-minor',
          finding_status: 'raised',
          summary: 'a finding on a task whose project was never stamped',
          failure_scenario: { inputs: 'n=5', expected: '5 items', actual: '4 items' },
          found_by: 'reviewer',
        },
      },
      { stateDir },
    );
    parent = raised.event_id;
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'orchestrator',
        event_type: 'epic-closed',
        plan_version: 1,
        causal_parent: parent,
        payload: { epic_id: epicId, closed_by: 'operator', machine_verdict: 'pass' },
      },
      { stateDir },
    );
    return taskId;
  }

  function cardsOn(handle: ReturnType<typeof openDb>, project: string): string[] {
    return kanban(handle.db, undefined, { project }).flatMap((c) => c.tasks.map((t) => t.taskId));
  }

  it("gives a task with no stamped project the one its epic's plan declares", async () => {
    const specsDir = await mkdtemp(path.join(tmpdir(), 'smith-project-specs-'));
    await writePlan(specsDir, 'epic-c', 'demo-rpg');
    const taskId = await appendUnstampedTask('epic-c');

    const derivedPath = path.join(dbDir, 'derived-plan.db');
    await apply(derivedPath, SESSION_ID, { stateDir, roadmapPath, specsDir });
    const handle = openDb(derivedPath);
    try {
      const task = handle.db
        .select()
        .from(schema.tasks)
        .all()
        .find((t) => t.taskId === taskId);
      expect(task?.project).toBe('demo-rpg');

      // One insertion point, because everything downstream reads the same
      // folded array: the epic row and the child rows come with it (D-233).
      const epic = handle.db
        .select()
        .from(schema.epics)
        .all()
        .find((e) => e.epicId === 'epic-c');
      expect(epic?.project).toBe('demo-rpg');

      const dispatch = handle.db
        .select()
        .from(schema.dispatches)
        .all()
        .find((d) => d.taskId === taskId);
      expect(dispatch?.project).toBe('demo-rpg');

      // projectFindings() folds the same events a second time, on its own, to
      // answer the same question -- so the backfill has to reach that fold
      // too, or one task reads as demo-rpg's on the board and black-smith's
      // on the errors page.
      const finding = handle.db
        .select()
        .from(schema.findings)
        .all()
        .find((f) => f.taskId === taskId);
      expect(finding?.project).toBe('demo-rpg');

      // And the reported symptom: the board of the project the work was
      // actually part of draws the card, and the default project's stops.
      expect(cardsOn(handle, 'demo-rpg')).toContain(taskId);
      expect(cardsOn(handle, 'black-smith')).not.toContain(taskId);
    } finally {
      handle.sqlite.close();
      await rm(specsDir, { recursive: true, force: true });
    }
  });

  it('lets a stamped project stand over the one its plan file declares', async () => {
    const specsDir = await mkdtemp(path.join(tmpdir(), 'smith-project-specs-'));
    // Disagreement on purpose: the plan is the fallback, never the override.
    // taskEvents.ts's planScoped() reads the same way on the write side, and
    // an epic re-homed after its plan was written must not be dragged back.
    await writePlan(specsDir, 'epic-d', 'demo-rpg');
    const taskId = await appendUnstampedTask('epic-d', 'demo-hub');

    const derivedPath = path.join(dbDir, 'derived-stamped.db');
    await apply(derivedPath, SESSION_ID, { stateDir, roadmapPath, specsDir });
    const handle = openDb(derivedPath);
    try {
      const task = handle.db
        .select()
        .from(schema.tasks)
        .all()
        .find((t) => t.taskId === taskId);
      expect(task?.project).toBe('demo-hub');
      expect(cardsOn(handle, 'demo-rpg')).not.toContain(taskId);
    } finally {
      handle.sqlite.close();
      await rm(specsDir, { recursive: true, force: true });
    }
  });

  it('leaves a task alone when no plan file answers for its epic', async () => {
    const specsDir = await mkdtemp(path.join(tmpdir(), 'smith-project-specs-'));
    // Three ways the file cannot answer, all of which must cost nothing: an
    // epic with no plan directory at all, and one whose plan declares no
    // project. A missing answer leaves the row NULL, which projectOf() reads
    // as the default -- the behaviour before this fix, deliberately kept.
    await writePlan(specsDir, 'epic-f');
    const noPlan = await appendUnstampedTask('epic-e');
    const noProject = await appendUnstampedTask('epic-f');

    const derivedPath = path.join(dbDir, 'derived-noplan.db');
    await apply(derivedPath, SESSION_ID, { stateDir, roadmapPath, specsDir });
    const handle = openDb(derivedPath);
    try {
      const projectOf = (taskId: string) =>
        handle.db
          .select()
          .from(schema.tasks)
          .all()
          .find((t) => t.taskId === taskId)?.project;
      expect(projectOf(noPlan)).toBeNull();
      expect(projectOf(noProject)).toBeNull();
      expect(cardsOn(handle, 'black-smith')).toEqual(expect.arrayContaining([noPlan, noProject]));
    } finally {
      handle.sqlite.close();
      await rm(specsDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // D-247. projectFindings() resolves findings.project through a plain
  // exact-key Map of task ids, where every other row in the projection goes
  // through projectResolver() -- so the two rules that D-233's docblock says
  // are the same rule are not. Two spellings the log actually uses fall
  // through the gap: a bare `task-1` for a task the log also spells
  // `epic/task-1`, and `epic/integration`, the pseudo-task the merge queue
  // raises integration findings against, which has no task row at all. On the
  // shipped logs that is 41 of 56 findings with no project -- two thirds of
  // every finding invisible to a project-scoped errors page.
  // -------------------------------------------------------------------------

  /**
   * A finding raised against `spelledAs`, which need not be a task that exists.
   * `epicId` null omits the field entirely -- the shape all four of the real
   * bare-spelling findings have, and the reason a task-level lookup is the
   * only thing that can ever answer for them.
   */
  async function raiseFindingOn(
    epicId: string | null,
    spelledAs: string,
    id: string,
  ): Promise<void> {
    const parent = (await readEvents(SESSION_ID, { stateDir })).at(-1)?.event_id ?? null;
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'reviewer',
        event_type: 'finding-raised',
        task_id: spelledAs,
        plan_version: 1,
        causal_parent: parent,
        payload: {
          finding_id: id,
          task_id: spelledAs,
          ...(epicId === null ? {} : { epic_id: epicId }),
          fingerprint: `${id}:correctness:1`,
          file_path: 'src/story.ts',
          finding_category: 'correctness',
          severity: 'S3-minor',
          finding_status: 'raised',
          summary: 'a finding whose task id is spelled the other way',
          failure_scenario: { inputs: 'n=5', expected: '5 items', actual: '4 items' },
          found_by: 'reviewer',
        },
      },
      { stateDir },
    );
  }

  function findingProject(
    handle: ReturnType<typeof openDb>,
    id: string,
  ): string | null | undefined {
    return handle.db
      .select()
      .from(schema.findings)
      .all()
      .find((f) => f.findingId === id)?.project;
  }

  it('scopes a finding whose task id is spelled bare the way every other row is', async () => {
    const specsDir = await mkdtemp(path.join(tmpdir(), 'smith-project-specs-'));
    await writePlan(specsDir, 'epic-g', 'proj-bare');
    // appendUnstampedTask writes the qualified spelling; the reviewer used the
    // bare one, which taskIdsMatch has treated as the same task since D-130.
    // A suffix of its own, because a bare `task-1` would match every other
    // epic's task-1 in this shared log and the test would prove nothing.
    await appendUnstampedTask('epic-g', undefined, 'task-bare');
    // No epic on the finding, exactly like the real four: that leaves the
    // epic map and the plan file with nothing to key off, so the task-level
    // lookup is the only leg of the chain that can answer.
    await raiseFindingOn(null, 'task-bare', 'f-bare-spelling');

    const derivedPath = path.join(dbDir, 'derived-bare.db');
    await apply(derivedPath, SESSION_ID, { stateDir, roadmapPath, specsDir });
    const handle = openDb(derivedPath);
    try {
      expect(findingProject(handle, 'f-bare-spelling')).toBe('proj-bare');
    } finally {
      handle.sqlite.close();
      await rm(specsDir, { recursive: true, force: true });
    }
  });

  it('gives an integration finding the project of the epic it was raised against', async () => {
    // No plan for epic-h, and its task carries the project on the wire: the
    // epic map is the only leg left that can answer.
    const specsDir = await mkdtemp(path.join(tmpdir(), 'smith-project-specs-'));
    await appendUnstampedTask('epic-h', 'proj-epic');
    // The merge queue raises against `<epic>/integration`, which is not a task
    // and never gets a row -- so no task lookup can ever answer for it. Its
    // epic can, and the row already stores the epic for exactly this reason.
    await raiseFindingOn('epic-h', 'epic-h/integration', 'f-integration');

    const derivedPath = path.join(dbDir, 'derived-integration.db');
    await apply(derivedPath, SESSION_ID, { stateDir, roadmapPath, specsDir });
    const handle = openDb(derivedPath);
    try {
      expect(findingProject(handle, 'f-integration')).toBe('proj-epic');
    } finally {
      handle.sqlite.close();
      await rm(specsDir, { recursive: true, force: true });
    }
  });

  it('falls back to the plan file for an epic whose tasks never reached the log', async () => {
    // An integration finding raised before any task-added -- no task row
    // anywhere in the log to key an epic map off, so only the plan file is
    // left to say where the epic belongs.
    const specsDir = await mkdtemp(path.join(tmpdir(), 'smith-project-specs-'));
    await writePlan(specsDir, 'epic-i', 'proj-plan');
    await raiseFindingOn('epic-i', 'epic-i/integration', 'f-plan-only');

    const derivedPath = path.join(dbDir, 'derived-plan-only.db');
    await apply(derivedPath, SESSION_ID, { stateDir, roadmapPath, specsDir });
    const handle = openDb(derivedPath);
    try {
      expect(findingProject(handle, 'f-plan-only')).toBe('proj-plan');
    } finally {
      handle.sqlite.close();
      await rm(specsDir, { recursive: true, force: true });
    }
  });

  it('leaves a finding unscoped when neither its task nor its epic answers', async () => {
    const specsDir = await mkdtemp(path.join(tmpdir(), 'smith-project-specs-'));
    // No plan for epic-j, and no task under it either: nothing in the log or
    // on disk says where it belongs, so the row stays NULL and projectOf()
    // reads it as the default -- the behaviour before this fix, kept.
    await raiseFindingOn('epic-j', 'epic-j/integration', 'f-unknowable');

    const derivedPath = path.join(dbDir, 'derived-unknowable.db');
    await apply(derivedPath, SESSION_ID, { stateDir, roadmapPath, specsDir });
    const handle = openDb(derivedPath);
    try {
      expect(findingProject(handle, 'f-unknowable')).toBeNull();
    } finally {
      handle.sqlite.close();
      await rm(specsDir, { recursive: true, force: true });
    }
  });
});
