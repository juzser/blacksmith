// The dashboard shows the data of every project that has a live CLI session,
// not only the store it was started on. Two stores here, both built from the
// same fixture so every id (epic, task, session, event) collides on purpose:
// `project-a` is the served clone, `project-b` a foreign project that keeps
// its state under `.blacksmith/` and has event logs but no smith.db at all.
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuild } from '../../../factory/orchestrator/src/db/projector.js';
import { buildFixture, EPIC_ID, TASK_1 } from '../../../factory/orchestrator/test/db/fixtures.js';
import { type AppHandle, createApp } from '../src/app.js';

interface Store {
  id: string;
  label: string;
}
interface Col {
  taskStatus: string;
  tasks: { taskId: string; project: string | null; epicLabel: string | null; store: Store }[];
}

const ROADMAP_MD = `## Phase A
- id: phase-a
- status: in-progress
- epics: [${EPIC_ID}]
`;

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Every file under `dir` with its mtime, for a before/after comparison. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = statSync(full);
      out.push(`${path.relative(dir, full)}@${st.mtimeMs}:${st.size}`);
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}

describe('multi-store dashboard reads', () => {
  let tmp: string;
  let projectA: string;
  let projectB: string;
  let eventsB: string;
  let config: string;
  let dbPath: string;
  let handle: AppHandle | null = null;
  let nextPid = 4000;

  async function liveSession(cwd: string): Promise<void> {
    nextPid += 1;
    await writeFile(
      path.join(config, 'sessions', `${nextPid}.json`),
      JSON.stringify({
        pid: nextPid,
        sessionId: `1111111${nextPid}-1111-4111-8111-111111111111`,
        cwd,
        kind: 'interactive',
        status: 'busy',
      }),
    );
  }

  function app(over: Partial<Parameters<typeof createApp>[0]> = {}): AppHandle {
    handle = createApp({
      dbPath,
      stateDir: path.join(projectA, 'state', 'events'),
      roadmapPath: path.join(projectA, 'roadmap.md'),
      claudeConfigDir: config,
      cliIsAlive: () => true,
      storeRefreshMs: 0,
      ...over,
    });
    return handle;
  }

  const get = async <T>(a: AppHandle, route: string): Promise<T> => {
    const res = await a.app.request(route);
    expect(res.status).toBe(200);
    return json<T>(res);
  };

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-multistore-')));
    projectA = path.join(tmp, 'project-a');
    projectB = path.join(tmp, 'project-b');
    config = path.join(tmp, 'config');
    eventsB = path.join(projectB, '.blacksmith', 'state', 'events');
    await mkdir(path.join(projectA, '.git'), { recursive: true });
    await mkdir(path.join(projectB, '.git'), { recursive: true });
    await mkdir(path.join(projectB, 'src'), { recursive: true });
    await mkdir(path.join(config, 'sessions'), { recursive: true });
    await mkdir(eventsB, { recursive: true });
    await buildFixture({ stateDir: path.join(projectA, 'state', 'events') });
    await buildFixture({ stateDir: eventsB });
    await writeFile(path.join(projectA, 'roadmap.md'), ROADMAP_MD);
    dbPath = path.join(projectA, 'state', 'smith.db');
    await rebuild(dbPath, 'all', {
      stateDir: path.join(projectA, 'state', 'events'),
      roadmapPath: path.join(projectA, 'roadmap.md'),
    });
    await liveSession(path.join(projectB, 'src'));
  });

  afterEach(async () => {
    handle?.closeStream();
    handle = null;
    await rm(tmp, { recursive: true, force: true });
  });

  it('kanban returns the foreign store task beside the served one, told apart by store.id', async () => {
    const a = app();
    const columns = await get<Col[]>(a, '/api/kanban');
    const rows = columns.flatMap((c) => c.tasks).filter((t) => t.taskId === TASK_1);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.store.id)).size).toBe(2);
    expect(rows.map((r) => r.store.id)).toContain('home');
    const foreign = rows.find((r) => r.store.id !== 'home');
    expect(foreign?.store.label).toBe('project-b');
    // The default project reads as the store's label on a foreign row.
    expect(foreign?.project).toBe('project-b');
    expect(foreign?.epicLabel).toMatch(/^project-b: /);
    expect(rows.find((r) => r.store.id === 'home')?.project).not.toBe('project-b');
  });

  it('overview carries both stores epics and per-project summaries', async () => {
    const a = app();
    const o = await get<{
      tokensByEpic: { epicId: string; store: Store }[];
      projects: { project: string; store: Store }[];
      epicsInFlightByStore: { epicId: string; store: Store }[];
    }>(a, '/api/overview');
    const epics = o.tokensByEpic.filter((e) => e.epicId === EPIC_ID);
    expect(epics.map((e) => e.store.label).sort()).toEqual(['home', 'project-b']);
    expect(o.projects.map((p) => p.store.label)).toContain('project-b');
    expect(new Set(o.projects.map((p) => p.store.id)).size).toBe(2);
    expect(o.epicsInFlightByStore.filter((e) => e.epicId === EPIC_ID)).toHaveLength(2);
  });

  it('overview narrows to the foreign project when its label is the project filter', async () => {
    const a = app();
    const columns = await get<Col[]>(a, '/api/kanban?project=project-b');
    const stores = new Set(columns.flatMap((c) => c.tasks).map((t) => t.store.label));
    expect([...stores]).toEqual(['project-b']);
  });

  it('projects lists both stores', async () => {
    const a = app();
    const projects = await get<{ project: string; store: Store }[]>(a, '/api/projects');
    expect(projects.map((p) => p.store.label).sort()).toEqual(['home', 'project-b']);
    expect(projects.map((p) => p.project)).toContain('project-b');
  });

  it('never writes into the foreign store, and builds its cache beside the served db', async () => {
    const before = snapshot(projectB);
    const a = app();
    for (let i = 0; i < 3; i++) {
      await get(a, '/api/kanban');
      await get(a, '/api/overview');
      await get(a, '/api/projects');
    }
    expect(snapshot(projectB)).toEqual(before);
    expect(readdirSync(path.join(projectB, '.blacksmith'))).toEqual(['state']);
    const cache = readdirSync(path.join(projectA, 'state', 'ui-stores')).filter((f) =>
      f.endsWith('.db'),
    );
    expect(cache).toHaveLength(1);
  });

  it('a registry cwd with no store adds nothing', async () => {
    const plain = path.join(tmp, 'plain');
    await mkdir(path.join(plain, '.git'), { recursive: true });
    await liveSession(plain);
    const a = app();
    const projects = await get<{ store: Store }[]>(a, '/api/projects');
    expect(new Set(projects.map((p) => p.store.id)).size).toBe(2);
  });

  it('a session inside the served clone is home, not a second store', async () => {
    await liveSession(projectA);
    const a = app();
    const projects = await get<{ store: Store }[]>(a, '/api/projects');
    expect(new Set(projects.map((p) => p.store.id))).toHaveProperty('size', 2);
    const columns = await get<Col[]>(a, '/api/kanban');
    expect(columns.flatMap((c) => c.tasks).filter((t) => t.taskId === TASK_1)).toHaveLength(2);
  });

  it('a store that disappears drops out and raises a pulse issue', async () => {
    const a = app();
    await get(a, '/api/projects');
    await rm(projectB, { recursive: true, force: true });
    const columns = await get<Col[]>(a, '/api/kanban');
    expect(columns.flatMap((c) => c.tasks).filter((t) => t.taskId === TASK_1)).toHaveLength(1);
    const pulse = await get<{ projectionIssues: { kind: string; message: string }[] }>(
      a,
      '/api/pulse',
    );
    const issue = pulse.projectionIssues.find((i) => i.kind === 'store-unavailable');
    expect(issue?.message).toContain('project-b');
  });

  it('a half-written last log line neither crashes a read nor loses the line', async () => {
    const a = app();
    await get(a, '/api/kanban');
    const log = path.join(eventsB, readdirSync(eventsB)[0] ?? '');
    const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
    const last = lines[lines.length - 1] ?? '';
    const next = JSON.stringify({ ...JSON.parse(last), event_id: 'torn#999' });
    appendFileSync(log, next.slice(0, 20));
    const during = await a.app.request('/api/kanban');
    expect(during.status).toBe(200);
    appendFileSync(log, `${next.slice(20)}\n`);
    const pulse = await get<{ projectionIssues: unknown[] }>(a, '/api/pulse');
    expect(pulse.projectionIssues).toEqual([]);
    const after = await get<Col[]>(a, '/api/kanban');
    expect(after.flatMap((c) => c.tasks).filter((t) => t.taskId === TASK_1)).toHaveLength(2);
  });

  it('serves an explicit --store directory with no live session', async () => {
    await rm(path.join(config, 'sessions'), { recursive: true, force: true });
    await mkdir(path.join(config, 'sessions'), { recursive: true });
    const a = app({ stores: [path.join(projectB, '.blacksmith')] });
    const projects = await get<{ store: Store }[]>(a, '/api/projects');
    expect(projects.map((p) => p.store.label).sort()).toEqual(['home', 'project-b']);
  });
});
