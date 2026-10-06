/**
 * Which Blacksmith stores the dashboard reads.
 *
 * A project may keep its state home elsewhere than the clone the dashboard was
 * started in (`BS_HOME=<project>/.blacksmith`), so its event logs never reach
 * the one database `createApp` opens. This registry finds those stores from the
 * live Claude Code CLI sessions' working directories (plus any `--store <dir>`)
 * and gives each its own dashboard-owned projection cache, filled from the
 * store's event logs by the ordinary projector.
 *
 * Read-only toward every foreign store: nothing here opens, creates or writes a
 * file under a foreign state home. The cache db lives in the SERVED clone's
 * `state/ui-stores/`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DbHandle, DbOpts } from '../../../factory/orchestrator/dist/db/projector.js';
import { openDb } from '../../../factory/orchestrator/dist/db/projector.js';
import { DEFAULT_PROJECT } from '../../../factory/orchestrator/dist/db/queries.js';
import type { ProjectionIssue, Refresher } from './app.js';

export interface StoreRef {
  id: string;
  label: string;
}

export interface StoreEntry extends StoreRef {
  handle: DbHandle;
  refresher: Refresher;
  /** True only for the store the dashboard itself was started on. */
  home: boolean;
}

/** One discovered store: where its state home is and what to call it. */
export interface StoreRoot {
  root: string;
  label: string;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Where a `.git` file (a linked worktree) really leads: the main clone, but
 * only when that clone's `.git/worktrees/<name>` exists as a directory and is
 * the very place the pointer names. A pointer is text anyone can write, so it
 * is not trusted on its own; otherwise the worktree itself is the top.
 */
function mainCloneOf(dotGitFile: string, dir: string): string {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGitFile, 'utf8'))?.[1]?.trim();
    if (!gitdir) return dir;
    const target = path.resolve(dir, gitdir);
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const at = target.indexOf(marker);
    if (at <= 0) return dir;
    const top = target.slice(0, at);
    const name = target.slice(at + marker.length);
    if (name === '' || name.includes(path.sep)) return dir;
    const entry = path.join(top, '.git', 'worktrees', name);
    if (!isDir(path.join(top, '.git')) || !isDir(entry)) return dir;
    return realpathSync(entry) === realpathSync(target) ? top : dir;
  } catch {
    // Unreadable or dangling pointer: treat the worktree itself as the top.
    return dir;
  }
}

/**
 * The git toplevel above `start`, or null. A `.git` directory marks a clone; a
 * `.git` file (a linked worktree) is followed to the main clone, because the
 * state home belongs to the project, not to one checkout of it.
 */
