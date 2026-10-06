// Store discovery on its own: which directories become stores, and how they dedupe.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../../factory/orchestrator/dist/db/projector.js';
import type { Refresher } from '../src/app.js';
import {
  createStoreRegistry,
  discoverStores,
  eventsDirOf,
  gitTop,
  type StoreRegistryDeps,
  storeIdOf,
  storeRootAt,
  storeRootOf,
} from '../src/stores.js';

describe('store discovery', () => {
  let tmp: string;
  const mk = (...parts: string[]): string => {
    const dir = path.join(tmp, ...parts);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-stores-')));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('walks up from a nested cwd to the git toplevel', () => {
    mk('project-b', '.git');
    const deep = mk('project-b', 'src', 'deep');
    expect(gitTop(deep)).toBe(path.join(tmp, 'project-b'));
    expect(gitTop(mk('elsewhere'))).toBeNull();
  });

  it('maps a linked worktree back to the main clone', () => {
    const main = mk('project-b');
    mk('project-b', '.git', 'worktrees', 'w1');
    const wt = mk('wt');
    writeFileSync(path.join(wt, '.git'), `gitdir: ${main}/.git/worktrees/w1\n`);
    expect(gitTop(wt)).toBe(main);
  });

  it('finds a BS_HOME layout, preferring it over a clone layout', () => {
    const top = mk('project-b');
    mk('project-b', 'state', 'events');
    expect(storeRootAt(top)?.root).toBe(top);
    mk('project-b', '.blacksmith', 'state', 'events');
    expect(storeRootAt(top)).toEqual({ root: path.join(top, '.blacksmith'), label: 'project-b' });
    expect(storeRootAt(mk('plain'))).toBeNull();
  });

  it('reads an explicit --store dir as the state home itself', () => {
    mk('project-b', '.blacksmith', 'state', 'events');
    expect(storeRootOf(path.join(tmp, 'project-b', '.blacksmith'))?.label).toBe('project-b');
    mk('custom-home', 'state', 'events');
    expect(storeRootOf(path.join(tmp, 'custom-home'))?.label).toBe('custom-home');
    expect(storeRootOf(path.join(tmp, 'missing'))).toBeNull();
  });

  it('dedupes by realpath and leaves the home store out', () => {
    const b = mk('project-b');
    mk('project-b', '.git');
    mk('project-b', '.blacksmith', 'state', 'events');
    symlinkSync(b, path.join(tmp, 'link-to-b'));
    const home = mk('project-a');
    mk('project-a', '.git');
    mk('project-a', 'state', 'events');
    const found = discoverStores(
      [b, path.join(tmp, 'link-to-b'), mk('project-b', 'src'), home],
      [path.join(b, '.blacksmith')],
      eventsDirOf(home),
    );
    expect([...found.keys()]).toEqual([storeIdOf(eventsDirOf(path.join(b, '.blacksmith')))]);
    expect(storeIdOf(eventsDirOf(path.join(b, '.blacksmith')))).toMatch(/^[0-9a-f]{8}$/);
  });

  it('does not follow a gitdir pointer that has no matching worktree entry', () => {
    const main = mk('project-b');
    mk('project-b', '.git');
    const wt = mk('wt');
    writeFileSync(path.join(wt, '.git'), `gitdir: ${main}/.git/worktrees/ghost\n`);
    expect(gitTop(wt)).toBe(wt);
    // A worktree entry that exists but whose own pointer is elsewhere is no match either.
    mk('project-b', '.git', 'worktrees', 'w1');
    const other = mk('other');
    writeFileSync(path.join(other, '.git'), `gitdir: ${main}/.git/worktrees/w1/../ghost\n`);
    expect(gitTop(other)).toBe(other);
  });

  it('does not count a state/events symlink pointing out of the tree as a store', () => {
    const top = mk('project-b');
    mk('project-b', '.git');
    mk('outside', 'state', 'events');
    mk('project-b', '.blacksmith', 'state');
    symlinkSync(
      path.join(tmp, 'outside', 'state', 'events'),
      path.join(top, '.blacksmith', 'state', 'events'),
    );
    expect(storeRootAt(top)).toBeNull();
    expect(storeRootOf(path.join(top, '.blacksmith'))).toBeNull();
    writeFileSync(path.join(mk('file-store', 'state'), 'events'), 'not a dir');
    expect(storeRootOf(path.join(tmp, 'file-store'))).toBeNull();
  });
});

