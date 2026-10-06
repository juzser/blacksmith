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
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DbHandle, DbOpts } from '../../../factory/orchestrator/dist/db/projector.js';
import { openDb } from '../../../factory/orchestrator/dist/db/projector.js';
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
    if (existsSync(dotGit)) {
      try {
        const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
        const at = gitdir?.indexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`) ?? -1;
        if (gitdir && at > 0) return gitdir.slice(0, at);
      } catch {
        // Unreadable pointer: treat the worktree itself as the top.
      }
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `<top>/.blacksmith` first (a BS_HOME layout), else `<top>` itself (a clone). */
export function storeRootAt(top: string): StoreRoot | null {
  for (const root of [path.join(top, '.blacksmith'), top]) {
    if (isDir(path.join(root, 'state', 'events'))) return { root, label: path.basename(top) };
  }
  return null;
}

/** An explicit `--store <dir>`: the state home itself. */
export function storeRootOf(dir: string): StoreRoot | null {
  const root = path.resolve(dir);
  if (!isDir(path.join(root, 'state', 'events'))) return null;
  const name = path.basename(root);
  return { root, label: name === '.blacksmith' ? path.basename(path.dirname(root)) : name };
}

export const eventsDirOf = (root: string): string => path.join(root, 'state', 'events');

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

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
}

export interface StoreRegistry {
  /** The home store first, then every foreign store by label. */
  entries(): StoreEntry[];
  /** Re-discover (throttled), then fold every store's new log lines into its cache. */
  refresh(): Promise<void>;
  issues(): ProjectionIssue[];
  close(): void;
}

export function createStoreRegistry(deps: StoreRegistryDeps): StoreRegistry {
  const foreign = new Map<string, StoreEntry & { eventsDir: string }>();
  const unavailable = new Map<string, ProjectionIssue>();
  let lastDiscovery = Number.NEGATIVE_INFINITY;
  let discovering: Promise<void> | null = null;

  const drop = (id: string): void => {
    const gone = foreign.get(id);
    if (!gone) return;
    foreign.delete(id);
    gone.refresher.stop();
    gone.handle.sqlite.close();
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
      const eventsDir = eventsDirOf(store.root);
      try {
        const handle = openDb(path.join(deps.cacheDir, `${id}.db`));
        const refresher = deps.makeRefresher(path.join(deps.cacheDir, `${id}.db`), eventsDir, {
          stateDir: eventsDir,
          roadmapPath: path.join(store.root, 'factory', 'specs', 'roadmap.md'),
          specsDir: path.join(store.root, 'factory', 'specs', 'active'),
        });
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
  }

  async function refresh(): Promise<void> {
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
      for (const id of [...foreign.keys()]) drop(id);
    },
  };
}