export function gitTop(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    if (isDir(dotGit)) return dir;
    if (existsSync(dotGit)) return mainCloneOf(dotGit, dir);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * A real store marker: `state/events` is a directory that lives inside `root`,
 * not a file and not a link leading out of the tree.
 */
function hasEvents(root: string): boolean {
  const events = path.join(root, 'state', 'events');
  return isDir(events) && realOr(events) === path.join(realOr(root), 'state', 'events');
}

/** `<top>/.blacksmith` first (a BS_HOME layout), else `<top>` itself (a clone). */
export function storeRootAt(top: string): StoreRoot | null {
  for (const root of [path.join(top, '.blacksmith'), top]) {
    if (hasEvents(root)) return { root, label: path.basename(top) };
  }
  return null;
}

/** An explicit `--store <dir>`: the state home itself. */
export function storeRootOf(dir: string): StoreRoot | null {
  const root = path.resolve(dir);
  if (!hasEvents(root)) return null;
  const name = path.basename(root);
  return { root, label: name === '.blacksmith' ? path.basename(path.dirname(root)) : name };
}

export const eventsDirOf = (root: string): string => path.join(root, 'state', 'events');

/** Short stable id: the first 8 hex chars of sha1 over the realpath of the events dir. */
export const storeIdOf = (eventsDir: string): string =>
  createHash('sha1').update(realOr(eventsDir)).digest('hex').slice(0, 8);

/** Every distinct store behind `cwds` and `extra`, minus `homeEventsDir`, deduped by realpath. */
export function discoverStores(
  cwds: string[],
  extra: string[],
  homeEventsDir: string,
): Map<string, StoreRoot> {
  const found = new Map<string, StoreRoot>();
  const homeId = storeIdOf(homeEventsDir);
  const add = (root: StoreRoot | null): void => {
    if (!root) return;
    const id = storeIdOf(eventsDirOf(root.root));
    if (id !== homeId && !found.has(id)) found.set(id, root);
  };
  for (const cwd of cwds) {
    const top = gitTop(cwd);
    if (top) add(storeRootAt(top));
  }
  for (const dir of extra) add(storeRootOf(dir));
  return found;
}

export interface StoreRegistryDeps {
  home: StoreEntry;
  /** The served events dir, so a session inside the served clone is not a second store. */
  homeEventsDir: string;
  /** Dashboard-owned; one `<storeId>.db` per foreign store. */
  cacheDir: string;
  extra: string[];
  liveCwds: () => Promise<string[]>;
  makeRefresher: (dbPath: string, eventsDir: string, dbOpts: DbOpts) => Refresher;
  /** Discovery is recomputed at most this often. */
  refreshMs: number;
  /** How long a store whose session ended keeps its open cache (default 5 minutes). */
  graceMs?: number;
  /** A cache file of an unknown store older than this is deleted at startup (default 7 days). */
  pruneAfterMs?: number;
}

const DEFAULT_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000;
const CACHE_FILE = /^[0-9a-f]{8}\.db(-wal|-shm)?$/;

/** Tables whose `project` column the projector fills from the events. */
const PROJECT_TABLES = [
  'events_raw',
  'dispatches',
  'tasks',
  'errors',
  'findings',
  'epics',
  'milestones',
];

/**
 * Makes a foreign cache read the way the dashboard shows it: a row whose project
 * is unset or the default belongs to the store's label, a row naming another
 * project keeps it. Done on the dashboard-owned cache right after each fold
 * (the projector rewrites a session's rows whole, so it is redone each time)
 * rather than at query time: a `?project=<label>` filter then needs no
 * translation, and one query returns each row exactly once, so nothing can
 * count twice. The factory's own projection and every foreign file stay as is.
 */
function readAsLabel(handle: DbHandle, label: string): void {
  if (label === DEFAULT_PROJECT) return;
  handle.sqlite.transaction(() => {
    for (const table of PROJECT_TABLES) {
      handle.sqlite
        .prepare(`UPDATE ${table} SET project = ? WHERE project IS NULL OR project = ?`)
        .run(label, DEFAULT_PROJECT);
    }
  })();
}

/** Deletes cache files (`<id>.db`, `-wal`, `-shm`) of stores not in `known` untouched for `olderThanMs`. */
function pruneCache(cacheDir: string, known: Set<string>, olderThanMs: number): void {
  let names: string[];
  try {
    names = readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!CACHE_FILE.test(name) || known.has(name.slice(0, 8))) continue;
    const file = path.join(cacheDir, name);
    try {
      if (Date.now() - statSync(file).mtimeMs > olderThanMs) rmSync(file, { force: true });
    } catch {
      // Gone or unreadable: not worth a failure.
    }
  }
}

export interface StoreRegistry {
  /** The home store first, then every foreign store by label. */
  entries(): StoreEntry[];
  /** Re-discover (throttled), then fold every store's new log lines into its cache. */
  refresh(): Promise<void>;
  issues(): ProjectionIssue[];
  /** The store with this id (the home store included), or undefined when none is known. */
  store(id: string): StoreEntry | undefined;
  close(): void;
}

