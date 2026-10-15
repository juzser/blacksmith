import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import { type TimelineFilter, timeline } from '../../src/db/queries.js';
import { DB_MIGRATIONS_DIR } from '../../src/paths.js';

/**
 * Pins the query plans of the statements timelinePage really prepares. They are
 * captured at the driver (the SQL text and bound parameters better-sqlite3
 * receives), then run through EXPLAIN QUERY PLAN on the same connection. No
 * ANALYZE runs: production has no sqlite_stat1 either.
 */

const SESSION_A = 'plan-a';
const SESSION_B = 'plan-b';
const SMALL = 2000;

function line(session: string, i: number): string {
  // Two rows share every ts, so a full window always has a tie group to complete.
  const ts = new Date(Date.UTC(2030, 0, 1) + Math.floor(i / 2) * 1000).toISOString();
  const eventType = i === 0 ? 'session-start' : i % 20 === 0 ? 'gate-outcome' : 'operator-note';
  return `${JSON.stringify({
    session_id: session,
    actor: 'user',
    event_type: eventType,
    plan_version: 1,
    causal_parent: i === 0 ? null : `${session}#0`,
    payload: { note: `n${i}` },
    ts,
    ...(i % 10 === 5 ? { task_id: 'epic-a/task-1' } : {}),
  })}\n`;
}

interface Captured {
  sql: string;
  params: unknown[];
}

/** Every statement fn prepares and runs, with the parameters it was run with. */
function capture(handle: DbHandle, fn: () => void): Captured[] {
  const seen: Captured[] = [];
  const realPrepare = handle.sqlite.prepare.bind(handle.sqlite);
  const spy = vi.spyOn(handle.sqlite, 'prepare').mockImplementation(((source: string) => {
    const stmt = realPrepare(source) as unknown as Record<string, unknown>;
    for (const method of ['all', 'get', 'run', 'values']) {
      const original = stmt[method] as (...a: unknown[]) => unknown;
      stmt[method] = (...args: unknown[]) => {
        seen.push({ sql: source, params: args });
        return original.apply(stmt, args);
      };
    }
    return stmt;
  }) as never);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return seen;
}

/** The events_raw statements that filter on event_type: the timeline reads. */
function windowStatements(all: Captured[]): Captured[] {
  return all.filter(
    (c) => /from "events_raw" where .*"event_type" in/is.test(c.sql) && !/json_type/i.test(c.sql),
  );
}

function plan(handle: DbHandle, c: Captured): string[] {
  const rows = handle.sqlite.prepare(`EXPLAIN QUERY PLAN ${c.sql}`).all(...c.params) as {
    detail: string;
  }[];
  return rows.map((r) => r.detail);
}

interface Scenario {
  name: string;
  filter: TimelineFilter;
}

async function buildStore(rowsPerSession: number): Promise<{ handle: DbHandle; dirs: string[] }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'smith-plan-events-'));
  const dbDir = await mkdtemp(path.join(tmpdir(), 'smith-plan-db-'));
  for (const session of [SESSION_A, SESSION_B]) {
    let body = '';
    for (let i = 0; i < rowsPerSession; i += 1) body += line(session, i);
    await appendFile(path.join(stateDir, `${session}.jsonl`), body, 'utf8');
  }
  const dbPath = path.join(dbDir, 'smith.db');
  await rebuild(dbPath, 'all', { stateDir });
  return { handle: openDb(dbPath), dirs: [stateDir, dbDir] };
}

describe('timelinePage query plans', () => {
  let small: { handle: DbHandle; dirs: string[] };
  let large: { handle: DbHandle; dirs: string[] };

  beforeAll(async () => {
    small = await buildStore(SMALL);
    large = await buildStore(SMALL * 10);
  }, 120_000);

  afterAll(async () => {
    for (const s of [small, large]) {
      s?.handle.sqlite.close();
      for (const d of s?.dirs ?? []) await rm(d, { recursive: true, force: true });
    }
  });

  /** The pages the unscoped criterion names, each with its captured statements. */
  function unscopedCalls(handle: DbHandle): { name: string; stmts: Captured[] }[] {
    const first = timeline(handle.db, { limit: 8 });
    const before = first.at(-1)?.eventId as string;
    const oldest = timeline(handle.db, { limit: 8, before }).at(-1)?.eventId as string;
    const calls: [string, TimelineFilter][] = [
      ['before page', { limit: 8 }],
      ['after page', { limit: 8, after: oldest }],
      ['more-probe', { limit: 1, before }],
    ];
    return calls.map(([name, filter]) => ({
      name,
      stmts: windowStatements(capture(handle, () => timeline(handle.db, filter))),
    }));
  }

  it('serves every unscoped window and tie-group statement from a ts-ordered index', () => {
    const calls = unscopedCalls(small.handle);
    for (const { name, stmts } of calls) {
      // Window plus tie-group completion: both statements are really prepared.
      expect(stmts.length, `${name}: statements captured`).toBeGreaterThanOrEqual(2);
      for (const stmt of stmts) {
        const detail = plan(small.handle, stmt).join('\n');
        expect(detail, `${name}: ${stmt.sql}`).toMatch(/events_raw_ts_idx/);
        expect(detail, `${name}: ${stmt.sql}`).not.toMatch(/TEMP B-TREE/);
        expect(detail, `${name}: ${stmt.sql}`).not.toMatch(/events_raw_type_idx/);
      }
    }
  });

  it('plans identically at N and 10N timeline rows', () => {
    const a = unscopedCalls(small.handle).flatMap((c) =>
      c.stmts.map((s) => plan(small.handle, s).join('\n')),
    );
    const b = unscopedCalls(large.handle).flatMap((c) =>
      c.stmts.map((s) => plan(large.handle, s).join('\n')),
    );
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  const scoped: Scenario[] = [
    { name: 'one session', filter: { limit: 8, sessionId: SESSION_A } },
    { name: 'one task', filter: { limit: 8, taskId: 'epic-a/task-1' } },
  ];
  for (const { name, filter } of scoped) {
    it(`serves the ${name} page without a temp B-tree`, () => {
      const stmts = windowStatements(
        capture(small.handle, () => timeline(small.handle.db, filter)),
      );
      expect(stmts.length).toBeGreaterThanOrEqual(2);
      for (const stmt of stmts) {
        const detail = plan(small.handle, stmt).join('\n');
        expect(detail, stmt.sql).toMatch(/_ts_idx/);
        expect(detail, stmt.sql).not.toMatch(/TEMP B-TREE/);
        expect(detail, stmt.sql).not.toMatch(/events_raw_type_idx/);
      }
    });
  }

  it('keeps a session-id list page off the type index (residual sorter bounded by those sessions)', () => {
    const filter: TimelineFilter = { limit: 8, sessionIds: [SESSION_A, SESSION_B] };
    const stmts = windowStatements(capture(small.handle, () => timeline(small.handle.db, filter)));
    expect(stmts.length).toBeGreaterThanOrEqual(2);
    for (const stmt of stmts) {
      const detail = plan(small.handle, stmt).join('\n');
      expect(detail, stmt.sql).not.toMatch(/events_raw_type_idx/);
    }
  });

  it('leaves the load-all path and the epic pre-pass on the type index', () => {
    const loadAll = windowStatements(capture(small.handle, () => timeline(small.handle.db, {})));
    expect(loadAll.length).toBeGreaterThan(0);
    for (const stmt of loadAll) {
      expect(plan(small.handle, stmt).join('\n'), stmt.sql).toMatch(
        /SEARCH events_raw USING INDEX events_raw_type_idx/,
      );
    }
    const prePass = capture(small.handle, () =>
      timeline(small.handle.db, { limit: 8, epicId: 'epic-a' }),
    ).filter((c) => /json_type/i.test(c.sql) && /from "events_raw"/i.test(c.sql));
    expect(prePass.length).toBeGreaterThan(0);
    for (const stmt of prePass) {
      expect(plan(small.handle, stmt).join('\n'), stmt.sql).toMatch(
        /SEARCH events_raw USING INDEX events_raw_type_idx/,
      );
    }
  });
});

describe('migration 0018', () => {
  it('adds the ts-ordered scope indexes to a store migrated to 0017', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smith-plan-mig-'));
    try {
      const journal = JSON.parse(
        await readFile(path.join(DB_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
      ) as { entries: { idx: number; tag: string }[] };
      const kept = journal.entries.filter((e) => e.idx <= 17);
      const preDir = path.join(dir, 'drizzle');
      await mkdir(path.join(preDir, 'meta'), { recursive: true });
      await writeFile(
        path.join(preDir, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries: kept }),
      );
      for (const e of kept) {
        await copyFile(
          path.join(DB_MIGRATIONS_DIR, `${e.tag}.sql`),
          path.join(preDir, `${e.tag}.sql`),
        );
      }
      const dbPath = path.join(dir, 'smith.db');
      const pre = openDb(dbPath, { migrationsDir: preDir });
      const names = (h: DbHandle) =>
        (
          h.sqlite
            .prepare(
              "select name from sqlite_master where type = 'index' and tbl_name = 'events_raw'",
            )
            .all() as { name: string }[]
        ).map((r) => r.name);
      expect(names(pre)).not.toContain('events_raw_session_ts_idx');
      pre.sqlite.close();

      const post = openDb(dbPath);
      expect(names(post)).toEqual(
        expect.arrayContaining(['events_raw_session_ts_idx', 'events_raw_task_ts_idx']),
      );
      post.sqlite.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
