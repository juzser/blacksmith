import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import { timeline } from '../../src/db/queries.js';

/** A raw log line with the ts spelled out (same fixture shape as taskTotals.test.ts). */
function tiedLine(
  eventType: string,
  ts: string,
  payload: Record<string, unknown>,
  sessionId: string,
): string {
  return `${JSON.stringify({
    session_id: sessionId,
    actor: 'user',
    event_type: eventType,
    plan_version: 1,
    causal_parent: eventType === 'session-start' ? null : `${sessionId}#0`,
    payload,
    ts,
  })}\n`;
}

describe('timeline() sessionTitle join (DS6 PR4b)', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-session-title-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-session-title-db-'));
  });

  afterEach(async () => {
    handle?.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('every entry carries its own sessionId and a sessionTitle derived from the earliest dispatch epic (no prompt logged)', async () => {
    const session = 'sess-title-1';
    const task = 'epic-title/task-1';
    await appendFile(
      path.join(stateDir, `${session}.jsonl`),
      tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session) +
        tiedLine('task-added', '2029-06-01T00:00:00.000Z', { task_id: task }, session) +
        tiedLine(
          'dispatch_decision',
          '2029-06-01T00:01:00.000Z',
          { task_id: task, agent_role: 'coder', provider: 'claude', model_tier: 'mid' },
          session,
        ),
      'utf8',
    );
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);

    const entries = timeline(handle.db, { sessionId: session });
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.sessionId).toBe(session);
      expect(e.sessionTitle).toBe('epic-title');
    }
  });

  it('falls back to the raw session id when the session has no prompt and no dispatch', async () => {
    const session = 'sess-title-2';
    await appendFile(
      path.join(stateDir, `${session}.jsonl`),
      tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, session) +
        tiedLine('operator-note', '2029-06-01T00:01:00.000Z', { note: 'hi' }, session),
      'utf8',
    );
    const dbPath = path.join(dbDir, 'smith2.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);

    const entries = timeline(handle.db, { sessionId: session });
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.sessionTitle).toBe(session);
  });
});
