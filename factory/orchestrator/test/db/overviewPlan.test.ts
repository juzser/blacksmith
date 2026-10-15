import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import { overview, runningSessions, type Scope } from '../../src/db/queries.js';
import { DB_MIGRATIONS_DIR } from '../../src/paths.js';

/**
 * Pins the work overview() and runningSessions() do per call on the two reads
 * that used to walk a whole table: the newest event per session and the newest
 * ten dispatches. Proved by the query plan of the statements really prepared
 * (captured at the driver, then run through EXPLAIN QUERY PLAN on the same
 * connection) and by counting the rows those statements return, never by
 * timing. No ANALYZE runs: production has no sqlite_stat1 either.
 */

const LIMIT = 10; // RECENT_DISPATCHES_LIMIT
const SESSIONS = ['plan-a', 'plan-b'];
const SMALL = 2000;
const TIE_SIZE = 3; // dispatches sharing one ts in the generated store
const BASE = Date.UTC(2030, 0, 1);

interface Captured {
  sql: string;
  params: unknown[];
  rows: number;
}

/** Every statement fn prepares and runs, with its parameters and the rows it returned. */
function capture(handle: DbHandle, fn: () => void): Captured[] {
  const seen: Captured[] = [];
  const realPrepare = handle.sqlite.prepare.bind(handle.sqlite);
  const spy = vi.spyOn(handle.sqlite, 'prepare').mockImplementation(((source: string) => {
    const stmt = realPrepare(source) as unknown as Record<string, unknown>;
    for (const method of ['all', 'get', 'run', 'values']) {
      const original = stmt[method] as (...a: unknown[]) => unknown;
      stmt[method] = (...args: unknown[]) => {
        const out = original.apply(stmt, args);
        seen.push({
          sql: source,
          params: args,
          rows: Array.isArray(out) ? out.length : out === undefined ? 0 : 1,
        });
        return out;
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

function plan(handle: DbHandle, c: Captured): string {
  const rows = handle.sqlite.prepare(`EXPLAIN QUERY PLAN ${c.sql}`).all(...c.params) as {
    detail: string;
  }[];
  return rows.map((r) => r.detail).join('\n');
}

/** The newest-event read: the one events_raw statement that takes a max(ts). */
const newestEventStatements = (all: Captured[]): Captured[] =>
  all.filter((c) => /max\(/i.test(c.sql) && /events_raw/.test(c.sql));

/**
 * The recent-dispatches reads. Today's full-table form has no ORDER BY (it sorts
 * in JS), so it is recognised by selecting every dispatches column.
 */
const dispatchStatements = (all: Captured[]): Captured[] =>
  all.filter((c) =>
    /^select "event_id", "session_id", "ts".*"parent_prompt_id".* from "dispatches"/is.test(c.sql),
  );

function dispatchLine(
  session: string,
  i: number,
  ts: string,
  project: string | undefined,
  task: number,
): string {
  return `${JSON.stringify({
    session_id: session,
    actor: 'orchestrator',
    event_type: 'dispatch_decision',
    plan_version: 1,
    causal_parent: `${session}#0`,
    payload: { agent_role: 'coder', provider: 'claude', model_tier: 'mid', note: `d${i}` },
    task_id: `epic-a/task-${task}`,
    ...(project === undefined ? {} : { project }),
    ts,
  })}\n`;
}

function startLine(session: string): string {
  return `${JSON.stringify({
    session_id: session,
    actor: 'user',
    event_type: 'session-start',
    plan_version: 1,
    causal_parent: null,
    payload: {},
    ts: new Date(BASE - 1000).toISOString(),
  })}\n`;
}

/** Stores a body per session and rebuilds a database from them. */
async function storeOf(
  bodies: Record<string, string>,
): Promise<{ handle: DbHandle; dirs: string[] }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'smith-ovplan-events-'));
  const dbDir = await mkdtemp(path.join(tmpdir(), 'smith-ovplan-db-'));
  for (const [session, body] of Object.entries(bodies)) {
    await appendFile(path.join(stateDir, `${session}.jsonl`), body, 'utf8');
  }
  const dbPath = path.join(dbDir, 'smith.db');
  await rebuild(dbPath, 'all', { stateDir });
  return { handle: openDb(dbPath), dirs: [stateDir, dbDir] };
}

/**
 * n dispatches over two sessions, TIE_SIZE sharing each ts. Projects cycle
 * through project-a, project-b and an untagged row (default project), at a
 * period that does not line up with the session split.
 */
function bulkBodies(n: number): Record<string, string> {
  const bodies: Record<string, string> = {};
  for (const s of SESSIONS) bodies[s] = startLine(s);
  const projects = ['project-a', 'project-b', undefined];
  for (let i = 0; i < n; i += 1) {
    const session = SESSIONS[i % 2] as string;
    const ts = new Date(BASE + Math.floor(i / TIE_SIZE) * 1000).toISOString();
    bodies[session] += dispatchLine(session, i, ts, projects[i % 3], i % 50);
  }
  return bodies;
}

async function drop(s: { handle: DbHandle; dirs: string[] } | undefined): Promise<void> {
  s?.handle.sqlite.close();
  for (const d of s?.dirs ?? []) await rm(d, { recursive: true, force: true });
}

describe('overview() and runningSessions() indexed reads', () => {
  let small: { handle: DbHandle; dirs: string[] };
  let large: { handle: DbHandle; dirs: string[] };

  beforeAll(async () => {
    small = await storeOf(bulkBodies(SMALL));
    large = await storeOf(bulkBodies(SMALL * 10));
  }, 180_000);

  afterAll(async () => {
    await drop(small);
    await drop(large);
  });

  const eventScopes: [string, Scope][] = [
    ['unscoped', {}],
    ['one session', { sessionId: SESSIONS[0] }],
    ['a session list', { sessionIds: SESSIONS }],
  ];
  for (const [name, scope] of eventScopes) {
    it(`reads the newest event per session by index lookup (${name})`, () => {
      const stmts = newestEventStatements(
        capture(small.handle, () => runningSessions(small.handle.db, scope)),
      );
      expect(stmts.length).toBeGreaterThan(0);
      for (const stmt of stmts) {
        const detail = plan(small.handle, stmt);
        expect(detail, stmt.sql).not.toMatch(/SCAN events_raw/);
        expect(detail, stmt.sql).not.toMatch(/SCAN e\b/);
        expect(detail, stmt.sql).not.toMatch(/TEMP B-TREE/);
        expect(detail, stmt.sql).toMatch(/events_raw_session_ts_idx \(session_id=\? AND ts=\?\)/);
      }
    });
  }

  it('returns the newest event per session, whatever the history size', () => {
    for (const s of [small, large]) {
      const rows = runningSessions(s.handle.db, {});
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.lastEventType === 'dispatch_decision')).toBe(true);
    }
  });

  const dispatchScopes: [string, Scope, number][] = [
    ['unscoped', {}, 1],
    ['a project', { project: 'project-a' }, 1],
    ['the default project', { project: 'blacksmith' }, 1],
    ['one session', { sessionId: SESSIONS[0] }, 1],
    ['a session list', { sessionIds: SESSIONS }, 2],
    ['a session list and a project', { sessionIds: SESSIONS, project: 'project-b' }, 2],
  ];
  for (const [name, scope] of dispatchScopes) {
    it(`reads the recent dispatches by index, never a table scan (${name})`, () => {
      const stmts = dispatchStatements(
        capture(small.handle, () => overview(small.handle.db, scope)),
      );
      expect(stmts.length).toBeGreaterThan(0);
      for (const stmt of stmts) {
        const detail = plan(small.handle, stmt);
        expect(detail, stmt.sql).not.toMatch(/SCAN dispatches/);
        expect(detail, stmt.sql).not.toMatch(/TEMP B-TREE/);
        expect(detail, stmt.sql).toMatch(/dispatches_(ts|project_ts|session_ts)_idx/);
      }
    });

    it(`reads the same number of dispatch rows at N and 10N (${name})`, () => {
      const count = (s: { handle: DbHandle }) =>
        dispatchStatements(capture(s.handle, () => overview(s.handle.db, scope))).reduce(
          (sum, c) => sum + c.rows,
          0,
        );
      const a = count(small);
      expect(count(large)).toBe(a);
      // Per source: the limit plus the probe row, plus one tie group; a source
      // pages on only when the project filter drops rows (at most a few pages here).
      expect(a).toBeLessThanOrEqual(3 * (LIMIT + 1 + TIE_SIZE) * 2);
      expect(a).toBeLessThan(SMALL / 4);
    });
  }
});

/** The newest ten, computed from every dispatch row the slow way. */
function expectedRecent(handle: DbHandle, scope: Scope): string[] {
  const rows = handle.sqlite
    .prepare('select event_id, session_id, ts, project from dispatches')
    .all() as { event_id: string; session_id: string; ts: string; project: string | null }[];
  const index = (id: string) => Number(id.slice(id.lastIndexOf('#') + 1));
  return rows
    .filter((r) => {
      const ids =
        scope.sessionIds ?? (scope.sessionId === undefined ? undefined : [scope.sessionId]);
      if (ids !== undefined && !ids.includes(r.session_id)) return false;
      if (scope.project !== undefined && (r.project ?? 'blacksmith') !== scope.project) {
        return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0) ||
        (a.session_id < b.session_id ? 1 : a.session_id > b.session_id ? -1 : 0) ||
        index(b.event_id) - index(a.event_id),
    )
    .slice(0, LIMIT)
    .map((r) => r.event_id);
}

describe('recent dispatches keep the log-order tie-break', () => {
  let store: { handle: DbHandle; dirs: string[] };

  beforeAll(async () => {
    // A burst of 27 dispatches in one millisecond, split over two sessions and
    // three project spellings, newer than a tail of distinct older ones: the
    // burst alone straddles the limit, so the tie-group read is exercised.
    const bodies: Record<string, string> = {};
    for (const s of SESSIONS) bodies[s] = startLine(s);
    const projects = ['project-a', 'project-b', undefined];
    for (let i = 0; i < 8; i += 1) {
      const session = SESSIONS[i % 2] as string;
      const ts = new Date(BASE + i * 1000).toISOString();
      bodies[session] += dispatchLine(session, i, ts, projects[i % 3], i);
    }
    const burstTs = new Date(BASE + 60_000).toISOString();
    for (let i = 0; i < 27; i += 1) {
      const session = SESSIONS[(i >> 1) % 2] as string;
      bodies[session] += dispatchLine(session, 100 + i, burstTs, projects[i % 3], 100 + i);
    }
    store = await storeOf(bodies);
  }, 60_000);

  afterAll(async () => {
    await drop(store);
  });

  const scopes: [string, Scope][] = [
    ['none', {}],
    ['project', { project: 'project-a' }],
    ['the default project', { project: 'blacksmith' }],
    ['sessionId', { sessionId: SESSIONS[1] }],
    ['sessionIds', { sessionIds: SESSIONS }],
    ['sessionIds and project', { sessionIds: SESSIONS, project: 'project-b' }],
    ['sessionId and project', { sessionId: SESSIONS[0], project: 'project-a' }],
  ];
  for (const [name, scope] of scopes) {
    it(`yields the newest ten in log order for scope ${name}`, () => {
      const got = overview(store.handle.db, scope).recentDispatches.map((d) => d.eventId);
      expect(got).toEqual(expectedRecent(store.handle, scope));
      // A session holds only some of the project's rows, so a project scope can come up short.
      if (scope.project === undefined) expect(got).toHaveLength(LIMIT);
      else expect(got.length).toBeGreaterThan(0);
    });
  }

  it('pages past a boundary tie group the project filter empties', () => {
    // Only five of the burst's rows in this session are project-a, so the first
    // page (all burst) leaves the filter short and the read has to page on
    // with ts < cursor into the older rows.
    const got = overview(store.handle.db, { sessionId: SESSIONS[0], project: 'project-a' });
    expect(got.recentDispatches.map((d) => d.eventId)).toEqual(
      expectedRecent(store.handle, { sessionId: SESSIONS[0], project: 'project-a' }),
    );
  });
});

describe('migration 0019', () => {
  const names = (h: DbHandle) =>
    (
      h.sqlite
        .prepare("select name from sqlite_master where type = 'index' and tbl_name = 'dispatches'")
        .all() as { name: string }[]
    ).map((r) => r.name);
  const added = ['dispatches_ts_idx', 'dispatches_project_ts_idx', 'dispatches_session_ts_idx'];

  it('creates the dispatch indexes on a fresh store', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smith-ovplan-fresh-'));
    try {
      const fresh = openDb(path.join(dir, 'smith.db'));
      expect(names(fresh)).toEqual(expect.arrayContaining(added));
      fresh.sqlite.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds the dispatch indexes to a store migrated to 0018', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smith-ovplan-mig-'));
    try {
      const journal = JSON.parse(
        await readFile(path.join(DB_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
      ) as { entries: { idx: number; tag: string }[] };
      const kept = journal.entries.filter((e) => e.idx <= 18);
      expect(kept.length).toBe(19);
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
      expect(names(pre)).not.toContain('dispatches_ts_idx');
      pre.sqlite.close();

      const post = openDb(dbPath);
      expect(names(post)).toEqual(expect.arrayContaining(added));
      post.sqlite.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
