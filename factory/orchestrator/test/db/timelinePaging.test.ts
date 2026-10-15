import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import { eventKind, requestQuoteForTask, timeline } from '../../src/db/queries.js';
import { compareLogOrder } from '../../src/events.js';
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
 * A raw log line with an explicit `causal_parent` and optional `task_id` —
 * for fixtures that need to name a parent outside the line's own session
 * (only a `session-start` may), unlike `tiedLine`'s always-local parent.
 */
function crossSessionLine(
  eventType: string,
  ts: string,
  payload: Record<string, unknown>,
  session: string,
  causalParent: string | null,
  taskId?: string,
): string {
  return `${JSON.stringify({
    session_id: session,
    actor: 'user',
    event_type: eventType,
    plan_version: 1,
    causal_parent: causalParent,
    payload,
    ts,
    ...(taskId ? { task_id: taskId } : {}),
  })}\n`;
}

/** A raw log line with an explicit project and an optional task id. */
function projectLine(
  eventType: string,
  ts: string,
  session: string,
  project: string,
  taskId?: string,
): string {
  return `${JSON.stringify({
    session_id: session,
    actor: 'user',
    event_type: eventType,
    plan_version: 1,
    causal_parent: eventType === 'session-start' ? null : `${session}#0`,
    payload: {},
    ts,
    project,
    ...(taskId ? { task_id: taskId } : {}),
  })}\n`;
}

/** What a paged walk skipped or repeated, spelled out for a failure message. */
function walkDiff(seen: string[], expected: string[]): string {
  const counts = new Map<string, number>();
  for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
  const repeated = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
  const skipped = expected.filter((id) => !counts.has(id));
  return `skipped: [${skipped.join(', ')}] repeated: [${repeated.join(', ')}]`;
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

  /**
   * Session B's root continues session A (S3 parity fixture): A holds the
   * `user_prompt`, B's `session-start` names A's prompt as its own causal
   * parent, and a `dispatch_decision` in B sits one hop below that root.
   */
  async function openCrossSessionFixture(): Promise<string> {
    const a = 'parity-a';
    const b = 'parity-b';
    const taskId = 'parity-epic/parity-task';
    await appendFile(
      path.join(stateDir, `${a}.jsonl`),
      crossSessionLine('session-start', '2030-03-01T00:00:00.000Z', {}, a, null) +
        crossSessionLine(
          'user_prompt',
          '2030-03-01T00:01:00.000Z',
          { prompt: 'build the parity fixture' },
          a,
          `${a}#0`,
        ),
      'utf8',
    );
    await appendFile(
      path.join(stateDir, `${b}.jsonl`),
      crossSessionLine('session-start', '2030-03-01T00:02:00.000Z', {}, b, `${a}#1`) +
        crossSessionLine('dispatch_decision', '2030-03-01T00:03:00.000Z', {}, b, `${b}#0`, taskId),
      'utf8',
    );
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
    return taskId;
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

  it('events that share one ts come back in numeric log order, not text order, across window boundaries', async () => {
    const a = 'order-a';
    const tie = '2030-04-01T00:01:00.000Z';
    let body = tiedLine('session-start', '2030-04-01T00:00:00.000Z', {}, a);
    for (let i = 1; i <= 12; i += 1) body += tiedLine('operator-note', tie, { note: `n${i}` }, a);
    await appendFile(path.join(stateDir, `${a}.jsonl`), body, 'utf8');
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);

    // Newest-first: #12 ... #1 then the session start. Text order would put #9 after #10.
    const expected = [
      '#12',
      '#11',
      '#10',
      '#9',
      '#8',
      '#7',
      '#6',
      '#5',
      '#4',
      '#3',
      '#2',
      '#1',
      '#0',
    ].map((n) => `${a}${n}`);
    for (const limit of [1, 2, 3, 5]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = timeline(handle.db, { limit, ...(cursor ? { before: cursor } : {}) });
        if (page.length === 0) break;
        seen.push(...page.map((e) => e.eventId));
        cursor = page[page.length - 1]?.eventId;
      }
      expect(seen, `limit ${limit}: ${walkDiff(seen, expected)}`).toEqual(expected);
    }
  });

  describe('a tie group that spans two sessions and straddles the cursor', () => {
    const tieTs = '2030-05-01T01:00:00.000Z';
    const sessions = [
      { id: 'tie-a', project: 'project-a', task: 'epic-a/task-1' },
      { id: 'tie-b', project: 'project-b', task: 'epic-b/task-1' },
    ];

    /** Ascending compareLogOrder order of every event in the store, and the six tied ones. */
    async function openTieStore(): Promise<{ all: string[]; group: string[] }> {
      const stamp = (n: number, offset: number) =>
        new Date(Date.UTC(2030, 4, 1, 0, 0, 0) + n * 2000 + offset).toISOString();
      const ids: { ts: string; eventId: string }[] = [];
      for (const [k, s] of sessions.entries()) {
        let body = projectLine('session-start', stamp(0, k), s.id, s.project);
        ids.push({ ts: stamp(0, k), eventId: `${s.id}#0` });
        for (let i = 1; i <= 11; i += 1) {
          const ts = i >= 8 && i <= 10 ? tieTs : i === 11 ? stamp(20, k) : stamp(i, k);
          body += projectLine('operator-note', ts, s.id, s.project, s.task);
          ids.push({ ts, eventId: `${s.id}#${i}` });
        }
        await appendFile(path.join(stateDir, `${s.id}.jsonl`), body, 'utf8');
      }
      // Project the later-sorting session first, so rowid order of the group
      // differs from compareLogOrder order.
      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, ['tie-b', 'tie-a'], { stateDir });
      handle = openDb(dbPath);
      ids.sort(compareLogOrder);
      return {
        all: ids.map((e) => e.eventId),
        group: ids.filter((e) => e.ts === tieTs).map((e) => e.eventId),
      };
    }

    it('before and after pages hold their own side of the cursor, and a full walk loses nothing', async () => {
      const { all, group } = await openTieStore();
      expect(group).toHaveLength(6);
      const cursor = group[2] as string;
      const at = all.indexOf(cursor);

      for (const limit of [1, 2, 3]) {
        const before = timeline(handle.db, { limit, before: cursor }).map((e) => e.eventId);
        const wantBefore = all.slice(Math.max(0, at - limit), at).reverse();
        expect(before, `before, limit ${limit}`).toEqual(wantBefore);

        const after = timeline(handle.db, { limit, after: cursor }).map((e) => e.eventId);
        const wantAfter = all.slice(at + 1, at + 1 + limit).reverse();
        expect(after, `after, limit ${limit}`).toEqual(wantAfter);

        const older: string[] = [];
        for (let cur = cursor, guard = 0; guard < 60; guard += 1) {
          const page = timeline(handle.db, { limit, before: cur });
          if (page.length === 0) break;
          older.push(...page.map((e) => e.eventId));
          cur = page[page.length - 1]?.eventId as string;
        }
        const newer: string[] = [];
        for (let cur = cursor, guard = 0; guard < 60; guard += 1) {
          const page = timeline(handle.db, { limit, after: cur });
          if (page.length === 0) break;
          newer.push(...page.map((e) => e.eventId).reverse());
          cur = page[0]?.eventId as string;
        }
        const wantOlder = all.slice(0, at).reverse();
        const wantNewer = all.slice(at + 1);
        expect(older, `older walk, limit ${limit}: ${walkDiff(older, wantOlder)}`).toEqual(
          wantOlder,
        );
        expect(newer, `newer walk, limit ${limit}: ${walkDiff(newer, wantNewer)}`).toEqual(
          wantNewer,
        );
        expect([...older, ...newer]).not.toContain(cursor);
      }
    });
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
    // DS6 PR3 r2: operator-note is a Prompt row, same as user_prompt (both
    // are the operator's own words), not System -- fixed alongside the rest
    // of eventKind()'s taxonomy coverage in queries.ts.
    expect(eventKind('operator-note', {})).toBe('Prompt');
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

  it('memoizedNearestPromptId agrees with nearestUserPrompt across a session boundary (S3 parity)', async () => {
    const taskId = await openCrossSessionFixture();
    const entries = timeline(handle.db, {});
    const dispatch = entries.find((e) => e.eventType === 'dispatch_decision');
    expect(dispatch).toBeDefined();

    const quote = requestQuoteForTask(handle.db, taskId, 'parity-b');
    expect(quote?.source).toBe('task');
    expect(dispatch?.nearestPromptId).toBe(quote?.eventId);

    const prompt = entries.find((e) => e.eventType === 'user_prompt');
    expect(dispatch?.nearestPromptId).toBe(prompt?.eventId);
  });

  it('a paged call does not pay a causal walk for every row in the table (perf regression)', async () => {
    await openMainFixture();
    const totalRows = timeline(handle.db, { sessionId: SESSION_ID }).length;
    expect(totalRows).toBeGreaterThan(10); // otherwise this proves nothing

    const spy = vi.spyOn(handle.db, 'select');
    const page = timeline(handle.db, { sessionId: SESSION_ID, limit: 2 });
    const limitedSelectCalls = spy.mock.calls.length;
    spy.mockRestore();

    expect(page.length).toBe(2);
    // One query fetches the session's rows; `nearestPromptId` for the 2 paged
    // rows is then resolved from that same in-memory set. A call that still
    // walks every fetched row's causal chain before paging (the pre-fix
    // behavior) issues a `prompts`-table select per row and scales with
    // `totalRows`, not with the 2-row page.
    expect(limitedSelectCalls).toBeLessThan(totalRows);
  });
});
