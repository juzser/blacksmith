import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import { flowGraph, kanban, projectedLineage, timeline } from '../../src/db/queries.js';
import { appendEvent, type EventOpts, startSession } from '../../src/events.js';

/**
 * D-263. An epic split across sessions -- the shape SKILL.md now recommends
 * for an epic that outlasts one window -- projects into one `epic-9` whose
 * two tasks carry two different `session_id`s. Every session-scoped read in
 * queries.ts narrowed with `=`, so asking the continuation session about its
 * own epic answered with half of it and said nothing about the half it
 * dropped.
 */
const S1 = 'lin-s1';
const S2 = 'lin-s2';
const S3 = 'lin-s3';
const EPIC = 'epic-9';

async function addTask(session: string, taskId: string, opts: EventOpts): Promise<void> {
  await appendEvent(
    {
      session_id: session,
      actor: 'planner',
      event_type: 'task-added',
      task_id: taskId,
      plan_version: 1,
      causal_parent: `${session}#0`,
      payload: {
        epic_id: EPIC,
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
        plan_version: 1,
        objective: `Do ${taskId}.`,
        claims: [`src/${taskId.replace('/', '-')}.ts`],
        budget_tokens: 1000,
      },
    },
    opts,
  );
}

describe('db/queries.ts lineage scope (D-263)', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-lineage-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-lineage-db-'));
    const opts: EventOpts = { stateDir };

    // Three sessions, one epic: s1 opens it, s2 continues s1, s3 continues s2.
    // Each carries one task, so a read that stops at a session boundary is
    // visible as a count and not only as a missing field.
    await startSession(S1, opts);
    await addTask(S1, `${EPIC}/task-1`, opts);
    await startSession(S2, { ...opts, continues: `${S1}#0` });
    await addTask(S2, `${EPIC}/task-2`, opts);
    await startSession(S3, { ...opts, continues: `${S2}#0` });
    await addTask(S3, `${EPIC}/task-3`, opts);

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  describe('projectedLineage()', () => {
    it('walks the cross-session edge root-first, off the projection alone', () => {
      expect(projectedLineage(handle.db, S3)).toEqual([S1, S2, S3]);
    });

    // Changed by D-266, and this is the point of it. Read from S2 the chain
    // used to stop at S2 -- the newest end was the only end that saw the whole
    // epic, and the operator has no way to know which end they are standing on
    // until they have already read the wrong scope. An epic is the same epic
    // read from either end of its chain.
    it('reaches the continuation as well as the ancestry, read from the middle', () => {
      expect(projectedLineage(handle.db, S2)).toEqual([S1, S2, S3]);
    });

    it('answers with the whole chain when read from the session that opened it', () => {
      expect(projectedLineage(handle.db, S1)).toEqual([S1, S2, S3]);
    });

    it('answers with the session itself when the projection has never seen it', () => {
      // Not an error: `--lineage` on a session with no projected root is a
      // scope of one, which is exactly what `--session` alone would have
      // given. Refusing here would make the flag less useful than its absence.
      expect(projectedLineage(handle.db, 'never-projected')).toEqual(['never-projected']);
    });
  });

  describe('scope.sessionIds', () => {
    it('reads the whole epic where scope.sessionId reads one session of it', () => {
      const narrow = kanban(handle.db, EPIC, { sessionId: S3 });
      const wide = kanban(handle.db, EPIC, { sessionIds: projectedLineage(handle.db, S3) });
      expect(narrow.flatMap((c) => c.tasks).map((t) => t.taskId)).toEqual([`${EPIC}/task-3`]);
      expect(
        wide
          .flatMap((c) => c.tasks)
          .map((t) => t.taskId)
          .sort(),
      ).toEqual([`${EPIC}/task-1`, `${EPIC}/task-2`, `${EPIC}/task-3`]);
    });

    it('widens the flow graph and the timeline the same way', () => {
      expect(flowGraph(handle.db, { epicId: EPIC, sessionId: S3 }).nodes).toHaveLength(1);
      expect(flowGraph(handle.db, { epicId: EPIC, sessionIds: [S1, S2, S3] }).nodes).toHaveLength(
        3,
      );

      // A TimelineEntry carries no session id -- the scope decides which rows
      // it is built from -- so the widening is visible in which tasks appear.
      const tasksOf = (entries: { taskId: string | null }[]): string[] =>
        entries
          .map((e) => e.taskId)
          .filter((id): id is string => id !== null)
          .sort();
      expect(tasksOf(timeline(handle.db, { sessionId: S3 }))).toEqual([`${EPIC}/task-3`]);
      expect(tasksOf(timeline(handle.db, { sessionIds: [S1, S2, S3] }))).toEqual([
        `${EPIC}/task-1`,
        `${EPIC}/task-2`,
        `${EPIC}/task-3`,
      ]);
    });

    it('refuses an empty lineage rather than answering with everything', () => {
      // `inArray(col, [])` is a where-clause that matches nothing on one
      // driver and everything on another. Neither is an answer to "scope this
      // to no sessions", and the resolver cannot produce one, so an empty
      // array is a caller bug and says so.
      expect(() => kanban(handle.db, EPIC, { sessionIds: [] })).toThrow(RangeError);
    });
  });
});

