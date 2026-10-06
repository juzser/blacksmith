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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Refresher } from '../src/app.js';
import {
  createStoreRegistry,
  discoverStores,
  eventsDirOf,
  gitTop,
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

  function registry(over: { graceMs?: number } = {}) {
    const b = mk('project-b');
    mk('project-b', '.git');
    mk('project-b', '.blacksmith', 'state', 'events');
    const home = mk('project-a');
    mk('project-a', 'state', 'events');
    const cwds: string[] = [b];
    const made: string[] = [];
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
        return fakeRefresher();
      },
      refreshMs: 0,
      ...over,
    });
    return { reg, cwds, made, cacheDir, b };
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
});
