import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DbHandle, openDb, rebuild } from '../../src/db/projector.js';
import { cliSessionLinks } from '../../src/db/queries.js';
import * as schema from '../../src/db/schema.js';
import { appendEvent, type EventOpts, readEvents, startSession } from '../../src/events.js';
import { buildFixture } from './fixtures.js';

/**
 * `cli_session_id` on the projection: which CLI session wrote each event, so
 * a live CLI session can be linked to the factory sessions it drove. The
 * column is derived from the log like every other one -- an old log, written
 * before the stamp existed, rebuilds with NULL there and nothing else moved.
 */
const CLI_A = '0f3c9a52-6b1e-4d7a-9c2f-5e8d1a2b3c4d';
const CLI_B = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** Every table db/schema.ts declares, discovered rather than listed. */
function allRows(db: DbHandle['db']): Record<string, Record<string, unknown>[]> {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const [name, table] of Object.entries(schema)) {
    if (!is(table, SQLiteTable)) continue;
    rows[name] = db.select().from(table).all() as Record<string, unknown>[];
  }
  return rows;
}

/**
 * The same log with `cli_session_id` added to every line and nothing else
 * touched -- same ts, same payload -- so two rebuilds can differ only by
 * what the stamp itself projects.
 */
async function stampedCopy(fromDir: string, toDir: string, cliId: string): Promise<void> {
  await mkdir(toDir, { recursive: true });
  for (const name of await readdir(fromDir)) {
    const text = await readFile(path.join(fromDir, name), 'utf8');
    if (!name.endsWith('.jsonl')) {
      await writeFile(path.join(toDir, name), text);
      continue;
    }
    const lines = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.stringify({ ...JSON.parse(line), cli_session_id: cliId }));
    await writeFile(path.join(toDir, name), `${lines.join('\n')}\n`);
  }
}

describe('events_raw.cli_session_id', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'smith-cli-session-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('an old log rebuilds with NULL, and stamping it changes that column and nothing else', async () => {
    const oldLog = path.join(scratch, 'old');
    const stampedLog = path.join(scratch, 'stamped');
    // The old log is written as it was before the stamp existed: no key at all.
    await buildFixture({ stateDir: oldLog, cliSessionId: null });
    for (const { record } of await readEvents('sess-fixture', { stateDir: oldLog })) {
      expect(record).not.toHaveProperty('cli_session_id');
    }
    await stampedCopy(oldLog, stampedLog, CLI_A);

    const oldDb = path.join(scratch, 'old.db');
    const stampedDb = path.join(scratch, 'stamped.db');
    await rebuild(oldDb, 'all', { stateDir: oldLog });
    await rebuild(stampedDb, 'all', { stateDir: stampedLog });

    const oldHandle = openDb(oldDb);
    const stampedHandle = openDb(stampedDb);
    try {
      const { eventsRaw: rawBefore = [], ...otherBefore } = allRows(oldHandle.db);
      const { eventsRaw: rawAfter = [], ...otherAfter } = allRows(stampedHandle.db);

      expect(rawBefore.length).toBeGreaterThan(0);
      expect(rawBefore.every((row) => row.cliSessionId === null)).toBe(true);
      expect(rawAfter.every((row) => row.cliSessionId === CLI_A)).toBe(true);

      const withoutStamp = (rows: Record<string, unknown>[]) =>
        rows.map(({ cliSessionId: _ignored, ...rest }) => rest);
      expect(withoutStamp(rawAfter)).toEqual(withoutStamp(rawBefore));

      expect(otherAfter).toEqual(otherBefore);
    } finally {
      oldHandle.sqlite.close();
      stampedHandle.sqlite.close();
    }
  });

  describe('cliSessionLinks()', () => {
    const S1 = 'cli-link-s1';
    const S2 = 'cli-link-s2';
    const S3 = 'cli-link-s3';
    const S4 = 'cli-link-s4';
    let stateDir: string;
    let handle: DbHandle;

    async function dispatch(session: string, cliSessionId: string | null): Promise<void> {
      const events = await readEvents(session, { stateDir });
      await appendEvent(
        {
          session_id: session,
          actor: 'orchestrator',
          event_type: 'dispatch_decision',
          agent_id: `${session}-agent-${events.length}`,
          plan_version: 1,
          causal_parent: `${session}#0`,
          payload: {
            agent_role: 'coder',
            provider: 'claude',
            model_tier: 'mid',
            model: 'claude-sonnet-5',
          },
        },
        { stateDir, cliSessionId },
      );
    }

    /** The newest ts among `session`'s events stamped with `cliId`, read off the log. */
    async function lastStampedTs(session: string, cliId: string): Promise<string> {
      const stamped = (await readEvents(session, { stateDir })).filter(
        (e) => e.record.cli_session_id === cliId,
      );
      return stamped.map((e) => e.record.ts).sort()[stamped.length - 1] as string;
    }

    beforeEach(async () => {
      stateDir = path.join(scratch, 'events');
      const opts = (cliSessionId: string | null): EventOpts => ({ stateDir, cliSessionId });

      // CLI A opens S1 and drives it.
      await startSession(S1, opts(CLI_A));
      await dispatch(S1, CLI_A);
      // CLI A opens S2 as S1's continuation; CLI B picks it up later.
      await startSession(S2, { ...opts(CLI_A), continues: `${S1}#0` });
      await dispatch(S2, CLI_B);
      await dispatch(S2, CLI_B);
      // CLI B alone drives S3.
      await startSession(S3, opts(CLI_B));
      await dispatch(S3, CLI_B);
      // S4 was written outside any CLI session: it links to nothing.
      await startSession(S4, opts(null));
      await dispatch(S4, null);

      const dbPath = path.join(scratch, 'links.db');
      await rebuild(dbPath, 'all', { stateDir });
      handle = openDb(dbPath);
    });

    afterEach(() => {
      handle.sqlite.close();
    });

    it('answers one row per (CLI session, factory session) with the newest stamped event', async () => {
      const links = cliSessionLinks(handle.db, [CLI_A, CLI_B]);
      expect(links).toEqual([
        { cliSessionId: CLI_A, sessionId: S1, lastEventAt: await lastStampedTs(S1, CLI_A) },
        { cliSessionId: CLI_A, sessionId: S2, lastEventAt: await lastStampedTs(S2, CLI_A) },
        { cliSessionId: CLI_B, sessionId: S2, lastEventAt: await lastStampedTs(S2, CLI_B) },
        { cliSessionId: CLI_B, sessionId: S3, lastEventAt: await lastStampedTs(S3, CLI_B) },
      ]);
    });

    it('answers only for the CLI ids asked about', async () => {
      expect(cliSessionLinks(handle.db, [CLI_B]).map((l) => l.sessionId)).toEqual([S2, S3]);
    });

    it('answers nothing for no ids, or for an id that never wrote', () => {
      expect(cliSessionLinks(handle.db, [])).toEqual([]);
      expect(cliSessionLinks(handle.db, ['ffffffff-0000-4000-8000-000000000000'])).toEqual([]);
    });

    it('never links an unstamped session', () => {
      const linked = cliSessionLinks(handle.db, [CLI_A, CLI_B]).map((l) => l.sessionId);
      expect(linked).not.toContain(S4);
    });
  });
});