/**
 * D-266. D-264 put the dashboard and the CLI on the same scope by giving the
 * projection its own copy of the lineage walk. That copy has to keep matching
 * `sessionLineage()`, so when the raw-log walk learned to go down as well as
 * up, this one had to as well -- otherwise `smith epic close` holds on a
 * finding the dashboard drawing the same epic cannot see.
 */
describe('db/queries.ts lineage scope over a fan-out (D-266)', () => {
  const E = 'fan-epic';
  const W1 = 'fan-wave-1';
  const W2 = 'fan-wave-2';
  const FAN_EPIC = 'epic-fan';

  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  async function addFanTask(session: string, taskId: string, opts: EventOpts): Promise<void> {
    await appendEvent(
      {
        session_id: session,
        actor: 'planner',
        event_type: 'task-added',
        task_id: taskId,
        plan_version: 1,
        causal_parent: `${session}#0`,
        payload: {
          epic_id: FAN_EPIC,
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          plan_version: 1,
          objective: `Do ${taskId}.`,
          claims: [`src/${taskId.replace('/', '-')}.ts`],
          budget_tokens: 1000,
        },
      },
      opts,
    );
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-fan-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-fan-db-'));
    const opts: EventOpts = { stateDir };

    // One epic session dispatching two waves -- the tier split, not a chain.
    await startSession(E, opts);
    await addFanTask(E, `${FAN_EPIC}/task-0`, opts);
    await startSession(W1, { ...opts, continues: `${E}#0` });
    await addFanTask(W1, `${FAN_EPIC}/task-1`, opts);
    await startSession(W2, { ...opts, continues: `${E}#0` });
    await addFanTask(W2, `${FAN_EPIC}/task-2`, opts);

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('names every wave that continues the epic, read from the epic', () => {
    expect(projectedLineage(handle.db, E)).toEqual([E, W1, W2]);
  });

  it('leaves a wave reading its own ancestry and not its siblings', () => {
    expect(projectedLineage(handle.db, W1)).toEqual([E, W1]);
    expect(projectedLineage(handle.db, W2)).toEqual([E, W2]);
  });

  it('scopes the board to the whole epic from the session that closes it', () => {
    const wide = kanban(handle.db, FAN_EPIC, { sessionIds: projectedLineage(handle.db, E) });
    expect(
      wide
        .flatMap((c) => c.tasks)
        .map((t) => t.taskId)
        .sort(),
    ).toEqual([`${FAN_EPIC}/task-0`, `${FAN_EPIC}/task-1`, `${FAN_EPIC}/task-2`]);
  });
});
