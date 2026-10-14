// One Home poll is GET /api/active-scope then GET /api/overview, and both read
// overview() of every store. The two share one computation per store for as
// long as the store's projection has not advanced and the bound has not passed.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { overview } from '../../../factory/orchestrator/dist/db/queries.js';
import { rebuild } from '../../../factory/orchestrator/src/db/projector.js';
import { appendEvent, readEvents } from '../../../factory/orchestrator/src/events.js';
import { buildFixture, SESSION_ID } from '../../../factory/orchestrator/test/db/fixtures.js';
import { type AppHandle, createApp } from '../src/app.js';

// A pass-through: the real overview() runs, and every call is counted.
vi.mock('../../../factory/orchestrator/dist/db/queries.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../factory/orchestrator/dist/db/queries.js')>();
  return { ...real, overview: vi.fn(real.overview) };
});

const BOUND_MS = 4000;

describe('overview shared per projection state', () => {
  let tmp: string;
  let eventsA: string;
  let handle: AppHandle;
  let now: number;

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-overview-shared-')));
    const projectA = path.join(tmp, 'project-a');
    const projectB = path.join(tmp, 'project-b');
    const config = path.join(tmp, 'config');
    eventsA = path.join(projectA, 'state', 'events');
    const eventsB = path.join(projectB, '.blacksmith', 'state', 'events');
    await mkdir(path.join(projectA, '.git'), { recursive: true });
    await mkdir(path.join(projectB, '.git'), { recursive: true });
    await mkdir(path.join(projectB, 'src'), { recursive: true });
    await mkdir(path.join(config, 'sessions'), { recursive: true });
    await mkdir(eventsB, { recursive: true });
    await buildFixture({ stateDir: eventsA });
    await buildFixture({ stateDir: eventsB });
    await writeFile(path.join(projectA, 'roadmap.md'), '');
    const dbPath = path.join(projectA, 'state', 'smith.db');
    await rebuild(dbPath, 'all', {
      stateDir: eventsA,
      roadmapPath: path.join(projectA, 'roadmap.md'),
    });
    await writeFile(
      path.join(config, 'sessions', '4001.json'),
      JSON.stringify({
        pid: 4001,
        sessionId: '11111114-1111-4111-8111-111111111111',
        cwd: path.join(projectB, 'src'),
        kind: 'interactive',
        status: 'busy',
      }),
    );
    now = 1_000_000;
    handle = createApp({
      dbPath,
      stateDir: eventsA,
      roadmapPath: path.join(projectA, 'roadmap.md'),
      claudeConfigDir: config,
      cliIsAlive: () => true,
      storeRefreshMs: 0,
      overviewMemo: { maxAgeMs: BOUND_MS, now: () => now },
    });
    vi.mocked(overview).mockClear();
  });

  afterEach(async () => {
    handle.closeStream();
    await rm(tmp, { recursive: true, force: true });
  });

  /** One Home poll; the stores overview() was called on, in call order. */
  async function poll(): Promise<unknown[]> {
    vi.mocked(overview).mockClear();
    expect((await handle.app.request('/api/active-scope')).status).toBe(200);
    expect((await handle.app.request('/api/overview')).status).toBe(200);
    return vi.mocked(overview).mock.calls.map(([db]) => db);
  }

  it('computes overview() once per store for one Home poll', async () => {
    const dbs = await poll();
    expect(dbs).toHaveLength(2);
    expect(new Set(dbs).size).toBe(2);
  });

  it('serves a repeat poll with no new events and inside the bound without recomputing', async () => {
    await poll();
    now += BOUND_MS - 1;
    expect(await poll()).toHaveLength(0);
  });

  it('recomputes only the store whose projection advanced', async () => {
    await poll();
    const events = await readEvents(SESSION_ID, { stateDir: eventsA });
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'user',
        event_type: 'operator-note',
        plan_version: 1,
        causal_parent: events.at(-1)?.event_id ?? null,
        payload: { note: 'one more' },
      },
      { stateDir: eventsA },
    );
    expect(await poll()).toHaveLength(1);
  });

  it('recomputes each store once the bound has passed', async () => {
    await poll();
    now += BOUND_MS;
    const dbs = await poll();
    expect(dbs).toHaveLength(2);
    expect(new Set(dbs).size).toBe(2);
  });

  it('keeps different scopes apart', async () => {
    await poll();
    vi.mocked(overview).mockClear();
    const res = await handle.app.request('/api/overview?project=project-b');
    expect(res.status).toBe(200);
    expect(vi.mocked(overview).mock.calls.length).toBeGreaterThan(0);
  });
});
