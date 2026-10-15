// One Home poll reads the overview of every store through several routes. They
// share one projection-stage computation per store for as long as the store's
// projection has not advanced; the clock stage runs on every request.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { overviewProjection } from '../../../factory/orchestrator/dist/db/queries.js';
import { rebuild } from '../../../factory/orchestrator/src/db/projector.js';
import { appendEvent, readEvents } from '../../../factory/orchestrator/src/events.js';
import { buildFixture, SESSION_ID } from '../../../factory/orchestrator/test/db/fixtures.js';
import { type AppHandle, createApp } from '../src/app.js';

// A pass-through: the real projection stage runs, and every call is counted.
vi.mock('../../../factory/orchestrator/dist/db/queries.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../factory/orchestrator/dist/db/queries.js')>();
  return { ...real, overviewProjection: vi.fn(real.overviewProjection) };
});

const POLL_MS = 5000;
const clockFields = (o: Record<string, unknown>) => ({
  working: o.workingAgentCount,
  stalled: o.stalledAgentCount,
  deltas: [o.liveAgentCountDelta5m, o.workingAgentCountDelta5m],
});

describe('overview shared per projection state', () => {
  let tmp: string;
  let eventsA: string;
  let handle: AppHandle;

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
    handle = createApp({
      dbPath,
      stateDir: eventsA,
      roadmapPath: path.join(projectA, 'roadmap.md'),
      claudeConfigDir: config,
      cliIsAlive: () => true,
      storeRefreshMs: 0,
    });
    vi.mocked(overviewProjection).mockClear();
  });

  afterEach(async () => {
    handle.closeStream();
    await rm(tmp, { recursive: true, force: true });
  });

  /** One Home poll; the stores the projection stage ran on, in call order. */
  async function poll(): Promise<unknown[]> {
    vi.mocked(overviewProjection).mockClear();
    expect((await handle.app.request('/api/active-scope')).status).toBe(200);
    expect((await handle.app.request('/api/overview')).status).toBe(200);
    return vi.mocked(overviewProjection).mock.calls.map(([db]) => db);
  }

  it('computes the projection once per store for one Home poll', async () => {
    const dbs = await poll();
    expect(dbs).toHaveLength(2);
    expect(new Set(dbs).size).toBe(2);
  });

  it('serves a repeat poll with no new events without recomputing', async () => {
    await poll();
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

  it('does not recompute after PULSE_POLL_MS, while the clock fields follow the new clock', async () => {
    // One dispatch 2 s inside the 5 min window of the first clock, 3 s outside it at the next.
    const start = Date.now();
    const line = (n: number, record: Record<string, unknown>) =>
      `${JSON.stringify({
        session_id: 'sess-clock',
        actor: 'system',
        plan_version: 1,
        causal_parent: n === 0 ? null : `sess-clock#${n - 1}`,
        payload: {},
        ...record,
      })}\n`;
    await writeFile(
      path.join(eventsA, 'sess-clock.jsonl'),
      line(0, { event_type: 'session-start', ts: new Date(start - 6 * 60_000).toISOString() }) +
        line(1, {
          event_type: 'dispatch_decision',
          task_id: 'epic-1/task-1',
          project: 'project-a',
          ts: new Date(start - 5 * 60_000 + 2_000).toISOString(),
          payload: { agent_role: 'coder', provider: 'claude', model_tier: 'mid', model: 'm' },
        }),
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(start);
      const first = (await (await handle.app.request('/api/overview')).json()) as Record<
        string,
        unknown
      >;
      await poll();
      vi.setSystemTime(start + POLL_MS);
      expect(await poll()).toHaveLength(0);
      const second = (await (await handle.app.request('/api/overview')).json()) as Record<
        string,
        unknown
      >;
      expect(vi.mocked(overviewProjection)).not.toHaveBeenCalled();
      expect(clockFields(second)).not.toEqual(clockFields(first));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps different scopes apart', async () => {
    await poll();
    vi.mocked(overviewProjection).mockClear();
    const res = await handle.app.request('/api/overview?project=project-b');
    expect(res.status).toBe(200);
    expect(vi.mocked(overviewProjection).mock.calls.length).toBeGreaterThan(0);
  });
});
