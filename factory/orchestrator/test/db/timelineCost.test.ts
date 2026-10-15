import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import { timeline } from '../../src/db/queries.js';

const SESSION = 'cost-a';
const TOTAL = 2000;

function line(i: number): string {
  const ts = new Date(Date.UTC(2030, 0, 1) + i * 1000).toISOString();
  const eventType = i === 0 ? 'session-start' : i % 20 === 0 ? 'gate-outcome' : 'operator-note';
  const taskId = i % 10 === 5 ? 'epic-a/task-1' : undefined;
  return `${JSON.stringify({
    session_id: SESSION,
    actor: 'user',
    event_type: eventType,
    plan_version: 1,
    causal_parent: i === 0 ? null : `${SESSION}#0`,
    payload: { note: `n${i}` },
    ts,
    ...(taskId ? { task_id: taskId } : {}),
  })}\n`;
}

/** Runs `fn` and returns how many JSON.parse calls it made. */
function countParses(fn: () => void): number {
  const spy = vi.spyOn(JSON, 'parse');
  try {
    fn();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe('timeline() page cost: work follows the page, not the history', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-cost-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-cost-db-'));
    let body = '';
    for (let i = 0; i < TOTAL; i += 1) body += line(i);
    await appendFile(path.join(stateDir, `${SESSION}.jsonl`), body, 'utf8');
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  });

  afterEach(async () => {
    handle?.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  // Every ts in this store is unique, so a boundary tie group is one row and
  // "9 plus one tie group" is at most 10.
  const PAGE_BUDGET = 9 + 1;

  it('a limit-8 page parses at most 9 payloads plus one boundary tie group', () => {
    let page: ReturnType<typeof timeline> = [];
    const parses = countParses(() => {
      page = timeline(handle.db, { limit: 8 });
    });
    expect(page).toHaveLength(8);
    expect(parses).toBeLessThanOrEqual(PAGE_BUDGET);
  });

  it('the more-probe parses at most 2 payloads plus one boundary tie group', () => {
    const cursor = timeline(handle.db, { limit: 8 }).at(-1)?.eventId as string;
    let probe: ReturnType<typeof timeline> = [];
    const parses = countParses(() => {
      probe = timeline(handle.db, { limit: 1, before: cursor });
    });
    expect(probe).toHaveLength(1);
    expect(parses).toBeLessThanOrEqual(2 + 1);
  });

  it('prepares an ORDER BY ... LIMIT statement', () => {
    const prepare = vi.spyOn(handle.sqlite, 'prepare');
    try {
      timeline(handle.db, { limit: 8 });
      const statements = prepare.mock.calls.map((c) => String(c[0]));
      expect(statements.some((s) => /order by/i.test(s) && /limit/i.test(s))).toBe(true);
    } finally {
      prepare.mockRestore();
    }
  });

  it('a kind that is 1 row in 20 still parses at most 9 payloads plus one tie group', () => {
    let page: ReturnType<typeof timeline> = [];
    const parses = countParses(() => {
      page = timeline(handle.db, { limit: 8, kinds: ['Gate'] });
    });
    expect(page).toHaveLength(8);
    expect(page.every((e) => e.kind === 'Gate')).toBe(true);
    expect(parses).toBeLessThanOrEqual(PAGE_BUDGET);
  });

  it('an epic page parses only the windows it reads; the pre-pass parses none in JS', () => {
    // epic-a holds one row in 10, so a limit-8 page reads about 80 rows.
    let page: ReturnType<typeof timeline> = [];
    const parses = countParses(() => {
      page = timeline(handle.db, { limit: 8, epicId: 'epic-a' });
    });
    expect(page).toHaveLength(8);
    expect(page.every((e) => e.taskId === 'epic-a/task-1')).toBe(true);
    expect(parses).toBeLessThanOrEqual(100);
    expect(parses).toBeGreaterThanOrEqual(8);
  });
});
