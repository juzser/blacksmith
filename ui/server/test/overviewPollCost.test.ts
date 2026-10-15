// What one Home poll costs the server once the projection is held: the repeat
// poll, one PULSE_POLL_MS later with nothing appended, must not recompute the
// projection stage, and what it does read must not grow with the history in
// the log. Proved by counts at N and 10N events, never by timing.
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { overviewProjection } from '../../../factory/orchestrator/dist/db/queries.js';
import { type AppHandle, createApp } from '../src/app.js';

// A pass-through: the real projection stage runs, and every call is counted.
vi.mock('../../../factory/orchestrator/dist/db/queries.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../factory/orchestrator/dist/db/queries.js')>();
  return { ...real, overviewProjection: vi.fn(real.overviewProjection) };
});

const NOW_MS = Date.parse('2026-08-04T12:00:00.000Z');
const POLL_MS = 5000;
const MIN = 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
const MARK = 'poll-marker';

type Rec = Record<string, unknown> & { event_type: string };

/** Writes one session log as raw records, one JSON object per line. */
class Log {
  private n = 0;
  constructor(
    readonly file: string,
    readonly session: string,
  ) {}
  push(record: Rec): void {
    const parent = this.n === 0 ? null : `${this.session}#${this.n - 1}`;
    this.n += 1;
    appendFileSync(
      this.file,
      `${JSON.stringify({
        session_id: this.session,
        actor: 'system',
        plan_version: 1,
        causal_parent: parent,
        payload: {},
        ...record,
      })}\n`,
    );
  }
}

function dispatch(log: Log, task: string, project: string, ts: string): void {
  log.push({
    event_type: 'dispatch_decision',
    task_id: task,
    project,
    ts,
    payload: { agent_role: 'coder', provider: 'claude', model_tier: 'mid', model: 'm' },
  });
}

function result(log: Log, task: string, project: string, ts: string, total = 100): void {
  log.push({
    event_type: 'task-result-recorded',
    task_id: task,
    project,
    ts,
    payload: { task_id: task, note: MARK, token_usage: { total_tokens: total } },
  });
}

/** `noise` old events plus a fixed recent tail, so N and 10N differ only in history. */
function load(log: Log, noise: number): void {
  log.push({ event_type: 'session-start', ts: iso(NOW_MS - 11 * 24 * 60 * MIN) });
  for (const [epic, project] of [
    ['epic-a', 'project-a'],
    ['epic-b', 'project-b'],
  ] as const) {
    for (let k = 1; k <= 3; k += 1) {
      log.push({
        event_type: 'task-added',
        task_id: `${epic}/task-${k}`,
        project,
        ts: iso(NOW_MS - 10 * 24 * 60 * MIN),
        payload: {
          epic_id: epic,
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          budget_tokens: 1000,
        },
      });
    }
  }
  const old = NOW_MS - 9 * 24 * 60 * MIN;
  for (let i = 0; i < noise / 4; i += 1) {
    const task = `epic-${i % 2 ? 'a' : 'b'}/task-${(i % 3) + 1}`;
    const project = i % 2 ? 'project-a' : 'project-b';
    dispatch(log, task, project, iso(old + i * 10));
    result(log, task, project, iso(old + i * 10 + 1), 10 + (i % 5));
    log.push({
      event_type: 'task-added',
      task_id: task,
      project,
      ts: iso(old + i * 10 + 2),
      payload: { epic_id: task.split('/')[0], budget_tokens: 1000 + (i % 7), note: MARK },
    });
    log.push({ event_type: 'operator-note', ts: iso(old + i * 10 + 3), payload: { note: MARK } });
  }
  dispatch(log, 'epic-a/task-1', 'project-a', iso(NOW_MS - 10 * MIN));
  dispatch(log, 'epic-b/task-1', 'project-b', iso(NOW_MS - 9 * MIN));
  dispatch(log, 'epic-a/task-2', 'project-a', iso(NOW_MS - 5 * MIN + 2_000));
  result(log, 'epic-a/task-3', 'project-a', iso(NOW_MS - 30 * MIN), 90);
}

const ROUTES = [
  '/api/active-scope',
  '/api/overview',
  '/api/projects',
  '/api/sessions?stores=all',
  '/api/sessions',
];

