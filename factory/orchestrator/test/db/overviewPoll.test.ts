// overview() poll cost: the dashboard asks the same question every few seconds,
// so what a poll does on a held projection must not grow with the history in
// the log, and the two-stage answer must equal the one-shot answer at every
// step. Proved by counts (payload parses, rows read) and by deep equality
// against a cold handle, never by timing.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DbHandle, openDb, projectSession, projectTasks } from '../../src/db/projector.js';
import { overview, overviewAt, overviewProjection, type Scope } from '../../src/db/queries.js';
import type { StoredEvent } from '../../src/events.js';

const NOW_MS = Date.parse('2026-08-04T12:00:00.000Z');
const MIN = 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
const MARK = 'poll-marker';

type Rec = Partial<StoredEvent['record']> & { event_type: string };

/** Append-only event list for one session; ids are `<session>#<n>`. */
class Log {
  readonly events: StoredEvent[] = [];
  constructor(readonly session: string) {}
  push(record: Rec): void {
    const n = this.events.length + 1;
    this.events.push({
      event_id: `${this.session}#${n}`,
      record: {
        session_id: this.session,
        actor: 'system',
        plan_version: 1,
        causal_parent: n === 1 ? null : `${this.session}#${n - 1}`,
        payload: {},
        ts: iso(NOW_MS - 10 * 24 * 60 * MIN + n),
        ...record,
      },
    });
  }
}

function plan(log: Log): void {
  log.push({ event_type: 'session-start', ts: iso(NOW_MS - 11 * 24 * 60 * MIN) });
  for (const [epic, project] of [
    ['epic-a', 'project-a'],
    ['epic-b', 'project-b'],
  ] as const) {
    for (let k = 1; k <= 3; k += 1) {
      log.push({
        event_type: 'task-added',
        task_id: `${epic}/task-${k}`,
        project,
        payload: {
          epic_id: epic,
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          budget_tokens: 1000,
        },
      });
    }
  }
}

function dispatch(log: Log, task: string, project: string, ts: string): void {
  log.push({
    event_type: 'dispatch_decision',
    task_id: task,
    project,
    ts,
    payload: { agent_role: 'coder', provider: 'claude', model_tier: 'mid', model: 'm' },
  });
}

function result(log: Log, task: string, project: string, ts: string, total = 100): void {
  log.push({
    event_type: 'task-result-recorded',
    task_id: task,
    project,
    ts,
    payload: { task_id: task, note: MARK, token_usage: { total_tokens: total } },
  });
}

describe('overviewAt parity with overview()', () => {
  let dir: string;
  let dbPath: string;
  let handle: DbHandle;
  let a: Log;
  let b: Log;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smith-overview-poll-'));
    dbPath = path.join(dir, 'smith.db');
    handle = openDb(dbPath);
    a = new Log('sess-poll-a');
    b = new Log('sess-poll-b');
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  });

  function store(): void {
    projectSession(handle, a.session, a.events);
    projectSession(handle, b.session, b.events);
    projectTasks(handle, [...a.events, ...b.events]);
  }

  function cold(scope: Scope, nowIso: string) {
    const fresh = openDb(dbPath);
    try {
      return overview(fresh.db, scope, { nowIso });
    } finally {
      fresh.sqlite.close();
    }
  }

  it('matches a cold overview() at every step, late events and boundary rows included', () => {
    plan(a);
    plan(b);
    dispatch(a, 'epic-a/task-1', 'project-a', iso(NOW_MS - 3 * 60 * MIN));
    dispatch(b, 'epic-b/task-1', 'project-b', iso(NOW_MS - 20 * MIN));
    result(a, 'epic-a/task-2', 'project-a', iso(NOW_MS - 90 * MIN), 250);
    store();

    const scopes: Scope[] = [
      {},
      { project: 'project-a' },
      { sessionId: a.session },
      { sessionIds: [a.session, b.session] },
    ];
    const projections = new Map<Scope, ReturnType<typeof overviewProjection>>();
    const step = (clockMs: number, mutated: boolean): void => {
      for (const scope of scopes) {
        if (mutated || !projections.has(scope)) {
          projections.set(scope, overviewProjection(handle.db, scope));
        }
        const nowIso = iso(clockMs);
        const warm = overviewAt(handle.db, projections.get(scope) as never, scope, { nowIso });
        expect(warm, `${JSON.stringify(scope)} @ ${nowIso}`).toEqual(cold(scope, nowIso));
      }
    };

    step(NOW_MS, true);
    step(NOW_MS + 5_000, false);
    step(NOW_MS + 2 * MIN, false);

    // A same-millisecond burst of dispatches and results.
    const burst = iso(NOW_MS + 2 * MIN + 1_000);
    for (let k = 1; k <= 3; k += 1) {
      dispatch(a, `epic-a/task-${k}`, 'project-a', burst);
      result(b, `epic-b/task-${k}`, 'project-b', burst, 40 + k);
    }
    store();
    step(NOW_MS + 3 * MIN, true);

    // Rows exactly at the two cutoffs of the next clock.
    const clock = NOW_MS + 10 * MIN;
    dispatch(a, 'epic-a/task-3', 'project-a', iso(clock - 5 * MIN));
    result(a, 'epic-a/task-3', 'project-a', iso(clock - 60 * MIN), 77);
    a.push({
      event_type: 'task-added',
      task_id: 'epic-a/task-3',
      project: 'project-a',
      ts: iso(clock - 60 * MIN),
      payload: { epic_id: 'epic-a', budget_tokens: 4000 },
    });
    store();
    step(clock, true);
    step(clock + 5_000, false);

    // A late event: older than the checkpoint the polls above left behind.
    dispatch(b, 'epic-b/task-9', 'project-b', iso(clock - 40 * MIN));
    store();
    step(clock + 10_000, true);
    step(clock + 15_000, false);

    // The clock moving backwards falls back to a full read and still agrees.
    step(NOW_MS + MIN, false);
  });
});

