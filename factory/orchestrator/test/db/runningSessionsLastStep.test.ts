// A session row's "last step" must name what happened. For a dispatch that is
// the agent role and the task (its id and title, named by the UI); any other last
// event carries neither.
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DbHandle, openDb, projectSession, projectTasks } from '../../src/db/projector.js';
import { overview, runningSessions } from '../../src/db/queries.js';
import type { StoredEvent } from '../../src/events.js';

const SESSION_ID = 'sess-last-step';
let n = 0;
function event(overrides: Partial<StoredEvent['record']> & { event_type: string }): StoredEvent {
  n += 1;
  return {
    event_id: `${SESSION_ID}#${n}`,
    record: {
      session_id: SESSION_ID,
      actor: 'system',
      plan_version: 1,
      causal_parent: n === 1 ? null : `${SESSION_ID}#${n - 1}`,
      payload: {},
      ts: `2026-08-04T12:00:${String(n).padStart(2, '0')}.000Z`,
      ...overrides,
    },
  };
}
const taskAdded = (taskId: string, title?: string) =>
  event({
    event_type: 'task-added',
    task_id: taskId,
    payload: {
      epic_id: 'epic-a',
      case: 'feature',
      origin: 'user',
      task_status: 'todo',
      ...(title ? { title } : {}),
    },
  });
const dispatched = (taskId: string) =>
  event({
    event_type: 'dispatch_decision',
    task_id: taskId,
    payload: { agent_role: 'coder', provider: 'claude', model_tier: 'mid' },
  });

describe('runningSessions() last-step detail', () => {
  let dir: string;
  let handle: DbHandle;
  beforeEach(async () => {
    n = 0;
    dir = await mkdtemp(path.join(tmpdir(), 'smith-last-step-'));
    handle = openDb(path.join(dir, 'smith.db'));
  });
  afterEach(async () => {
    handle.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  });
  function load(events: StoredEvent[]) {
    projectSession(handle, SESSION_ID, events);
    projectTasks(handle, events);
    return runningSessions(handle.db, {}, { nowIso: '2026-08-04T13:00:00.000Z' })[0];
  }

  it('names the role and the task title for a dispatch', () => {
    const row = load([taskAdded('epic-a/t1', 'Fix the thing'), dispatched('epic-a/t1')]);
    expect(row?.lastStepRole).toBe('coder');
    expect(row?.lastStepTaskId).toBe('epic-a/t1');
    expect(row?.lastStepTaskTitle).toBe('Fix the thing');
  });

  it('sends the task id with a null title when the task has none, for the UI to name', () => {
    const row = load([taskAdded('epic-a/t1'), dispatched('epic-a/t1')]);
    expect(row?.lastStepTaskId).toBe('epic-a/t1');
    expect(row?.lastStepTaskTitle).toBeNull();
  });

  it('carries neither for a non-dispatch last event', () => {
    const row = load([
      taskAdded('epic-a/t1', 'X'),
      dispatched('epic-a/t1'),
      event({ event_type: 'operator-note' }),
    ]);
    expect(row?.lastStepRole).toBeNull();
    expect(row?.lastStepTaskId).toBeNull();
    expect(row?.lastStepTaskTitle).toBeNull();
  });
});

describe('overview().projects[] per-epic spend', () => {
  it('carries each epic of the project with its own budget, beside the project-wide totals', () => {
    n = 0;
    const events = [
      event({
        event_type: 'task-added',
        task_id: 'epic-a/t1',
        project: 'project-a',
        payload: { epic_id: 'epic-a', task_status: 'todo', budget_tokens: 100 },
      }),
      event({
        event_type: 'task-added',
        task_id: 'epic-b/t1',
        project: 'project-a',
        payload: { epic_id: 'epic-b', task_status: 'todo' },
      }),
    ];
    const holder = mkdtempSync(path.join(tmpdir(), 'smith-per-epic-'));
    const h = openDb(path.join(holder, 'smith.db'));
    try {
      projectSession(h, SESSION_ID, events);
      projectTasks(h, events);
      const p = overview(h.db, {}, { nowIso: '2026-08-04T13:00:00.000Z' }).projects?.[0];
      expect(p?.tokensByEpic.find((e) => e.epicId === 'epic-a')?.tokensBudget).toBe(100);
    } finally {
      h.sqlite.close();
      rmSync(holder, { recursive: true, force: true });
    }
  });
});
