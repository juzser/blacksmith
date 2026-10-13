import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pass-through spies: real behaviour, counted. The projector reads logs through
// events.ts (node:fs/promises readFile) and migrates through drizzle's migrator.
const counts = vi.hoisted(() => ({ jsonlReads: 0, migrations: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: ((file: unknown, ...rest: unknown[]) => {
      if (typeof file === 'string' && file.endsWith('.jsonl')) counts.jsonlReads += 1;
      return (actual.readFile as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.readFile,
  };
});

vi.mock('drizzle-orm/better-sqlite3/migrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm/better-sqlite3/migrator')>();
  return {
    ...actual,
    migrate: ((...args: Parameters<typeof actual.migrate>) => {
      counts.migrations += 1;
      return actual.migrate(...args);
    }) as typeof actual.migrate,
  };
});

import { apply, openDb, openProjection } from '../../src/db/projector.js';
import { appendEvent } from '../../src/events.js';

const N = 20;
const FOLDS = ['tasks', 'findings', 'lessons', 'feedback'];

async function startSession(stateDir: string, sessionId: string): Promise<string> {
  const e = await appendEvent(
    {
      session_id: sessionId,
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    },
    { stateDir },
  );
  return e.event_id;
}

describe('db/projector.ts — the cost of applying a batch of sessions', () => {
  let stateDir: string;
  let dbDir: string;
  let dbPath: string;
  let ids: string[];
  let roots: string[];
  let folds: string[];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-cost-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-cost-db-'));
    dbPath = path.join(dbDir, 'smith.db');
    ids = Array.from({ length: N }, (_, i) => `sess-${String(i).padStart(2, '0')}`);
    roots = [];
    for (const id of ids) roots.push(await startSession(stateDir, id));
    folds = [];
    counts.jsonlReads = 0;
    counts.migrations = 0;
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  async function appendOne(i: number): Promise<void> {
    await appendEvent(
      {
        session_id: ids[i] as string,
        actor: 'user',
        event_type: 'operator-note',
        plan_version: 1,
        causal_parent: roots[i] as string,
        payload: { note: 'tick' },
      },
      { stateDir },
    );
  }

  const opts = () => ({ stateDir, onFold: (name: string) => folds.push(name) });

  it('reads each log once on a cold batch, where per-session apply() reads N x N', async () => {
    for (const id of ids) await apply(dbPath, id, { stateDir });
    expect(counts.jsonlReads).toBe(N * N);

    counts.jsonlReads = 0;
    const projection = openProjection(dbPath, opts());
    try {
      await projection.applySessions(ids);
    } finally {
      projection.close();
    }
    expect(counts.jsonlReads).toBe(N);
  });

  it('re-reads only the changed log after a one-event append', async () => {
    const projection = openProjection(dbPath, opts());
    try {
      await projection.applySessions(ids);
      await appendOne(3);
      counts.jsonlReads = 0;
      await projection.applySessions([ids[3] as string]);
      expect(counts.jsonlReads).toBe(1);
    } finally {
      projection.close();
    }
  });

  it('migrates once per handle, however many batches it applies', async () => {
    const projection = openProjection(dbPath, opts());
    try {
      await projection.applySessions(ids);
      await projection.applySessions([ids[0] as string]);
    } finally {
      projection.close();
    }
    expect(counts.migrations).toBe(1);
  });

  it('runs each global fold once per batch', async () => {
    const projection = openProjection(dbPath, opts());
    try {
      await projection.applySessions(ids);
      expect([...folds].sort()).toEqual([...FOLDS].sort());
      folds.length = 0;
      await appendOne(7);
      await projection.applySessions([ids[7] as string]);
      expect([...folds].sort()).toEqual([...FOLDS].sort());
    } finally {
      projection.close();
    }
  });

  it('bounds the dashboard entry point: N reads on the cold scan, 1 after an append', async () => {
    const projection = openProjection(dbPath, opts());
    try {
      await projection.applySessions(ids);
      expect(counts.jsonlReads).toBeLessThanOrEqual(N);
      await appendOne(11);
      counts.jsonlReads = 0;
      await projection.applySessions([ids[11] as string]);
      expect(counts.jsonlReads).toBeLessThanOrEqual(1);
    } finally {
      projection.close();
    }
  });

  it('isolates a malformed session: it reports an error and the others project', async () => {
    await appendFile(path.join(stateDir, `${ids[5]}.jsonl`), 'this line is not an event\n');
    const projection = openProjection(dbPath, opts());
    let results: Awaited<ReturnType<typeof projection.applySessions>>;
    try {
      results = await projection.applySessions(ids);
    } finally {
      projection.close();
    }
    const failed = results.sessions.filter((s) => 'error' in s);
    expect(failed.map((s) => s.sessionId)).toEqual([ids[5]]);
    expect(results.sessions.filter((s) => !('error' in s))).toHaveLength(N - 1);
    const handle = openDb(dbPath);
    try {
      const rows = handle.sqlite.prepare('select session_id from sessions').all() as {
        session_id: string;
      }[];
      expect(rows).toHaveLength(N - 1);
    } finally {
      handle.sqlite.close();
    }
  });

  it('close() is idempotent', () => {
    const projection = openProjection(dbPath, opts());
    projection.close();
    expect(() => projection.close()).not.toThrow();
  });
});
