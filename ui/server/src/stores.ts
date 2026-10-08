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
import { readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DbHandle, DbOpts } from '../../../factory/orchestrator/dist/db/projector.js';
import { openDb } from '../../../factory/orchestrator/dist/db/projector.js';
import { DEFAULT_PROJECT } from '../../../factory/orchestrator/dist/db/queries.js';
import {
  gitTop,
  hasEvents,
  type StoreRoot,
  storeRootAt,
} from '../../../factory/orchestrator/dist/storeRoot.js';
import type { ProjectionIssue, Refresher } from './app.js';

// Callers (and tests) have always imported these from here.
export { gitTop, type StoreRoot, storeRootAt };

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
  /** A refresh pass running longer than this logs one warning (default 10 s). */
  slowPassMs?: number;
  /** Where that warning goes (default: stderr, as the rest of `bs ui` logs). */
  warn?: (message: string) => void;
}

const DEFAULT_SLOW_PASS_MS = 10_000;
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

  // What the current pass is still waiting on, for the slow-pass warning.
  const waitingOn = new Set<string>();

  async function refreshAll(): Promise<void> {
    if (Date.now() - lastDiscovery >= deps.refreshMs) {
      lastDiscovery = Date.now();
      discovering ??= discover().finally(() => {
        discovering = null;
      });
    }
    // A failed discovery leaves the stores already known in place.
    if (discovering) {
      waitingOn.add('store discovery');
      await discovering.catch(() => {});
      waitingOn.delete('store discovery');
    }
    await Promise.all(
      [...foreign.values()].map((s) => {
        const name = `${s.label} (${s.id})`;
        waitingOn.add(name);
        return s.refresher
          .refresh()
          .catch(() => {})
          .finally(() => waitingOn.delete(name));
      }),
    );
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
  //
  // Trade-off, kept on purpose: a request that joins a pass already running reads
  // data up to one pass old, and a hung store (or a hung `liveCwds`) holds every
  // `/api/*` request with it. There is no per-store timeout: abandoning a scan
  // leaves it folding in the background, so either the next pass starts a second
  // scan of the same store or the reader sees a half-folded cache, the very
  // window this pass closes. A stuck store is a bug to surface, not to mask: a pass
  // still running after `slowPassMs` logs one warning naming what it waits on.
  let pass: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (!pass) {
      const slow = setTimeout(() => {
        const names = [...waitingOn].join(', ') || 'unknown';
        const message = `a store refresh has been running for over ${(deps.slowPassMs ?? DEFAULT_SLOW_PASS_MS) / 1000}s; still waiting on: ${names}`;
        (deps.warn ?? ((m) => process.stderr.write(`bs ui: ${m}\n`)))(message);
      }, deps.slowPassMs ?? DEFAULT_SLOW_PASS_MS);
      slow.unref();
      pass = refreshAll().finally(() => {
        clearTimeout(slow);
        waitingOn.clear();
        pass = null;
      });
    }
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