describe('a Home poll on a held projection', () => {
  const dirs: string[] = [];
  const apps: AppHandle[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const a of apps.splice(0)) a.closeStream();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  /** An app over two stores (store-a is served, store-b is a live session's), each `n` events deep. */
  async function open(n: number) {
    const tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-overview-cost-')));
    dirs.push(tmp);
    const projectA = path.join(tmp, 'project-a');
    const projectB = path.join(tmp, 'project-b');
    const config = path.join(tmp, 'config');
    const eventsA = path.join(projectA, 'state', 'events');
    const eventsB = path.join(projectB, '.blacksmith', 'state', 'events');
    await mkdir(path.join(projectA, '.git'), { recursive: true });
    await mkdir(path.join(projectB, '.git'), { recursive: true });
    await mkdir(path.join(projectB, 'src'), { recursive: true });
    await mkdir(path.join(config, 'sessions'), { recursive: true });
    await mkdir(eventsA, { recursive: true });
    await mkdir(eventsB, { recursive: true });
    const logA = new Log(path.join(eventsA, 'sess-store-a.jsonl'), 'sess-store-a');
    const logB = new Log(path.join(eventsB, 'sess-store-b.jsonl'), 'sess-store-b');
    load(logA, n);
    load(logB, n);
    await writeFile(path.join(projectA, 'roadmap.md'), '');
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
    const handle = createApp({
      dbPath: path.join(projectA, 'state', 'smith.db'),
      stateDir: eventsA,
      roadmapPath: path.join(projectA, 'roadmap.md'),
      claudeConfigDir: config,
      cliIsAlive: () => true,
      storeRefreshMs: 0,
    });
    apps.push(handle);
    return { handle, logA };
  }

  async function poll(handle: AppHandle): Promise<string[]> {
    const bodies: string[] = [];
    for (const route of ROUTES) {
      const res = await handle.app.request(route);
      expect(res.status, route).toBe(200);
      bodies.push(await res.text());
    }
    return bodies;
  }

  /** Marker-bearing parses, events_raw rows and dispatches rows read while `fn` runs. */
  async function measure(fn: () => Promise<void>) {
    let eventRows = 0;
    let dispatchRows = 0;
    const realPrepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: unknown,
      source: string,
    ) {
      const stmt = realPrepare.call(this, source);
      const isEvents = source.includes('"events_raw"');
      const isDispatches = source.includes('"dispatches"');
      if (!isEvents && !isDispatches) return stmt;
      const all = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        const rows = (all as (...a: unknown[]) => unknown[])(...args);
        if (isEvents) eventRows += rows.length;
        if (isDispatches) dispatchRows += rows.length;
        return rows;
      }) as typeof stmt.all;
      return stmt;
    } as never);
    const parse = vi.spyOn(JSON, 'parse');
    vi.mocked(overviewProjection).mockClear();
    try {
      await fn();
      const parses = parse.mock.calls.filter(
        ([s]) => typeof s === 'string' && (s.includes(MARK) || s.includes('"token_usage"')),
      ).length;
      return {
        projections: vi.mocked(overviewProjection).mock.calls.length,
        parses,
        eventRows,
        dispatchRows,
      };
    } finally {
      parse.mockRestore();
      vi.mocked(Database.prototype.prepare).mockRestore();
    }
  }

  it('does equal work at N and 10N events on a repeat poll, with no projection recomputed', {
    timeout: 240_000,
  }, async () => {
    const counts = [];
    for (const n of [2000, 20000]) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW_MS);
      const { handle } = await open(n);
      const first = await measure(async () => {
        await poll(handle);
      });
      // One computation per store for the whole first poll, not per route.
      expect(first.projections).toBe(2);
      vi.setSystemTime(NOW_MS + POLL_MS);
      counts.push(
        await measure(async () => {
          await poll(handle);
        }),
      );
      vi.useRealTimers();
    }
    expect(counts[0]?.projections).toBe(0);
    expect(counts[1]).toEqual(counts[0]);
    // The recent tail is a handful of rows; a whole-history read would be thousands.
    for (const c of counts) {
      expect(c.eventRows).toBeLessThan(200);
      expect(c.dispatchRows).toBeLessThan(200);
      expect(c.parses).toBeLessThan(200);
    }
  });

  it('keeps the clock fields moving on a repeat poll and recomputes after a write', {
    timeout: 240_000,
  }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    const { handle, logA } = await open(2000);
    const [, before] = await poll(handle);
    // epic-a/task-2 was dispatched 2 s inside the 5 min window; 5 s on, it is outside.
    vi.setSystemTime(NOW_MS + POLL_MS);
    vi.mocked(overviewProjection).mockClear();
    const [, after] = await poll(handle);
    expect(vi.mocked(overviewProjection)).not.toHaveBeenCalled();
    const deltas = (body: unknown) => {
      const o = JSON.parse(body as string);
      return [o.liveAgentCountDelta5m, o.workingAgentCountDelta5m];
    };
    expect(deltas(after)).not.toEqual(deltas(before));

    logA.push({ event_type: 'operator-note', ts: iso(NOW_MS + POLL_MS), payload: { note: 'x' } });
    vi.setSystemTime(NOW_MS + 2 * POLL_MS);
    vi.mocked(overviewProjection).mockClear();
    await poll(handle);
    expect(vi.mocked(overviewProjection)).toHaveBeenCalledTimes(1);
  });
});