export function createStoreRegistry(deps: StoreRegistryDeps): StoreRegistry {
  const foreign = new Map<string, StoreEntry & { eventsDir: string }>();
  // Stores whose session ended: handle and refresher stay open for `graceMs`, so a
  // session that restarts re-uses the folded cache instead of folding every log again.
  const lingering = new Map<
    string,
    { entry: StoreEntry & { eventsDir: string }; timer: NodeJS.Timeout }
  >();
  const unavailable = new Map<string, ProjectionIssue>();
  let pruned = false;
  let lastDiscovery = Number.NEGATIVE_INFINITY;
  let discovering: Promise<void> | null = null;

  const closeEntry = (e: StoreEntry): void => {
    e.refresher.stop();
    e.handle.sqlite.close();
  };

  const drop = (id: string): void => {
    const gone = foreign.get(id);
    if (!gone) return;
    foreign.delete(id);
    const timer = setTimeout(() => {
      lingering.delete(id);
      closeEntry(gone);
    }, deps.graceMs ?? DEFAULT_GRACE_MS);
    timer.unref();
    lingering.set(id, { entry: gone, timer });
  };

  function unavailableIssue(key: string, label: string, why: string): void {
    unavailable.set(key, {
      sessionId: label,
      kind: 'store-unavailable',
      message: `store '${label}' is unavailable and not shown: ${why}`,
    });
  }

  async function discover(): Promise<void> {
    const found = discoverStores(await deps.liveCwds(), deps.extra, deps.homeEventsDir);
    for (const [id, store] of found) {
      unavailable.delete(id);
      if (foreign.has(id)) continue;
      const back = lingering.get(id);
      if (back) {
        clearTimeout(back.timer);
        lingering.delete(id);
        foreign.set(id, back.entry);
        continue;
      }
      const eventsDir = eventsDirOf(store.root);
      try {
        const handle = openDb(path.join(deps.cacheDir, `${id}.db`));
        const inner = deps.makeRefresher(path.join(deps.cacheDir, `${id}.db`), eventsDir, {
          stateDir: eventsDir,
          roadmapPath: path.join(store.root, 'factory', 'specs', 'roadmap.md'),
          specsDir: path.join(store.root, 'factory', 'specs', 'active'),
        });
        const refresher: Refresher = {
          ...inner,
          refresh: () => inner.refresh().finally(() => readAsLabel(handle, store.label)),
        };
        foreign.set(id, { id, label: store.label, handle, refresher, home: false, eventsDir });
      } catch (err) {
        unavailableIssue(id, store.label, err instanceof Error ? err.message : String(err));
      }
    }
    for (const [id, known] of [...foreign]) {
      if (found.has(id)) continue;
      // A session that simply ended is not news; a store whose logs vanished is.
      if (!isDir(known.eventsDir)) unavailableIssue(id, known.label, 'its event logs are gone');
      drop(id);
    }
    for (const dir of deps.extra) {
      if (!storeRootOf(dir)) {
        unavailableIssue(
          `extra:${dir}`,
          path.basename(path.resolve(dir)),
          '--store has no state/events',
        );
      } else unavailable.delete(`extra:${dir}`);
    }
    if (!pruned) {
      pruned = true;
      pruneCache(
        deps.cacheDir,
        new Set([...foreign.keys(), ...lingering.keys()]),
        deps.pruneAfterMs ?? DEFAULT_PRUNE_AFTER_MS,
      );
    }
  }

  async function refreshAll(): Promise<void> {
    if (Date.now() - lastDiscovery >= deps.refreshMs) {
      lastDiscovery = Date.now();
      discovering ??= discover().finally(() => {
        discovering = null;
      });
    }
    // A failed discovery leaves the stores already known in place.
    await discovering?.catch(() => {});
    await Promise.all([...foreign.values()].map((s) => s.refresher.refresh().catch(() => {})));
  }

  // One refresh-all pass in flight per registry, joined by every caller. A scan
  // commits a session at a time and `readAsLabel` only runs when it ends, so a
  // cache can hold untagged rows meanwhile. If a second request started its own
  // scan of store A while a first still waited on a slower store B, the first
  // request's handler would read A mid-fold, unlabelled. Joining the pass means
  // no scan of any store starts while another caller still waits on this pass,
  // and the callers resume in the same microtask run that follows its end, ahead
  // of any new scan's I/O. (Chosen over relabelling inside the fold, which would
  // mean changing the projector's commit path, and over read-time mapping, which
  // would complicate every query and risk double counting.) Only the request
  // middleware calls this; the change stream's ticker scans the home store only.
  let pass: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    pass ??= refreshAll().finally(() => {
      pass = null;
    });
    return pass;
  };

  return {
    entries: () => [
      deps.home,
      ...[...foreign.values()].sort(
        (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
      ),
    ],
    refresh,
    issues: () => [
      ...unavailable.values(),
      ...[...foreign.values()].flatMap((s) =>
        s.refresher.issues().map((i) => ({ ...i, sessionId: `${s.label}/${i.sessionId}` })),
      ),
    ],
    close: () => {
      for (const { entry, timer } of lingering.values()) {
        clearTimeout(timer);
        closeEntry(entry);
      }
      lingering.clear();
      for (const e of foreign.values()) closeEntry(e);
      foreign.clear();
    },
    store: (id) =>
      id === deps.home.id ? deps.home : (foreign.get(id) ?? lingering.get(id)?.entry),
  };
}
