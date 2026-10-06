// An epic nothing has touched for more than 7 days leaves "Running now"
// (`epicsActivelyRunning`) but stays pickable (`epicsInFlight`) and is named,
// with its idle days, in `epicsIdle`. Hand-built StoredEvent arrays, so every
// `ts` and the clock are fixed.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DbHandle, openDb, projectSession, projectTasks } from '../../src/db/projector.js';
import { overview } from '../../src/db/queries.js';
import type { StoredEvent } from '../../src/events.js';

const SESSION_ID = 'sess-idle-fixture';
const NOW = '2026-08-20T12:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

function daysBefore(days: number, extraMs = 0): string {
  return new Date(Date.parse(NOW) - days * DAY_MS - extraMs).toISOString();
}

let eventCounter = 0;
function event(overrides: Partial<StoredEvent['record']> & { event_type: string }): StoredEvent {
  eventCounter += 1;
  return {
    event_id: `${SESSION_ID}#${eventCounter}`,
    record: {
      session_id: SESSION_ID,
      actor: 'system',
      plan_version: 1,
      causal_parent: eventCounter === 1 ? null : `${SESSION_ID}#${eventCounter - 1}`,
      payload: {},
      ts: NOW,
      ...overrides,
    },
  };
}

function taskAdded(epic: string, ts: string, budget?: number): StoredEvent {
  return event({
    event_type: 'task-added',
    task_id: `${epic}/task-1`,
    ts,
    payload: {
      epic_id: epic,
      case: 'feature',
      origin: 'user',
      task_status: 'todo',
      ...(budget === undefined ? {} : { budget_tokens: budget }),
    },
  });
}

describe('overview() idle epics', () => {
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    eventCounter = 0;
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-overview-idle-db-'));
    handle = openDb(path.join(dbDir, 'smith.db'));
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  function run(events: StoredEvent[]) {
    projectSession(handle, SESSION_ID, events);
    projectTasks(handle, events);
    return overview(handle.db, { sessionId: SESSION_ID }, { nowIso: NOW });
  }

  it('drops an epic idle for 8 days out of epicsActivelyRunning, keeps it in flight, and names it', () => {
    const result = run([
      event({ event_type: 'session-start', causal_parent: null, ts: daysBefore(8) }),
      taskAdded('epic-old', daysBefore(8)),
      taskAdded('epic-new', daysBefore(6)),
    ]);
    expect(result.epicsInFlight).toEqual(['epic-new', 'epic-old']);
    expect(result.epicsActivelyRunning).toEqual(['epic-new']);
    expect(result.epicsIdle).toEqual([{ epicId: 'epic-old', idleDays: 8 }]);
  });

  it('treats exactly 7 days as not idle', () => {
    const exact = run([
      event({ event_type: 'session-start', causal_parent: null, ts: daysBefore(7) }),
      taskAdded('epic-a', daysBefore(7)),
    ]);
    expect(exact.epicsActivelyRunning).toEqual(['epic-a']);
    expect(exact.epicsIdle).toEqual([]);
  });

  it('idles an epic one millisecond past 7 days, and rounds idle days down', () => {
    const result = run([
      event({ event_type: 'session-start', causal_parent: null, ts: daysBefore(7, 1) }),
      taskAdded('epic-a', daysBefore(7, 1)),
    ]);
    expect(result.epicsActivelyRunning).toEqual([]);
    expect(result.epicsIdle).toEqual([{ epicId: 'epic-a', idleDays: 7 }]);
  });

  it('counts a recent event on one of its tasks as activity, though no task row moved', () => {
    const result = run([
      event({ event_type: 'session-start', causal_parent: null, ts: daysBefore(30) }),
      taskAdded('epic-a', daysBefore(30)),
      event({
        event_type: 'judge-reported',
        task_id: 'epic-a/task-1',
        ts: daysBefore(1),
        payload: { role: 'reviewer', verdict: 'pass' },
      }),
    ]);
    expect(result.epicsActivelyRunning).toEqual(['epic-a']);
    expect(result.epicsIdle).toEqual([]);
  });

  it('counts an event with no task id that names the epic in its payload as activity', () => {
    const result = run([
      event({ event_type: 'session-start', causal_parent: null, ts: daysBefore(30) }),
      taskAdded('epic-a', daysBefore(30)),
      event({
        event_type: 'judge-reported',
        ts: daysBefore(1),
        payload: { epic_id: 'epic-a', role: 'spec-reviewer', verdict: 'pass' },
      }),
    ]);
    expect(result.epicsActivelyRunning).toEqual(['epic-a']);
    expect(result.epicsIdle).toEqual([]);
  });

  it('counts an event on a plan-ref task id (<epic>/plan-rN) as activity of that epic', () => {
    const result = run([
      event({ event_type: 'session-start', causal_parent: null, ts: daysBefore(30) }),
      taskAdded('epic-a', daysBefore(30)),
      event({
        event_type: 'dispatch_decision',
        task_id: 'epic-a/spec-review-r3',
        ts: daysBefore(1),
        payload: { role: 'spec-reviewer' },
      }),
    ]);
    expect(result.epicsActivelyRunning).toEqual(['epic-a']);
    expect(result.epicsIdle).toEqual([]);
  });

  it('compares timestamps as instants, so an offset ts that is really newer wins', () => {
    // 08:00-07:00 is 15:00Z: after the 7-day cutoff (12:00Z), though it sorts
    // below the task's 10:00Z updatedAt as a string.
    const result = run([
      event({ event_type: 'session-start', causal_parent: null, ts: daysBefore(30) }),
      taskAdded('epic-a', '2026-08-13T10:00:00.000Z'),
      event({
        event_type: 'judge-reported',
        task_id: 'epic-a/task-1',
        ts: '2026-08-13T08:00:00.000-07:00',
        payload: { role: 'reviewer', verdict: 'pass' },
      }),
    ]);
    expect(result.epicsActivelyRunning).toEqual(['epic-a']);
    expect(result.epicsIdle).toEqual([]);
  });

  it('gives a project summary the same rule', () => {
    const result = run([
      event({ event_type: 'session-start', causal_parent: null, ts: daysBefore(9) }),
      taskAdded('epic-old', daysBefore(9)),
    ]);
    const summary = result.projects?.[0];
    expect(summary?.epicsInFlight).toEqual(['epic-old']);
    expect(summary?.epicsActivelyRunning).toEqual([]);
    expect(summary?.epicsIdle).toEqual([{ epicId: 'epic-old', idleDays: 9 }]);
  });

  it('computes the 1-hour budget delta over the running epics only', () => {
    const justAfterCutoff = '2026-08-20T11:00:01.000Z';
    const result = run([
      event({ event_type: 'session-start', causal_parent: null, ts: daysBefore(20) }),
      taskAdded('epic-old', daysBefore(20), 1000),
      event({
        event_type: 'task-result-recorded',
        task_id: 'epic-old/task-1',
        ts: daysBefore(10),
        payload: { task_id: 'epic-old/task-1', token_usage: { total_tokens: 900 } },
      }),
      taskAdded('epic-new', daysBefore(1), 1000),
      event({
        event_type: 'task-result-recorded',
        task_id: 'epic-new/task-1',
        ts: justAfterCutoff,
        payload: { task_id: 'epic-new/task-1', token_usage: { total_tokens: 100 } },
      }),
    ]);
    expect(result.epicsActivelyRunning).toEqual(['epic-new']);
    // Over both epics this would read 5 (50% now, 45% an hour ago); epic-new alone is 10%.
    expect(result.budgetUsedPctPointDelta1h).toBe(10);
  });
});
