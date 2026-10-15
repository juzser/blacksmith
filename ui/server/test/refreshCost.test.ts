// The dashboard refresher's cost and lifecycle: one projection handle per
// refresher, each scan applies its changed sessions in one batch, and stop()
// ends the handle without a batch starting afterwards.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Projection } from '../../../factory/orchestrator/dist/db/projector.js';
import { appendEvent } from '../../../factory/orchestrator/src/events.js';
import { type AppHandle, closeApp, createApp } from '../src/app.js';

interface Gate {
  entered: Promise<void>;
  enter: () => void;
  released: Promise<void>;
  release: () => void;
  used: boolean;
}

interface HandleRecord {
  dbPath: string;
  batches: string[][];
  closes: number;
  /** Per delegation to the real function: was this handle already closed? */
  delegations: boolean[];
}

const rec = vi.hoisted(() => ({
  jsonlReads: 0,
  readdirs: [] as string[],
  handles: [] as HandleRecord[],
  /** Projection calls (applySessions, or apply under the old per-session loop). */
  calls: 0,
  gate: null as Gate | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: ((...args: Parameters<typeof real.readFile>) => {
      if (String(args[0]).endsWith('.jsonl')) rec.jsonlReads += 1;
      return real.readFile(...args);
    }) as typeof real.readFile,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readdirSync: ((...args: Parameters<typeof real.readdirSync>) => {
      rec.readdirs.push(String(args[0]));
      return real.readdirSync(...args);
    }) as typeof real.readdirSync,
  };
});

async function passGate(): Promise<void> {
  const gate = rec.gate;
  if (!gate || gate.used) return;
  gate.used = true;
  gate.enter();
  await gate.released;
}

vi.mock('../../../factory/orchestrator/dist/db/projector.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../factory/orchestrator/dist/db/projector.js')>();
  return {
    ...real,
    openProjection: (dbPath: string, opts: Parameters<typeof real.openProjection>[1]) => {
      const inner = real.openProjection(dbPath, opts);
      const record: HandleRecord = { dbPath, batches: [], closes: 0, delegations: [] };
      rec.handles.push(record);
      const wrapped: Projection = {
        async applySessions(ids) {
          rec.calls += 1;
          record.batches.push([...ids]);
          await passGate();
          record.delegations.push(record.closes > 0);
          return inner.applySessions(ids);
        },
        close() {
          record.closes += 1;
          inner.close();
        },
      };
      return wrapped;
    },
    apply: async (...args: Parameters<typeof real.apply>) => {
      rec.calls += 1;
      await passGate();
      return real.apply(...args);
    },
  };
});

function newGate(): Gate {
  let enter: () => void = () => {};
  let release: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, enter, released, release, used: false };
}

async function seed(eventsDir: string, sessionId: string): Promise<void> {
  await appendEvent(
    {
      session_id: sessionId,
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    },
    { stateDir: eventsDir },
  );
}

