import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import { eventKind, timeline } from '../../src/db/queries.js';
import { buildFixture, EPIC_ID, SESSION_ID, TASK_1 } from './fixtures.js';

/** A raw log line with the ts spelled out, so a tie is the test's and not the
 * clock's -- mirrors queries.test.ts's tiedLine(). */
function tiedLine(
  eventType: string,
  ts: string,
  payload: Record<string, unknown>,
  session: string,
): string {
  return `${JSON.stringify({
    session_id: session,
    actor: 'user',
    event_type: eventType,
    plan_version: 1,
    causal_parent: eventType === 'session-start' ? null : `${session}#0`,
    payload,
    ts,
  })}\n`;
}

/**
 * Two sessions, six free-listed events, with one deliberate same-ts tie
 * (noteA2 / noteB1) across session boundaries -- the case that breaks a
 * string compare on event ids, since `paging-a#2` and `paging-b#1` are not
 * orderable as text, only through `compareLogOrder`'s (ts, sessionId) rule.
 *
 * Ascending (oldest-first) order:
 *   sessionStartA, sessionStartB, noteA1, noteA2, noteB1, noteB2
 * (noteA2 sorts before noteB1: same ts, 'paging-a' < 'paging-b').
 */
async function buildPagingFixture(dir: string): Promise<void> {
  const a = 'paging-a';
  const b = 'paging-b';
  await appendFile(
    path.join(dir, `${a}.jsonl`),
    tiedLine('session-start', '2030-02-01T00:00:00.000Z', {}, a) +
      tiedLine('operator-note', '2030-02-01T00:01:00.000Z', { note: 'a1' }, a) +
      tiedLine('operator-note', '2030-02-01T00:02:00.000Z', { note: 'a2' }, a),
    'utf8',
  );
  await appendFile(
    path.join(dir, `${b}.jsonl`),
    tiedLine('session-start', '2030-02-01T00:00:00.500Z', {}, b) +
      tiedLine('operator-note', '2030-02-01T00:02:00.000Z', { note: 'b1' }, b) +
      tiedLine('operator-note', '2030-02-01T00:03:00.000Z', { note: 'b2' }, b),
    'utf8',
  );
}

describe('timeline() paging (DS6)', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-paging-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-paging-db-'));
  });

  afterEach(async () => {
    handle?.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  async function openPagingFixture(): Promise<void> {
    await buildPagingFixture(stateDir);
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  }

  async function openMainFixture(): Promise<void> {
    await buildFixture({ stateDir });
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  }

  it('limit returns the newest N rows, newest-first', async () => {
    await openPagingFixture();
    const page = timeline(handle.db, { limit: 2 });
    expect(page.map((e) => e.payload.note)).toEqual(['b2', 'b1']);
  });

  it('before pages strictly-older rows; a cross-session tie is neither duplicated nor skipped', async () => {
    await openPagingFixture();
    const full = timeline(handle.db, {});
    expect(full.length).toBe(6);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = timeline(handle.db, { limit: 2, ...(cursor ? { before: cursor } : {}) });
      if (page.length === 0) break;
      seen.push(...page.map((e) => e.eventId));
      cursor = page[page.length - 1]?.eventId;
    }

    expect(new Set(seen)).toEqual(new Set(full.map((e) => e.eventId)));
    expect(seen.length).toBe(full.length);
  });

  it('after returns only rows strictly newer than the cursor', async () => {
    await openPagingFixture();
    const full = timeline(handle.db, {}); // oldest-first
    const cursorId = full[0]?.eventId as string; // sessionStartA, the global oldest
    const page = timeline(handle.db, { after: cursorId });
    expect(page.map((e) => e.eventId)).not.toContain(cursorId);
    expect(page.length).toBe(full.length - 1);
  });

  it('after with limit returns the OLDEST limit rows newer than the cursor, newest-first', async () => {
    await openPagingFixture();
    const full = timeline(handle.db, {});
    const cursorId = full[0]?.eventId as string; // sessionStartA
    // Rows newer than cursor, oldest-first: sessionStartB, noteA1, noteA2, noteB1, noteB2.
    // The oldest 2 of those are sessionStartB, noteA1 -- returned newest-first.
    const page = timeline(handle.db, { after: cursorId, limit: 2 });
    expect(page.map((e) => e.payload.note ?? 'session-start')).toEqual(['a1', 'session-start']);
  });

  it('an unknown cursor raises a typed error', async () => {
    await openPagingFixture();
    expect(() => timeline(handle.db, { before: 'no-such-session#0' })).toThrow();
    try {
      timeline(handle.db, { before: 'no-such-session#0' });
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe('timeline.unknown-cursor');
    }
  });

  it('epic and kinds filters apply before the limit', async () => {
    await openMainFixture();
    const gateRows = timeline(handle.db, { sessionId: SESSION_ID, epicId: EPIC_ID }).filter(
      (e) => e.kind === 'Gate',
    );
    expect(gateRows.length).toBeGreaterThanOrEqual(2);

    const page = timeline(handle.db, {
      sessionId: SESSION_ID,
      epicId: EPIC_ID,
      kinds: ['Gate'],
      limit: 2,
    });
    expect(page.length).toBe(2);
    for (const entry of page) {
      expect(entry.kind).toBe('Gate');
      expect(entry.taskId?.startsWith(`${EPIC_ID}/`)).toBe(true);
    }
  });

  it('eventKind maps each of the 9 kinds', () => {
    expect(eventKind('user_prompt', {})).toBe('Prompt');
    expect(eventKind('dispatch_decision', {})).toBe('Dispatched');
    expect(eventKind('task-result-recorded', {})).toBe('Returned');
    expect(eventKind('judge-reported', {})).toBe('Finding');
    expect(eventKind('gate-outcome', {})).toBe('Gate');
    expect(eventKind('testgate-result', {})).toBe('Gate');
    expect(eventKind('wave-merged', {})).toBe('Merge');
    expect(eventKind('error-logged', {})).toBe('Error');
    expect(eventKind('waiver-granted', {})).toBe('Feedback');
    expect(eventKind('waiver-denied', {})).toBe('Feedback');
    expect(eventKind('operator-note', {})).toBe('System');
  });

  it('nearestPromptId resolves through several causal hops; a prompt answers itself; an orphan is null', async () => {
    await openMainFixture();
    const entries = timeline(handle.db, { sessionId: SESSION_ID, taskId: TASK_1 });
    const prompt = timeline(handle.db, { sessionId: SESSION_ID }).find(
      (e) => e.eventType === 'user_prompt',
    );
    expect(prompt).toBeDefined();
    expect(prompt?.nearestPromptId).toBe(prompt?.eventId);

    const dispatch = entries.find((e) => e.eventType === 'dispatch_decision');
    expect(dispatch?.nearestPromptId).toBe(prompt?.eventId);

    const orphan = timeline(handle.db, { sessionId: SESSION_ID }).find(
      (e) => e.eventType === 'session-start',
    );
    expect(orphan?.nearestPromptId).toBeNull();
  });
});
