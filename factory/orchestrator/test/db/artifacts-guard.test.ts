import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, rebuild } from '../../src/db/projector.js';
import * as schema from '../../src/db/schema.js';
import { appendEvent } from '../../src/events.js';

// ---------------------------------------------------------------------------
// The projector's contract is "never throws: a bad record is logged and
// skipped". A task-result-recorded whose `artifacts` is an object (a worker
// keyed them by name, which result.schema.json forbids but the log accepted)
// used to throw `(p.artifacts ?? []).forEach is not a function` out of the
// transaction, so every event after it in the session vanished from the DB
// and the UI server printed "could not project session" once per fingerprint
// while its rows sat stale. Skipping only the malformed artifact list keeps
// the rest of the session folding.
//
// Two things about this test are deliberate and easy to "fix" wrongly:
//
//   - The bad record goes straight to the .jsonl, not through `appendEvent`.
//     The write-time guard refuses this shape now (events.ts,
//     `validateResultArtifactsShape`), so the only way it reaches a
//     projection is out of a log written before that guard existed — which
//     is exactly the log this exists to keep readable.
//   - The skip is *reported*, not printed. The projector is a library: it
//     returns `skippedArtifacts`, the same contract `skippedFindings` has
//     had since D-141, and `ui/server/src/app.ts` — the one caller with an
//     operator in front of it — writes the stderr line, once per event id
//     (D-248). A `console.error` back here would print once per poll for as
//     long as the log stayed broken, so the silence is asserted too.
// ---------------------------------------------------------------------------
describe('projector — task-result-recorded with a non-array artifacts field', () => {
  let stateDir: string;
  let dbDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-artifacts-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-artifacts-db-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('skips the malformed list, reports it once, and keeps folding the events after it', async () => {
    const sessionId = 'sess-artifacts';
    const opts = { stateDir };
    const root = await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      opts,
    );
    // Event index 1, written by hand because no writer will accept it today.
    const badEventId = `${sessionId}#1`;
    await appendFile(
      path.join(stateDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        event_id: badEventId,
        session_id: sessionId,
        actor: 'agent',
        event_type: 'task-result-recorded',
        task_id: 'epic-3/task-1',
        plan_version: 1,
        causal_parent: root.event_id,
        ts: '2026-08-15T00:00:00.000Z',
        payload: {
          task_id: 'epic-3/task-1',
          agent: 'coder',
          run_status: 'done',
          // Keyed by name instead of listed — the shape that used to throw.
          artifacts: { diff: { type: 'diff', path: 'artifacts/task-1.diff' } },
        },
      })}\n`,
    );
    const good = await appendEvent(
      {
        session_id: sessionId,
        actor: 'agent',
        event_type: 'task-result-recorded',
        task_id: 'epic-3/task-2',
        plan_version: 1,
        causal_parent: badEventId,
        payload: {
          task_id: 'epic-3/task-2',
          agent: 'coder',
          run_status: 'done',
          artifacts: [{ type: 'diff', path: 'artifacts/task-2.diff' }],
        },
      },
      opts,
    );

    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dbPath = path.join(dbDir, 'smith.db');
    const result = await rebuild(dbPath, 'all', { stateDir });
    expect(result).toMatchObject({ sessionsProcessed: 1, eventsApplied: 3 });

    const handle = openDb(dbPath);
    const raw = handle.db.select().from(schema.eventsRaw).all();
    const artifacts = handle.db.select().from(schema.artifacts).all();
    handle.sqlite.close();

    // Every event landed — the one after the bad record included.
    expect(raw.map((r) => r.eventId)).toEqual([root.event_id, badEventId, good.event_id]);
    // Only the well-formed list produced artifact rows.
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ eventId: good.event_id, path: 'artifacts/task-2.diff' });
    // The skip is reported, once, naming the event it dropped and why.
    expect(result.skippedArtifacts).toEqual([
      expect.objectContaining({
        event_id: badEventId,
        session_id: sessionId,
        task_id: 'epic-3/task-1',
        reason: expect.stringContaining('not an array'),
      }),
    ]);
    // ...and reported is all it is. The caller decides whether an operator
    // hears about it; a projection run is not a place that has one.
    const printed = stderr.mock.calls.filter((c) => String(c[0]).includes(badEventId));
    expect(printed).toEqual([]);
  });
});