describe('dashboard refresher cost and lifecycle', () => {
  let tmp: string;
  let eventsDir: string;
  let dbPath: string;
  let app: AppHandle | null;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'bs-refresh-cost-'));
    eventsDir = path.join(tmp, 'state', 'events');
    mkdirSync(eventsDir, { recursive: true });
    dbPath = path.join(tmp, 'state', 'smith.db');
    app = null;
    rec.jsonlReads = 0;
    rec.readdirs = [];
    rec.handles = [];
    rec.calls = 0;
    rec.gate = null;
  });

  afterEach(() => {
    if (app) closeApp(app);
    rmSync(tmp, { recursive: true, force: true });
  });

  function open(stores: string[] = []): AppHandle {
    app = createApp({ dbPath, stateDir: eventsDir, stores, storeRefreshMs: 0 });
    return app;
  }

  async function pulse(a: AppHandle): Promise<{ projectionIssues: { kind: string }[] }> {
    const res = await a.app.request('/api/pulse');
    expect(res.status).toBe(200);
    return res.json() as Promise<{ projectionIssues: { kind: string }[] }>;
  }

  it('a cold scan reads each log once, and a one-event append costs one read', async () => {
    const N = 20;
    for (let i = 0; i < N; i += 1) await seed(eventsDir, `session-${String(i).padStart(2, '0')}`);
    const a = open();
    rec.jsonlReads = 0;
    await pulse(a);
    console.log(`cold scan: ${rec.jsonlReads} log reads for ${N} sessions`);
    expect(rec.jsonlReads).toBe(N);

    await seed(eventsDir, 'session-07');
    rec.jsonlReads = 0;
    await pulse(a);
    console.log(`second scan: ${rec.jsonlReads} log reads`);
    expect(rec.jsonlReads).toBe(1);
  });

  it('a malformed session keeps its issue entry while the others advance', async () => {
    for (const id of ['session-a', 'session-b', 'session-c']) await seed(eventsDir, id);
    writeFileSync(path.join(eventsDir, 'session-bad.jsonl'), 'this is not json\n');
    const a = open();
    const body = await pulse(a);
    expect(body.projectionIssues.map((i) => i.kind)).toEqual(['session-not-projected']);
    const projected = a.handle.sqlite
      .prepare('SELECT DISTINCT session_id AS id FROM events_raw ORDER BY id')
      .all() as { id: string }[];
    expect(projected.map((r) => r.id)).toEqual(['session-a', 'session-b', 'session-c']);
  });

  describe('handle lifecycle', () => {
    let extraA: string;
    let extraB: string;

    beforeEach(async () => {
      extraA = path.join(tmp, 'store-a');
      extraB = path.join(tmp, 'store-b');
      for (const [dir, id] of [
        [extraA, 'sess-a'],
        [extraB, 'sess-b'],
      ] as const) {
        mkdirSync(path.join(dir, 'state', 'events'), { recursive: true });
        await seed(path.join(dir, 'state', 'events'), id);
      }
      await seed(eventsDir, 'sess-home');
    });

    it('(a) opens one handle per store on distinct paths, none shared between refreshers', async () => {
      const a = open([extraA, extraB]);
      await pulse(a);
      console.log(`handles opened: ${rec.handles.length}`);
      expect(rec.handles).toHaveLength(3);
      expect(new Set(rec.handles.map((h) => h.dbPath)).size).toBe(3);
      const applied = rec.handles.map((h) => h.batches.flat().sort());
      expect(applied.flat().sort()).toEqual(['sess-a', 'sess-b', 'sess-home']);
      for (const batch of applied) expect(batch).toHaveLength(1);
    });

    it('(b) stop() closes the handle once, and closeApp closes all three', async () => {
      const a = open([extraA, extraB]);
      await pulse(a);
      a.closeStream();
      a.closeStream();
      console.log(`closes after stop: ${rec.handles.map((h) => h.closes).join(',')}`);
      expect(rec.handles).toHaveLength(3);
      expect(rec.handles.map((h) => h.closes)).toEqual([1, 1, 1]);
      closeApp(a);
      app = null;
      expect(rec.handles.map((h) => h.closes)).toEqual([1, 1, 1]);
    });

    it('(c) refresh() after stop() neither scans nor applies', async () => {
      const a = open();
      await pulse(a);
      a.closeStream();
      appendFileSync(path.join(eventsDir, 'sess-home.jsonl'), '\n');
      await seed(eventsDir, 'sess-late');
      rec.readdirs = [];
      rec.calls = 0;
      expect((await a.app.request('/api/pulse')).status).toBe(200);
      const scans = rec.readdirs.filter((d) => d === eventsDir).length;
      console.log(`after stop: ${scans} readdir, ${rec.calls} apply`);
      expect(scans).toBe(0);
      expect(rec.calls).toBe(0);
    });

    it('(d) stop() during a running scan ends it cleanly', async () => {
      for (const id of ['sess-home-2', 'sess-home-3']) await seed(eventsDir, id);
      const a = open();
      rec.gate = newGate();
      const gate = rec.gate;
      const first = Promise.resolve(a.app.request('/api/pulse'));
      await gate.entered;
      const before = rec.calls;
      a.closeStream();
      const closesWhileHeld = rec.handles.map((h) => h.closes);
      gate.release();
      const res = await first;
      expect(res.status).toBe(200);
      const after = rec.calls - before;
      const home = rec.handles[0];
      const body = await pulse(a);
      console.log(
        `after stop: ${after} calls, ${rec.handles.flatMap((h) => h.delegations).filter(Boolean).length} to a closed handle, ${home?.closes ?? 0} close(s)`,
      );
      expect(closesWhileHeld.every((n) => n === 0)).toBe(true);
      expect(after).toBe(0);
      expect(rec.handles.flatMap((h) => h.delegations).filter(Boolean)).toHaveLength(0);
      expect(home?.closes).toBe(1);
      expect(body.projectionIssues.filter((i) => i.kind === 'session-not-projected')).toEqual([]);
    });
  });
});
