// The dashboard shows the data of every project that has a live CLI session,
// not only the store it was started on. Two stores here, both built from the
// same fixture so every id (epic, task, session, event) collides on purpose:
// `project-a` is the served clone, `project-b` a foreign project that keeps
// its state under `.blacksmith/` and has event logs but no smith.db at all.
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rebuild } from '../../../factory/orchestrator/src/db/projector.js';
import { appendEvent } from '../../../factory/orchestrator/src/events.js';
import {
  buildFixture,
  EPIC_ID,
  TASK_1,
  TASK_2,
  TASK_3,
  TASK_4,
} from '../../../factory/orchestrator/test/db/fixtures.js';
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

  it('overview reports an in-flight epic as idle in every store, not only the served one', async () => {
    // The fixture stamps the wall clock, so a query 10 days on finds epic-1 idle in both stores.
    const a = app({ nowIso: new Date(Date.now() + 10 * 86_400_000).toISOString() });
    const o = await get<{ epicsIdle: { epicId: string; idleDays: number; store: Store }[] }>(
      a,
      '/api/overview',
    );
    const idle = o.epicsIdle.filter((e) => e.epicId === EPIC_ID);
    expect(idle).toHaveLength(2);
    expect(idle.map((e) => e.store.label).sort()).toEqual(['home', 'project-b']);
    expect(idle.every((e) => e.idleDays >= 9)).toBe(true);
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

  // The foreign store mixes events that name no project (they read as the
  // store's label) with events that name one: TASK_2 names the label itself,
  // TASK_3 names another project. TASK_1 and TASK_4 name none.
  function tagForeignEvents(): void {
    for (const name of readdirSync(eventsB)) {
      const file = path.join(eventsB, name);
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const rec = JSON.parse(line) as { task_id?: string; project?: string };
          if (rec.task_id === TASK_2) rec.project = 'project-b';
          if (rec.task_id === TASK_3) rec.project = 'project-c';
          return JSON.stringify(rec);
        });
      writeFileSync(file, `${lines.join('\n')}\n`);
    }
  }
  const foreignTasks = (columns: Col[]): Map<string, string | null> =>
    new Map(
      columns
        .flatMap((c) => c.tasks)
        .filter((t) => t.store.label === 'project-b')
        .map((t) => [t.taskId, t.project]),
    );
  const homeTaskIds = (columns: Col[]): string[] =>
    columns
      .flatMap((c) => c.tasks)
      .filter((t) => t.store.id === 'home')
      .map((t) => t.taskId)
      .sort();

  it('a foreign project filter returns every row that reads as that project, tagged or not', async () => {
    tagForeignEvents();
    const a = app();
    const all = foreignTasks(await get<Col[]>(a, '/api/kanban'));
    expect(Object.fromEntries(all)).toEqual({
      [TASK_1]: 'project-b',
      [TASK_2]: 'project-b',
      [TASK_3]: 'project-c',
      [TASK_4]: 'project-b',
    });
    const byLabel = await get<Col[]>(a, '/api/kanban?project=project-b');
    expect([...foreignTasks(byLabel).keys()].sort()).toEqual([TASK_1, TASK_2, TASK_4]);
    expect(homeTaskIds(byLabel)).toEqual([]);
    const byOther = await get<Col[]>(a, '/api/kanban?project=project-c');
    expect([...foreignTasks(byOther).keys()]).toEqual([TASK_3]);
    const byDefault = await get<Col[]>(a, '/api/kanban?project=blacksmith');
    expect(foreignTasks(byDefault).size).toBe(0);
    expect(homeTaskIds(byDefault)).toHaveLength(4);
  });

  it('overview and projects count each foreign row once under every project filter', async () => {
    tagForeignEvents();
    await mkdir(path.join(projectB, '.blacksmith', 'factory', 'specs'), { recursive: true });
    await writeFile(
      path.join(projectB, '.blacksmith', 'factory', 'specs', 'roadmap.md'),
      ROADMAP_MD,
    );
    const a = app();
    type Ms = { store: Store; project: string; tasksTotal: number };
    const total = async (query: string): Promise<number | undefined> => {
      const o = await get<{ milestoneProgress: Ms[] }>(a, `/api/overview${query}`);
      return o.milestoneProgress.find((m) => m.store.label === 'project-b')?.tasksTotal;
    };
    expect(await total('')).toBe(4);
    expect(await total('?project=project-b')).toBe(3);
    expect(await total('?project=project-c')).toBeUndefined();
    expect(await total('?project=blacksmith')).toBeUndefined();
    const projects = await get<{ project: string; store: Store }[]>(a, '/api/projects');
    expect(
      projects
        .filter((p) => p.store.label === 'project-b')
        .map((p) => p.project)
        .sort(),
    ).toEqual(['project-b', 'project-c']);
    const o = await get<{ projects: { project: string }[] }>(a, '/api/overview');
    expect(o.projects.filter((p) => p.project === 'project-b')).toHaveLength(1);
  });

  it('a foreign store milestone progress comes through the overview', async () => {
    await mkdir(path.join(projectB, '.blacksmith', 'factory', 'specs'), { recursive: true });
    await writeFile(
      path.join(projectB, '.blacksmith', 'factory', 'specs', 'roadmap.md'),
      ROADMAP_MD,
    );
    const a = app();
    const o = await get<{
      milestoneProgress: { milestoneId: string; project: string; store: Store }[];
    }>(a, '/api/overview');
    const foreign = o.milestoneProgress.filter((m) => m.store.label === 'project-b');
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.project).toBe('project-b');
  });

  describe('local-only, like /api/cli-sessions', () => {
    const routes = [
      '/api/overview',
      '/api/kanban',
      '/api/projects',
      `/api/tasks/${encodeURIComponent(TASK_1)}`,
      `/api/tasks/${encodeURIComponent(TASK_1)}/runs`,
    ];
    for (const route of routes) {
      it(`${route} refuses a non-loopback Host and answers a loopback one`, async () => {
        const a = app();
        const refused = await a.app.request(route, { headers: { host: 'rebound.example:4681' } });
        expect(refused.status).toBe(403);
        const ok = await a.app.request(route, { headers: { host: '127.0.0.1:4681' } });
        expect(ok.status).toBe(200);
      });
    }
  });

  describe('Activity reads every store', () => {
    type Row = {
      eventId: string;
      ts: string;
      taskId: string | null;
      project: string | null;
      store: Store;
    };
    type Page = { entries: Row[]; nextBefore: string | null; newestId: string | null };
    type Err = {
      byClass: {
        id: string;
        errorGroup: string;
        errorClass: string;
        severity: string;
        count: number;
        store: Store;
      }[];
      byDay: { day: string; count: number }[];
      classSummary: {
        id: string;
        count: number;
        severityMix: Record<string, number>;
        lastSeen: string;
        projects: string[];
        trend7d: number[];
      }[];
    };
    const sessionOf = (r: Row): string => r.eventId.slice(0, r.eventId.lastIndexOf('#'));
    const eventsA = (): string => path.join(projectA, 'state', 'events');
    // appendEvent always stamps the wall clock and takes no `ts`, so the clock
    // itself is pinned: every note gets the next millisecond, strictly after the
    // last one (and never before the real clock), whatever the timers do.
    let lastTs = 0;
    const note = async (dir: string, sessionId: string, n: number): Promise<void> => {
      lastTs = Math.max(Date.now(), lastTs + 1);
      vi.setSystemTime(lastTs);
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'user',
          event_type: n === 0 ? 'session-start' : 'operator-note',
          plan_version: 1,
          causal_parent: n === 0 ? null : `${sessionId}#${n - 1}`,
          payload: n === 0 ? {} : { note: `n${n}` },
        },
        { stateDir: dir },
      );
    };
    // Three more sessions across the two stores, appended turn by turn so their
    // timestamps interleave with each other and with the fixture's.
    async function interleave(): Promise<void> {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        for (let n = 0; n < 3; n++) {
          await note(eventsA(), 'sess-home-2', n);
          await note(eventsB, 'sess-b-2', n);
          await note(eventsB, 'sess-b-3', n);
          await note(eventsA(), 'sess-home-3', n);
        }
      } finally {
        vi.useRealTimers();
      }
    }
    const foreignStoreId = async (a: AppHandle): Promise<string> => {
      const projects = await get<{ project: string; store: Store }[]>(a, '/api/projects');
      return projects.find((p) => p.store.label === 'project-b')?.store.id as string;
    };
    const key = (r: Row): string => `${r.store.id}|${r.eventId}`;
    const order = (x: Row, y: Row): number => {
      const split = (id: string) => ({
        s: id.slice(0, id.lastIndexOf('#')),
        n: Number(id.slice(id.lastIndexOf('#') + 1)),
      });
      const a = split(x.eventId);
      const b = split(y.eventId);
      if (x.ts !== y.ts) return x.ts < y.ts ? -1 : 1;
      if (a.s !== b.s) return a.s < b.s ? -1 : 1;
      return a.n - b.n || x.store.id.localeCompare(y.store.id);
    };
    /** Every event of both stores, read one store at a time, newest first. */
    async function everyRow(a: AppHandle, id: string): Promise<Row[]> {
      const home = await get<Row[]>(a, '/api/timeline');
      const foreign = await get<Row[]>(a, `/api/timeline?store=${id}`);
      return [
        ...home.map((r) => ({ ...r, store: { id: 'home', label: 'home' } })),
        ...foreign.map((r) => ({ ...r, store: { id, label: 'project-b' } })),
      ]
        .sort(order)
        .reverse();
    }
    const all = (q: string): string => `/api/timeline?stores=all&${q}`;

    it('walks every page by before and returns each row of both stores once, newest first', async () => {
      await interleave();
      const a = app();
      const id = await foreignStoreId(a);
      const expected = await everyRow(a, id);
      const seen: Row[] = [];
      let before: string | null = null;
      let pages = 0;
      do {
        const q: string = `limit=2${before ? `&before=${encodeURIComponent(before)}` : ''}`;
        const page: Page = await get<Page>(a, all(q));
        if (page.nextBefore !== null) expect(page.entries).toHaveLength(2);
        expect(page.entries.length).toBeGreaterThan(0);
        seen.push(...page.entries);
        before = page.nextBefore;
        pages += 1;
      } while (before !== null && pages < 200);
      expect(seen.map(key)).toEqual(expected.map(key));
      expect(new Set(seen.map(key)).size).toBe(seen.length);
      expect(new Set(seen.map((r) => r.store.id))).toEqual(new Set(['home', id]));
      for (const r of seen.filter((x) => x.store.id === id)) expect(r.project).toBe('project-b');
      for (const r of seen.filter((x) => x.store.id === 'home'))
        expect(r.project).not.toBe('project-b');
    });

    it('after the newest id returns exactly the rows appended to each store since', async () => {
      await interleave();
      const a = app();
      const first = await get<Page>(a, all('limit=5'));
      expect(first.newestId).not.toBeNull();
      await note(eventsA(), 'sess-home-2', 3);
      await note(eventsB, 'sess-b-2', 3);
      const poll = await get<Page>(
        a,
        all(`limit=50&after=${encodeURIComponent(first.newestId as string)}`),
      );
      expect(poll.entries.map((r) => `${r.store.label}:${r.eventId}`).sort()).toEqual([
        'home:sess-home-2#3',
        'project-b:sess-b-2#3',
      ]);
      const again = await get<Page>(
        a,
        all(`limit=50&after=${encodeURIComponent(poll.newestId as string)}`),
      );
      expect(again.entries).toEqual([]);
    });

    it('narrows to the listed sessions, qualified or bare, and refuses a qualified one alone', async () => {
      await interleave();
      const a = app();
      const id = await foreignStoreId(a);
      const q = `limit=100&sessions=${id}/sess-b-2&sessions=sess-home-3`;
      const page = await get<Page>(a, all(q));
      expect(new Set(page.entries.map((r) => `${r.store.id}/${sessionOf(r)}`))).toEqual(
        new Set([`${id}/sess-b-2`, 'home/sess-home-3']),
      );
      expect(page.entries).toHaveLength(6);
      const explicitHome = await get<Page>(a, all('limit=100&sessions=home/sess-home-2'));
      expect(new Set(explicitHome.entries.map(sessionOf))).toEqual(new Set(['sess-home-2']));
      expect((await a.app.request(`/api/timeline?limit=5&sessions=${id}/sess-b-2`)).status).toBe(
        400,
      );
      expect((await a.app.request(all('limit=5&sessions=zz/sess-b-2'))).status).toBe(400);
      expect((await a.app.request(all(`limit=5&sessions=${id}/a/b`))).status).toBe(400);
    });

    it('refuses stores=all with a filter that names one store, and bad values and cursors', async () => {
      const a = app();
      const id = await foreignStoreId(a);
      const bad = [
        all('limit=5&task=epic-1/task-1'),
        all('limit=5&epic=epic-1'),
        all('limit=5&session=sess-fixture'),
        all('limit=5&session=sess-fixture&lineage=true'),
        all('limit=5&causalChainFor=sess-fixture%231&session=sess-fixture'),
        all(`limit=5&store=${id}`),
        '/api/timeline?stores=x&limit=5',
        '/api/timeline?stores=&limit=5',
        all('limit=5&before=garbage'),
        all('limit=5&before=v1.!!!'),
        all(`limit=5&before=v1.${Buffer.from('[]').toString('base64url')}`),
        all(`limit=5&before=v1.${Buffer.from('{"zz":"x#1"}').toString('base64url')}`),
        all(`limit=5&before=v1.${Buffer.from('{"home":3}').toString('base64url')}`),
        all('limit=5&after=garbage'),
        '/api/errors?stores=all&epic=epic-1',
        '/api/errors?stores=all&session=sess-fixture',
        `/api/errors?stores=all&store=${id}`,
        '/api/errors?stores=x',
        '/api/errors?sessions=zz/sess-fixture',
      ];
      for (const route of bad) {
        expect([route, (await a.app.request(route)).status]).toEqual([route, 400]);
      }
    });

    it('reads one named store with store=<id>, and 404s an unknown one', async () => {
      const a = app();
      const id = await foreignStoreId(a);
      const rows = await get<Row[]>(
        a,
        `/api/timeline?store=${id}&task=${encodeURIComponent(TASK_1)}`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.taskId).toBe(TASK_1);
        expect(r.store).toEqual({ id, label: 'project-b' });
        expect(r.project).toBe('project-b');
      }
      const home = await get<Row[]>(
        a,
        `/api/timeline?store=home&task=${encodeURIComponent(TASK_1)}`,
      );
      expect(home).toEqual(await get(a, `/api/timeline?task=${encodeURIComponent(TASK_1)}`));
      for (const route of ['/api/timeline?store=deadbeef', '/api/errors?store=deadbeef']) {
        expect((await a.app.request(route)).status).toBe(404);
      }
    });

    it('answers a request without stores=all exactly as before, rows untagged', async () => {
      await interleave();
      const a = app();
      for (const route of ['/api/timeline', '/api/timeline?limit=3', '/api/errors']) {
        const body = await get<unknown>(a, route);
        expect(JSON.stringify(body)).not.toContain('"store"');
      }
      const page = await get<{ nextBefore: string | null }>(a, '/api/timeline?limit=3');
      expect(page.nextBefore).toMatch(/#\d+$/);
    });

    it('merges errors across stores: every figure is the sum of the two stores read alone', async () => {
      const err = (sessionId: string, n: number, error: string, severity: string) =>
        appendEvent(
          {
            session_id: sessionId,
            actor: 'coder',
            event_type: 'error-logged',
            plan_version: 1,
            causal_parent: `${sessionId}#${n}`,
            payload: { error, severity, task_ref: TASK_1, detail: 'x' },
          },
          { stateDir: sessionId === 'sess-b-2' ? eventsB : eventsA() },
        );
      await interleave();
      await err('sess-b-2', 2, 'coordination.deadlock', 'S1-stop-the-line');
      await err('sess-b-2', 3, 'coordination.deadlock', 'S2-major');
      await err('sess-home-2', 2, 'coordination.deadlock', 'S2-major');
      const a = app();
      const id = await foreignStoreId(a);
      const home = await get<Err>(a, '/api/errors');
      const foreign = await get<Err>(a, `/api/errors?store=${id}`);
      const merged = await get<Err>(a, '/api/errors?stores=all');
      const total = (e: Err[], f: (x: Err) => { k: string; n: number }[]) => {
        const m = new Map<string, number>();
        for (const x of e) for (const { k, n } of f(x)) m.set(k, (m.get(k) ?? 0) + n);
        return [...m.entries()].sort();
      };
      const classes = (x: Err) => x.byClass.map((c) => ({ k: `${c.id}`, n: c.count }));
      expect(
        total([merged], (x) =>
          x.byClass.map((c) => ({ k: c.id.split(':').pop() as string, n: c.count })),
        ),
      ).toEqual(total([home, foreign], classes));
      expect(new Set(merged.byClass.map((c) => c.id)).size).toBe(merged.byClass.length);
      expect(merged.byClass.map((c) => c.store.id)).toContain(id);
      expect(total([merged], (x) => x.byDay.map((d) => ({ k: d.day, n: d.count })))).toEqual(
        total([home, foreign], (x) => x.byDay.map((d) => ({ k: d.day, n: d.count }))),
      );
      expect(total([merged], (x) => x.classSummary.map((c) => ({ k: c.id, n: c.count })))).toEqual(
        total([home, foreign], (x) => x.classSummary.map((c) => ({ k: c.id, n: c.count }))),
      );
      const sev = (x: Err) =>
        x.classSummary.flatMap((c) =>
          Object.entries(c.severityMix).map(([s, n]) => ({ k: `${c.id}|${s}`, n })),
        );
      expect(total([merged], sev)).toEqual(total([home, foreign], sev));
      const trend = (x: Err) =>
        x.classSummary.flatMap((c) => c.trend7d.map((n, i) => ({ k: `${c.id}|${i}`, n })));
      expect(total([merged], trend)).toEqual(total([home, foreign], trend));
      const deadlock = merged.classSummary.find((c) => c.id === 'coordination.deadlock');
      expect(deadlock?.projects).toContain('project-b');
      const lastSeen = [...home.classSummary, ...foreign.classSummary]
        .filter((c) => c.id === 'coordination.deadlock')
        .map((c) => c.lastSeen)
        .sort()
        .pop();
      expect(deadlock?.lastSeen).toBe(lastSeen);
    });

    it('never writes into the foreign store on either route, paged or not', async () => {
      await interleave();
      const before = snapshot(projectB);
      const a = app();
      const id = await foreignStoreId(a);
      for (const route of [
        all('limit=2'),
        all('limit=2&sessions=home/sess-home-2'),
        '/api/errors?stores=all',
        `/api/timeline?store=${id}`,
        `/api/errors?store=${id}`,
      ]) {
        await get(a, route);
      }
      expect(snapshot(projectB)).toEqual(before);
    });

    it('with only the home store, stores=all still answers with opaque cursors that walk the feed', async () => {
      await rm(path.join(config, 'sessions'), { recursive: true, force: true });
      await mkdir(path.join(config, 'sessions'), { recursive: true });
      const a = app();
      const expected = (await get<Row[]>(a, '/api/timeline')).map((r) => r.eventId).reverse();
      const seen: string[] = [];
      let before: string | null = null;
      do {
        const page: Page = await get<Page>(
          a,
          all(`limit=4${before ? `&before=${encodeURIComponent(before)}` : ''}`),
        );
        seen.push(...page.entries.map((r) => r.eventId));
        expect(page.entries.every((r) => r.store.id === 'home')).toBe(true);
        before = page.nextBefore;
      } while (before !== null);
      expect(seen).toEqual(expected);
    });
  });

  describe('a task of a foreign store', () => {
    const task = encodeURIComponent(TASK_1);
    const foreignId = async (a: AppHandle): Promise<string> => {
      const columns = await get<Col[]>(a, '/api/kanban');
      const id = columns.flatMap((c) => c.tasks).find((t) => t.store.label === 'project-b')
        ?.store.id;
      expect(id).toBeDefined();
      return id as string;
    };

    it('is read from that store with ?store=<id>, the bare id still meaning the served store', async () => {
      const a = app();
      const id = await foreignId(a);
      const foreign = await get<{ task: { taskId: string; project: string | null } }>(
        a,
        `/api/tasks/${task}?store=${id}`,
      );
      expect(foreign.task.taskId).toBe(TASK_1);
      expect(foreign.task.project).toBe('project-b');
      const served = await get<{ task: { project: string | null } }>(a, `/api/tasks/${task}`);
      expect(served.task.project).not.toBe('project-b');
      const runs = await get<{ runs: unknown[] }>(a, `/api/tasks/${task}/runs?store=${id}`);
      expect(Array.isArray(runs.runs)).toBe(true);
    });

    it('still opens once its CLI session has ended, while the cache lingers', async () => {
      const a = app();
      const id = await foreignId(a);
      await rm(path.join(config, 'sessions'), { recursive: true, force: true });
      await mkdir(path.join(config, 'sessions'), { recursive: true });
      const columns = await get<Col[]>(a, '/api/kanban');
      expect(columns.flatMap((c) => c.tasks).some((t) => t.store.id === id)).toBe(false);
      const detail = await get<{ task: { taskId: string } }>(a, `/api/tasks/${task}?store=${id}`);
      expect(detail.task.taskId).toBe(TASK_1);
    });

    it('answers 404 for an unknown store, never the served store', async () => {
      const a = app();
      for (const route of [
        `/api/tasks/${task}?store=nope0000`,
        `/api/tasks/${task}/runs?store=nope0000`,
      ]) {
        expect((await a.app.request(route)).status).toBe(404);
      }
    });
  });
});