describe('store cache lifetime', () => {
  let tmp: string;
  const mk = (...parts: string[]): string => {
    const dir = path.join(tmp, ...parts);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fakeRefresher = (): Refresher => ({
    refresh: async () => {},
    issues: () => [],
    subscribe: () => () => {},
    hold: () => () => {},
    stop: () => {},
  });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-cache-')));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function registry(over: Partial<StoreRegistryDeps> = {}) {
    const b = mk('project-b');
    mk('project-b', '.git');
    mk('project-b', '.blacksmith', 'state', 'events');
    const home = mk('project-a');
    mk('project-a', 'state', 'events');
    const cwds: string[] = [b];
    const made: string[] = [];
    const scans = { n: 0 };
    const cacheDir = path.join(home, 'state', 'ui-stores');
    const reg = createStoreRegistry({
      home: {
        id: 'home',
        label: 'home',
        handle: null as never,
        refresher: fakeRefresher(),
        home: true,
      },
      homeEventsDir: eventsDirOf(home),
      cacheDir,
      extra: [],
      liveCwds: async () => cwds,
      makeRefresher: (dbPath) => {
        made.push(dbPath);
        return {
          ...fakeRefresher(),
          refresh: async () => {
            scans.n++;
          },
        };
      },
      refreshMs: 0,
      ...over,
    });
    return { reg, cwds, made, cacheDir, b, scans };
  }

  it('keeps a dropped store for the grace period, so a restarted session does not re-fold', async () => {
    const { reg, cwds, made } = registry({ graceMs: 5000 });
    await reg.refresh();
    const first = reg.entries()[1];
    expect(first?.handle.sqlite.open).toBe(true);
    cwds.length = 0;
    await reg.refresh();
    expect(reg.entries()).toHaveLength(1);
    expect(first?.handle.sqlite.open).toBe(true);
    cwds.push(path.join(tmp, 'project-b'));
    await reg.refresh();
    expect(made).toHaveLength(1);
    expect(reg.entries()[1]?.handle).toBe(first?.handle);
    reg.close();
    expect(first?.handle.sqlite.open).toBe(false);
  });

  it('closes a dropped store once the grace period is over and re-opens it fresh after', async () => {
    const { reg, cwds, made } = registry({ graceMs: 20 });
    await reg.refresh();
    const first = reg.entries()[1];
    cwds.length = 0;
    await reg.refresh();
    await sleep(80);
    expect(first?.handle.sqlite.open).toBe(false);
    cwds.push(path.join(tmp, 'project-b'));
    await reg.refresh();
    expect(made).toHaveLength(2);
    reg.close();
  });

  it('prunes only stale cache files of unknown stores, and only inside ui-stores', async () => {
    const { reg, cacheDir } = registry();
    mkdirSync(cacheDir, { recursive: true });
    const old = new Date(Date.now() - 9 * 24 * 3600 * 1000);
    const put = (name: string, aged: boolean, dir = cacheDir) => {
      const f = path.join(dir, name);
      writeFileSync(f, 'x');
      if (aged) utimesSync(f, old, old);
      return f;
    };
    const stale = ['deadbeef.db', 'deadbeef.db-wal', 'deadbeef.db-shm'].map((n) => put(n, true));
    const fresh = put('cafebabe.db', false);
    const foreignName = put('notes.txt', true);
    const outside = put('deadbeef.db', true, path.dirname(cacheDir));
    await reg.refresh();
    for (const f of stale) expect(existsSync(f)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreignName)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    // The store known right now keeps its own cache.
    expect(reg.entries()).toHaveLength(2);
    reg.close();
  });

  it('finds a lingering store by id, and not once the grace period is over', async () => {
    const { reg, cwds } = registry({ graceMs: 60 });
    await reg.refresh();
    const first = reg.entries()[1];
    expect(first).toBeDefined();
    cwds.length = 0;
    await reg.refresh();
    expect(reg.entries()).toHaveLength(1);
    expect(reg.store(first?.id ?? '')).toBe(first);
    await sleep(150);
    expect(reg.store(first?.id ?? '')).toBeUndefined();
    reg.close();
  });

  it('lets overlapping callers share one pass, so a store is scanned once per pass', async () => {
    const { reg, scans } = registry();
    await Promise.all([reg.refresh(), reg.refresh(), reg.refresh()]);
    expect(scans.n).toBe(1);
    await reg.refresh();
    expect(scans.n).toBe(2);
    reg.close();
  });

  describe('a slow refresh pass', () => {
    afterEach(() => vi.useRealTimers());

    it('warns once, naming the store still scanning, and not again for the same pass', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const warnings: string[] = [];
      let started = () => {};
      const scanning = new Promise<void>((r) => {
        started = r;
      });
      const { reg } = registry({
        slowPassMs: 1000,
        warn: (m) => warnings.push(m),
        makeRefresher: () => ({
          ...fakeRefresher(),
          refresh: () => {
            started();
            return new Promise<void>(() => {});
          },
        }),
      });
      void reg.refresh();
      void reg.refresh();
      await scanning;
      vi.advanceTimersByTime(999);
      expect(warnings).toEqual([]);
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(60_000);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('project-b');
      reg.close();
    });

    it('stays silent when the pass finishes under the threshold', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const warnings: string[] = [];
      const { reg } = registry({ slowPassMs: 1000, warn: (m) => warnings.push(m) });
      await reg.refresh();
      vi.advanceTimersByTime(60_000);
      expect(warnings).toEqual([]);
      reg.close();
    });
  });

  it('never lets a caller read a foreign cache between a fold commit and its relabel', async () => {
    const home = mk('home-x');
    mk('home-x', 'state', 'events');
    const tops = ['project-a', 'project-b'].map((n) => {
      mk(n, '.git');
      mk(n, '.blacksmith', 'state', 'events');
      return path.join(tmp, n);
    });
    let releaseB = () => {};
    let bIsScanning = () => {};
    const bScanning = new Promise<void>((r) => {
      bIsScanning = r;
    });
    let draining = false;
    const lateScans: Array<() => void> = [];
    const scans: Record<string, number> = {};
    const reg = createStoreRegistry({
      home: {
        id: 'home',
        label: 'home',
        handle: null as never,
        refresher: fakeRefresher(),
        home: true,
      },
      homeEventsDir: eventsDirOf(home),
      cacheDir: path.join(home, 'state', 'ui-stores'),
      extra: [],
      liveCwds: async () => tops,
      // A scan commits an untagged row at once, then keeps folding until released.
      makeRefresher: (dbPath) => ({
        ...fakeRefresher(),
        refresh: async () => {
          const n = (scans[dbPath] ?? 0) + 1;
          scans[dbPath] = n;
          const db = openDb(dbPath);
          db.sqlite
            .prepare(
              "INSERT INTO tasks (task_id, session_id, task_status, created_at, updated_at) VALUES (?, 's', 'todo', 't', 't')",
            )
            .run(`t${n}-${path.basename(dbPath)}`);
          db.sqlite.close();
          if (n > 1) {
            if (!draining) await new Promise<void>((r) => lateScans.push(r));
          } else if (
            dbPath.endsWith(`${storeIdOf(eventsDirOf(path.join(tops[1] ?? '', '.blacksmith')))}.db`)
          ) {
            const gate = new Promise<void>((r) => {
              releaseB = r;
            });
            bIsScanning();
            await gate;
          }
        },
      }),
      refreshMs: 0,
    });
    const r1 = reg.refresh();
    // R1 is parked inside store B's first scan, and R2 arrives while it is.
    await bScanning;
    const r2 = reg.refresh();
    releaseB();
    await r1;
    // R1's handler would run now, while any scan R2 started is still folding.
    const seen = reg
      .entries()
      .slice(1)
      .map((e) => ({
        label: e.label,
        rows: e.handle.sqlite.prepare('SELECT project FROM tasks').all() as Array<{
          project: string | null;
        }>,
      }));
    expect(seen.flatMap((x) => x.rows)).not.toHaveLength(0);
    for (const x of seen) for (const r of x.rows) expect(r.project).toBe(x.label);
    // Settle both requests, whatever number of event-loop turns that takes: a
    // second scan by R2 (its own pass) shows up as a count of 2.
    draining = true;
    for (const g of lateScans.splice(0)) g();
    await r2;
    for (const [dbPath, n] of Object.entries(scans)) expect([dbPath, n]).toEqual([dbPath, 1]);
    reg.close();
  });
});
