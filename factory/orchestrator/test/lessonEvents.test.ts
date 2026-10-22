import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendEvent, type StoredEvent } from '../src/events.js';
import { readRecurrenceEvents } from '../src/lessonEvents.js';
import { errorClassCounts } from '../src/lessonRecurrence.js';

const NOW = new Date('2026-10-22T00:00:00.000Z');
const WINDOW = { now: NOW, windowDays: 30 };
const DAY = 24 * 60 * 60 * 1000;

function line(task: string, ts: string, type = 'error-logged'): string {
  return `${JSON.stringify({
    ts,
    session_id: 'x',
    actor: 'orchestrator',
    event_type: type,
    plan_version: 1,
    causal_parent: null,
    payload: { error: 'execution.flaky-test', severity: 'S3-minor', task_ref: task },
  })}\n`;
}

describe('readRecurrenceEvents', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'smith-recur-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function session(id: string, lines: string[], ageDays = 1): void {
    const file = path.join(dir, `${id}.jsonl`);
    writeFileSync(file, lines.join(''));
    const when = new Date(NOW.getTime() - ageDays * DAY);
    utimesSync(file, when, when);
  }

  it('reads every session: 2 tasks in A and 1 in B recur', async () => {
    session('a', [
      line('e1/a', '2026-10-20T00:00:00.000Z'),
      line('e1/b', '2026-10-20T00:00:00.000Z'),
    ]);
    session('b', [line('e2/c', '2026-10-21T00:00:00.000Z')]);
    const events = await readRecurrenceEvents(dir, WINDOW);
    expect(errorClassCounts(events, WINDOW).get('execution.flaky-test')?.tasks).toBe(3);
  });

  it('never opens a session file older than the window and drops old events in a recent one', async () => {
    session('old', [line('e1/a', '2026-08-01T00:00:00.000Z')], 60);
    session('new', [
      line('e1/b', '2026-08-01T00:00:00.000Z'),
      line('e1/c', '2026-10-20T00:00:00.000Z'),
      line('e1/d', '2026-10-20T00:00:00.000Z', 'result'),
    ]);
    const read = vi.fn(async (_id: string, _opts: { stateDir: string }) => [] as StoredEvent[]);
    await readRecurrenceEvents(dir, WINDOW, { readEvents: read });
    expect(read.mock.calls.map((c) => c[0])).toEqual(['new']);

    const events = await readRecurrenceEvents(dir, WINDOW);
    expect(events.map((e) => (e.record.payload as { task_ref: string }).task_ref)).toEqual([
      'e1/c',
    ]);
  });

  it('stats once per session file and reads once per in-window file', async () => {
    session('a', [], 1);
    session('b', [], 2);
    session('c', [], 90);
    const stat = vi.fn((file: string) => ({ mtimeMs: statSync(file).mtimeMs }));
    const read = vi.fn(async (_id: string, _opts: { stateDir: string }) => [] as StoredEvent[]);
    await readRecurrenceEvents(dir, WINDOW, { stat, readEvents: read });
    expect(stat).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('returns [] for a missing state dir', async () => {
    expect(await readRecurrenceEvents(path.join(dir, 'nope'), WINDOW)).toEqual([]);
    mkdirSync(path.join(dir, 'empty'));
    expect(await readRecurrenceEvents(path.join(dir, 'empty'), WINDOW)).toEqual([]);
  });

  it('pins the invariant the mtime skip rests on: appendEvent never stamps a ts after the file mtime', async () => {
    const root = await appendEvent(
      {
        session_id: 'inv',
        actor: 'orchestrator',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir: dir },
    );
    const stored = await appendEvent(
      {
        session_id: 'inv',
        actor: 'orchestrator',
        event_type: 'error-logged',
        plan_version: 1,
        causal_parent: root.event_id,
        payload: { error: 'execution.flaky-test', severity: 'S3-minor', task_ref: 'e1/a' },
      },
      { stateDir: dir },
    );
    const { mtimeMs } = statSync(path.join(dir, 'inv.jsonl'));
    expect(Date.parse(stored.record.ts)).toBeLessThanOrEqual(mtimeMs + 2000);
  });
});
