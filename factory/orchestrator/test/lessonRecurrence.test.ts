import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/events.js';
import {
  EPIC_REPEAT_MIN,
  errorClassCounts,
  RECUR_MIN_TASKS,
  RECUR_WINDOW_DAYS,
} from '../src/lessonRecurrence.js';

const NOW = new Date('2026-10-22T00:00:00.000Z');
const WINDOW = { now: NOW, windowDays: RECUR_WINDOW_DAYS };

let n = 0;
function logged(
  payload: Record<string, unknown>,
  opts: { taskId?: string; ts?: string; type?: string } = {},
): StoredEvent {
  n += 1;
  return {
    event_id: `s:${n}`,
    record: {
      session_id: 's',
      actor: 'orchestrator',
      event_type: opts.type ?? 'error-logged',
      plan_version: 1,
      causal_parent: null,
      ts: opts.ts ?? '2026-10-20T00:00:00.000Z',
      ...(opts.taskId ? { task_id: opts.taskId } : {}),
      payload: { error: 'execution.flaky-test', severity: 'S3-minor', ...payload },
    },
  };
}

describe('errorClassCounts', () => {
  it('names the operator thresholds', () => {
    expect([RECUR_MIN_TASKS, RECUR_WINDOW_DAYS, EPIC_REPEAT_MIN]).toEqual([3, 30, 1]);
  });

  it('counts distinct tasks per class, store-wide and per epic', () => {
    const counts = errorClassCounts(
      [
        logged({ task_ref: 'e1/a' }),
        logged({ task_ref: 'e1/b' }),
        logged({ task_ref: 'e2/a' }),
        logged({ task_ref: 'e2/a', error: 'execution.timeout' }),
      ],
      WINDOW,
    );
    expect(counts.get('execution.flaky-test')?.tasks).toBe(3);
    expect(counts.get('execution.flaky-test')?.epics.get('e1')).toBe(2);
    expect(counts.get('execution.flaky-test')?.epics.get('e2')).toBe(1);
    expect(counts.get('execution.timeout')?.tasks).toBe(1);
  });

  it('counts repeated events on one task once', () => {
    const counts = errorClassCounts(
      [logged({ task_ref: 'e1/a' }), logged({ task_ref: 'e1/a' }), logged({}, { taskId: 'e1/a' })],
      WINDOW,
    );
    expect(counts.get('execution.flaky-test')?.tasks).toBe(1);
  });

  it('drops events outside the window and events of other types', () => {
    const counts = errorClassCounts(
      [
        logged({ task_ref: 'e1/a' }, { ts: '2026-09-21T00:00:00.000Z' }),
        logged({ task_ref: 'e1/b' }, { type: 'result' }),
        logged({ task_ref: 'e1/c' }, { ts: '2026-09-23T00:00:00.000Z' }),
      ],
      WINDOW,
    );
    expect(counts.get('execution.flaky-test')?.tasks).toBe(1);
  });

  it('skips an event with no task identity', () => {
    expect(errorClassCounts([logged({})], WINDOW).size).toBe(0);
  });

  it('lets payload.epic_id win, and counts an unqualified task store-wide only', () => {
    const counts = errorClassCounts(
      [logged({ task_ref: 'e1/a', epic_id: 'e9' }), logged({ task_ref: 'loose' })],
      WINDOW,
    );
    const c = counts.get('execution.flaky-test');
    expect(c?.tasks).toBe(2);
    expect([...(c?.epics ?? [])]).toEqual([['e9', 1]]);
  });

  it('counts an event exactly on the 30-day boundary and drops one a millisecond older', () => {
    const counts = errorClassCounts(
      [
        logged({ task_ref: 'e1/a' }, { ts: '2026-09-22T00:00:00.000Z' }),
        logged({ task_ref: 'e1/b' }, { ts: '2026-09-21T23:59:59.999Z' }),
      ],
      WINDOW,
    );
    expect(counts.get('execution.flaky-test')?.tasks).toBe(1);
  });

  it('skips an event with an empty or non-string class, or an unparsable ts', () => {
    const counts = errorClassCounts(
      [
        logged({ task_ref: 'e1/a', error: '' }),
        logged({ task_ref: 'e1/b', error: 7 }),
        logged({ task_ref: 'e1/c' }, { ts: 'not-a-date' }),
      ],
      WINDOW,
    );
    expect(counts.size).toBe(0);
  });
});
