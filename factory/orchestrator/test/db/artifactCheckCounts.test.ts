// An artifact-check-result payload is { ok, checked, issues }, not a results
// array: its gate counts come from those fields, and only a payload with none
// of them reads as unmeasured.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DbHandle, openDb, projectSession } from '../../src/db/projector.js';
import { timeline } from '../../src/db/queries.js';
import type { StoredEvent } from '../../src/events.js';

const SESSION_ID = 'sess-artifact-check';

function check(n: number, payload: Record<string, unknown>): StoredEvent {
  return {
    event_id: `${SESSION_ID}#${n}`,
    record: {
      session_id: SESSION_ID,
      actor: 'system',
      plan_version: 1,
      causal_parent: n === 1 ? null : `${SESSION_ID}#${n - 1}`,
      event_type: 'artifact-check-result',
      task_id: 'epic-a/t1',
      payload,
      ts: `2026-08-04T12:00:0${n}.000Z`,
    },
  };
}

describe('timeline() artifact-check gateCounts', () => {
  let dir: string;
  let handle: DbHandle;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smith-artifact-counts-'));
    handle = openDb(path.join(dir, 'smith.db'));
  });
  afterEach(async () => {
    handle.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  });

  function counts(payloads: Record<string, unknown>[]) {
    projectSession(
      handle,
      SESSION_ID,
      payloads.map((p, i) => check(i + 1, p)),
    );
    return timeline(handle.db, { sessionId: SESSION_ID }).map((e) => e.gateCounts);
  }

  it('reads checked and issues', () => {
    expect(
      counts([
        { ok: true, checked: 18, issues: [] },
        { ok: false, checked: 18, issues: ['a', 'b'] },
        { ok: false, checked: 0, issues: ['missing'] },
      ]),
    ).toEqual([
      { passed: 18, failed: 0 },
      { passed: 16, failed: 2 },
      { passed: 0, failed: 1 },
    ]);
  });

  it('stays null when the payload carries nothing to count', () => {
    expect(counts([{}])).toEqual([null]);
  });
});
