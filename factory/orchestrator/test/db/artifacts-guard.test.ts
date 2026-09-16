import { mkdtemp, rm } from 'node:fs/promises';
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

  it('skips the malformed list, logs once, and keeps folding the events after it', async () => {
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
    const bad = await appendEvent(
      {
        session_id: sessionId,
        actor: 'agent',
        event_type: 'task-result-recorded',
        task_id: 'epic-3/task-1',
        plan_version: 1,
        causal_parent: root.event_id,
        payload: {
          task_id: 'epic-3/task-1',
          agent: 'coder',
          status: 'done',
          // Keyed by name instead of listed — the shape that used to throw.
          artifacts: { diff: { type: 'diff', path: 'artifacts/task-1.diff' } },
        },
      },
      opts,
    );
    const good = await appendEvent(
      {
        session_id: sessionId,
        actor: 'agent',
        event_type: 'task-result-recorded',
        task_id: 'epic-3/task-2',
        plan_version: 1,
        causal_parent: bad.event_id,
        payload: {
          task_id: 'epic-3/task-2',
          agent: 'coder',
          status: 'done',
          artifacts: [{ type: 'diff', path: 'artifacts/task-2.diff' }],
        },
      },
      opts,
    );

    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dbPath = path.join(dbDir, 'smith.db');
    await expect(rebuild(dbPath, 'all', { stateDir })).resolves.toMatchObject({
      sessionsProcessed: 1,
      eventsApplied: 3,
    });

    const handle = openDb(dbPath);
    const raw = handle.db.select().from(schema.eventsRaw).all();
    const artifacts = handle.db.select().from(schema.artifacts).all();
    handle.sqlite.close();

    // Every event landed — the one after the bad record included.
    expect(raw.map((r) => r.eventId)).toEqual([root.event_id, bad.event_id, good.event_id]);
    // Only the well-formed list produced artifact rows.
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ eventId: good.event_id, path: 'artifacts/task-2.diff' });
    // The skip is said out loud, once, naming the event it dropped.
    const skipLines = stderr.mock.calls.filter((c) => String(c[0]).includes(bad.event_id));
    expect(skipLines).toHaveLength(1);
  });
});
