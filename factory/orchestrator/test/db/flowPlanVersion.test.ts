// D-165 / D-167: flowGraph()'s "active plan" filter. The Flow page is the
// only view of the task DAG, so anything this filter drops is invisible to
// the operator — there is no second surface to notice it on. Three mutations
// must fail here: picking the plan version as one global max across every
// epic, dropping tasks whose plan_version was never recorded, and reading a
// task's stamp as the one version it belongs to rather than the version it
// entered at.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, openDb } from '../../src/db/projector.js';
import { flowGraph } from '../../src/db/queries.js';
import { appendEvent, type EventOpts } from '../../src/events.js';

const SESSION_ID = 'sess-flow-plan-version';

// epic-a was planned once and never re-planned. epic-b is the shape every
// amendment in the factory's own log has: v2 added one task and carried the
// rest forward unchanged, and only the added task got a `task-added`, so the
// carried ones still read v1. Their stamp is the version they entered at, not
// a claim that v2 dropped them — plan-v2.json on disk lists all three (D-167).
// task-a3 is the other shape the store is full of: a task whose `task-added`
// carried no plan_version at all, so the projection has null.
const TASKS: Array<{ taskId: string; epicId: string; planVersion: number | null }> = [
  { taskId: 'epic-a/task-a1', epicId: 'epic-a', planVersion: 1 },
  { taskId: 'epic-a/task-a2', epicId: 'epic-a', planVersion: 1 },
  { taskId: 'epic-a/task-a3', epicId: 'epic-a', planVersion: null },
  { taskId: 'epic-b/task-b1', epicId: 'epic-b', planVersion: 1 },
  { taskId: 'epic-b/task-b2', epicId: 'epic-b', planVersion: 1 },
  { taskId: 'epic-b/task-b3', epicId: 'epic-b', planVersion: 2 },
];

async function buildFlowFixture(opts: EventOpts): Promise<void> {
  const root = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'operator',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    },
    opts,
  );
  let parent = root.event_id;

  for (const task of TASKS) {
    const added = await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'operator',
        event_type: 'task-added',
        task_id: task.taskId,
        plan_version: task.planVersion ?? 1,
        causal_parent: parent,
        payload: {
          epic_id: task.epicId,
          task_status: 'ready',
          objective: `objective for ${task.taskId}`,
          // The projection reads plan_version off the payload, not the
          // envelope — omitting it here is exactly how a null row is born.
          ...(task.planVersion === null ? {} : { plan_version: task.planVersion }),
        },
      },
      opts,
    );
    parent = added.event_id;
  }
}

function idsOf(graph: ReturnType<typeof flowGraph>): string[] {
  return graph.nodes.map((n) => n.taskId).sort();
}

describe('flowGraph() plan-version filter (D-165, D-167)', () => {
  let stateDir: string;
  let dbDir: string;
  let db: ReturnType<typeof openDb>['db'];
  let sqlite: ReturnType<typeof openDb>['sqlite'];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-flow-plan-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-flow-plan-db-'));
    const dbPath = path.join(dbDir, 'smith.db');
    await buildFlowFixture({ stateDir });
    await apply(dbPath, SESSION_ID, { stateDir });
    const handle = openDb(dbPath);
    db = handle.db;
    sqlite = handle.sqlite;
  });

  afterEach(async () => {
    sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it("takes each epic's own latest plan, so a re-planned epic cannot hide another epic", () => {
    // epic-b's v2 must not evict epic-a's v1 tasks from the unscoped view.
    expect(idsOf(flowGraph(db, { sessionId: SESSION_ID }))).toEqual([
      'epic-a/task-a1',
      'epic-a/task-a2',
      'epic-a/task-a3',
      'epic-b/task-b1',
      'epic-b/task-b2',
      'epic-b/task-b3',
    ]);
  });

  it('keeps the tasks the re-plan carried into the latest version (D-167)', () => {
    // The whole of epic-b's v2, not only the task v2 introduced. Asserting
    // ['epic-b/task-b3'] here is what let the real defect through: it reads
    // "stamped v1" as "v2 dropped it", and the amendment that cut v2 says the
    // opposite in its own `diff.carried`.
    expect(idsOf(flowGraph(db, { sessionId: SESSION_ID, epicId: 'epic-b' }))).toEqual([
      'epic-b/task-b1',
      'epic-b/task-b2',
      'epic-b/task-b3',
    ]);
  });

  it('shows the epic as it stood at an earlier version (D-167)', () => {
    // v1 is the two-task plan b3 was added to, so picking it must not show
    // b3 — and must still show both tasks that were there.
    expect(
      idsOf(flowGraph(db, { sessionId: SESSION_ID, epicId: 'epic-b', planVersion: 1 })),
    ).toEqual(['epic-b/task-b1', 'epic-b/task-b2']);
  });

  it('keeps a task whose plan version was never recorded', () => {
    expect(idsOf(flowGraph(db, { sessionId: SESSION_ID, epicId: 'epic-a' }))).toEqual([
      'epic-a/task-a1',
      'epic-a/task-a2',
      'epic-a/task-a3',
    ]);
  });

  it('honours an explicit plan version across every epic', () => {
    expect(idsOf(flowGraph(db, { sessionId: SESSION_ID, planVersion: 1 }))).toEqual([
      'epic-a/task-a1',
      'epic-a/task-a2',
      'epic-b/task-b1',
      'epic-b/task-b2',
    ]);
  });

  it('reports the versions the operator could switch to, not just the shown one', () => {
    // Sourced from the scoped tasks BEFORE the version filter — a dropdown
    // built from the filtered nodes can only ever offer what is already on
    // screen, which is no choice at all.
    expect(flowGraph(db, { sessionId: SESSION_ID }).planVersions).toEqual([2, 1]);
    expect(flowGraph(db, { sessionId: SESSION_ID, epicId: 'epic-b' }).planVersions).toEqual([2, 1]);
    expect(flowGraph(db, { sessionId: SESSION_ID, epicId: 'epic-a' }).planVersions).toEqual([1]);
    expect(
      flowGraph(db, { sessionId: SESSION_ID, epicId: 'epic-b', planVersion: 1 }).planVersions,
    ).toEqual([2, 1]);
  });
});