describe('overviewAt cost on a held projection', () => {
  let dir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smith-overview-poll-cost-'));
    handle = openDb(path.join(dir, 'smith.db'));
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** `noise` old events (closed dispatches, results, re-planned budgets) plus a fixed recent tail. */
  function load(noise: number, extra: (log: Log) => void = () => {}): Log {
    const log = new Log('sess-poll-cost');
    plan(log);
    const old = NOW_MS - 9 * 24 * 60 * MIN;
    for (let i = 0; i < noise / 4; i += 1) {
      const task = `epic-${i % 2 ? 'a' : 'b'}/task-${(i % 3) + 1}`;
      const project = i % 2 ? 'project-a' : 'project-b';
      dispatch(log, task, project, iso(old + i * 10));
      result(log, task, project, iso(old + i * 10 + 1), 10 + (i % 5));
      log.push({
        event_type: 'task-added',
        task_id: task,
        project,
        ts: iso(old + i * 10 + 2),
        payload: { epic_id: task.split('/')[0], budget_tokens: 1000 + (i % 7), note: MARK },
      });
      log.push({
        event_type: 'operator-note',
        ts: iso(old + i * 10 + 3),
        payload: { note: MARK },
      });
    }
    dispatch(log, 'epic-a/task-1', 'project-a', iso(NOW_MS - 10 * MIN));
    dispatch(log, 'epic-b/task-1', 'project-b', iso(NOW_MS - 9 * MIN));
    dispatch(log, 'epic-a/task-2', 'project-a', iso(NOW_MS - 5 * MIN + 2_000));
    result(log, 'epic-a/task-3', 'project-a', iso(NOW_MS - 30 * MIN), 90);
    log.push({
      event_type: 'task-added',
      task_id: 'epic-b/task-3',
      project: 'project-b',
      ts: iso(NOW_MS - 25 * MIN),
      payload: { epic_id: 'epic-b', budget_tokens: 3000, note: MARK },
    });
    extra(log);
    projectSession(handle, log.session, log.events);
    projectTasks(handle, log.events);
    return log;
  }

  /** Marker-bearing parses, events_raw rows and dispatches rows one call reads. */
  function measure(fn: () => void): { parses: number; eventRows: number; dispatchRows: number } {
    let eventRows = 0;
    let dispatchRows = 0;
    const realPrepare = handle.sqlite.prepare.bind(handle.sqlite);
    const prepare = vi.spyOn(handle.sqlite, 'prepare').mockImplementation(((source: string) => {
      const stmt = realPrepare(source);
      const isEvents = source.includes('"events_raw"');
      const isDispatches = source.includes('"dispatches"');
      if (!isEvents && !isDispatches) return stmt;
      const all = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        const rows = all(...args) as unknown[];
        if (isEvents) eventRows += rows.length;
        if (isDispatches) dispatchRows += rows.length;
        return rows;
      }) as typeof stmt.all;
      return stmt;
    }) as typeof handle.sqlite.prepare);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      fn();
      const parses = parse.mock.calls.filter(
        ([s]) => typeof s === 'string' && (s.includes(MARK) || s.includes('"token_usage"')),
      ).length;
      return { parses, eventRows, dispatchRows };
    } finally {
      parse.mockRestore();
      prepare.mockRestore();
    }
  }

  it('does equal work at N and 10N events on a held projection, every scope', {
    timeout: 240_000,
  }, () => {
    const scopes: Scope[] = [
      {},
      { project: 'project-a' },
      { sessionId: 'sess-poll-cost' },
      { sessionIds: ['sess-poll-cost'] },
    ];
    const counts = [2000, 20000].map((n) => {
      handle.sqlite.close();
      handle = openDb(path.join(dir, `smith-${n}.db`));
      load(n);
      return scopes.map((scope) => {
        const projection = overviewProjection(handle.db, scope);
        overviewAt(handle.db, projection, scope, { nowIso: iso(NOW_MS) });
        return measure(() =>
          overviewAt(handle.db, projection, scope, { nowIso: iso(NOW_MS + 5_000) }),
        );
      });
    });
    expect(counts[1]).toEqual(counts[0]);
    // The recent tail is a handful of rows; a whole-history read would be thousands.
    for (const c of counts[1] ?? []) {
      expect(c.eventRows).toBeLessThan(100);
      expect(c.dispatchRows).toBeLessThan(100);
      expect(c.parses).toBeLessThan(100);
    }
  });

  it('parses only the new event when the projection advances, every scope', {
    timeout: 240_000,
  }, () => {
    const scopes: Scope[] = [{}, { project: 'project-b' }, { sessionId: 'sess-poll-cost' }];
    const parsesAfterAppend = [2000, 20000].map((n) => {
      handle.sqlite.close();
      handle = openDb(path.join(dir, `smith-adv-${n}.db`));
      const log = load(n);
      const held = scopes.map((scope) => overviewProjection(handle.db, scope));
      expect(held).toHaveLength(scopes.length);
      result(log, 'epic-b/task-2', 'project-b', iso(NOW_MS - 2 * MIN), 5);
      projectSession(handle, log.session, log.events);
      return scopes.map((scope) => measure(() => overviewProjection(handle.db, scope)).parses);
    });
    for (const p of parsesAfterAppend[0] ?? []) expect(p).toBeLessThanOrEqual(1);
    expect(parsesAfterAppend[1]).toEqual(parsesAfterAppend[0]);
  });
});
