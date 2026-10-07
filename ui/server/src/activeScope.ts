// The one definition of "active" for `GET /api/active-scope`: what the operator's
// live Claude Code CLI sessions are driving. A pure fold; app.ts gathers the
// inputs (the cli-sessions read, and each store's overview slices).
//
// Prompt-free by construction: the result is built field by field from ids,
// project names, store ids and counts, so no session name, cwd, prompt or
// transcript text can ride along.
import type { CliSessionsResponse, StoreRef } from './cliSessions.js';

/** The slice of the cli-sessions read this fold uses. */
export interface ActiveScopeCli {
  state: CliSessionsResponse['state'];
  readAt: string;
  sessions: {
    startedAt: string | null;
    linked: {
      epics: {
        store: StoreRef;
        epicId: string | null;
        project: string | null;
        factorySessionIds: string[];
        workingAgents: { role: string; taskId: string | null; since: string }[];
      }[];
    } | null;
  }[];
}

/** One store's overview slices: taken from overview(), never re-derived. */
export interface ActiveScopeStore {
  store: StoreRef;
  /** `overview().epicsActivelyRunning`, the set Home's "Running now" reads. */
  activelyRunning: string[];
  /** epic id -> project, from the overview's per-project `epicsInFlight`. */
  epicProjects: Record<string, string>;
  /** factory session id -> its last event's time, from `overview().runningSessions`. */
  sessionLastEventAt: Record<string, string>;
}

export interface ActiveScope {
  measured: boolean;
  readAt: string;
  liveSessions: number;
  unlinkedSessions: number;
  projects: { storeId: string; project: string; liveSessions: number; agentsWorking: number }[];
  epics: { storeId: string; epicId: string; project: string | null }[];
  factorySessions: { storeId: string; sessionId: string }[];
}

const HOME_STORE_ID = 'home';

export function computeActiveScope(
  cli: ActiveScopeCli,
  stores: readonly ActiveScopeStore[],
  nowIso: string,
): ActiveScope {
  if (cli.state !== 'ok') {
    return {
      measured: false,
      readAt: nowIso,
      liveSessions: 0,
      unlinkedSessions: 0,
      projects: [],
      epics: [],
      factorySessions: [],
    };
  }
  const byStore = new Map(stores.map((s) => [s.store.id, s]));
  const projects = new Map<
    string,
    {
      storeId: string;
      project: string;
      sessions: Set<number>;
      agents: Set<string>;
    }
  >();
  const epics = new Map<string, ActiveScope['epics'][number]>();
  const factory = new Map<string, ActiveScope['factorySessions'][number]>();
  let unlinked = 0;

  cli.sessions.forEach((s, index) => {
    const entries = s.linked?.epics ?? [];
    if (entries.length === 0) {
      unlinked++;
      return;
    }
    const startedMs = s.startedAt === null ? Number.NaN : Date.parse(s.startedAt);
    for (const e of entries) {
      const st = byStore.get(e.store.id);
      const projectOf = (): string | null =>
        e.project ??
        (e.epicId === null ? undefined : st?.epicProjects[e.epicId]) ??
        (e.store.id === HOME_STORE_ID ? null : e.store.label);
      let project: string | null;
      if (e.epicId === null) {
        project = projectOf();
      } else {
        if (st === undefined || !st.activelyRunning.includes(e.epicId)) continue;
        project = projectOf();
        const key = `${e.store.id}\u0000${e.epicId}`;
        if (!epics.has(key)) epics.set(key, { storeId: e.store.id, epicId: e.epicId, project });
        for (const id of pickFactorySessions(e.factorySessionIds, st, startedMs)) {
          factory.set(`${e.store.id}\u0000${id}`, { storeId: e.store.id, sessionId: id });
        }
      }
      if (project === null) continue;
      const pkey = `${e.store.id}\u0000${project}`;
      let p = projects.get(pkey);
      if (p === undefined) {
        p = {
          storeId: e.store.id,
          project,
          sessions: new Set(),
          agents: new Set(),
        };
        projects.set(pkey, p);
      }
      p.sessions.add(index);
      if (e.epicId !== null) {
        for (const a of e.workingAgents) {
          p.agents.add(`${e.epicId}\u0000${a.role}\u0000${a.taskId ?? ''}\u0000${a.since}`);
        }
      }
    }
  });

  return {
    measured: true,
    readAt: cli.readAt,
    liveSessions: cli.sessions.length,
    unlinkedSessions: unlinked,
    projects: [...projects.values()].map((p) => ({
      storeId: p.storeId,
      project: p.project,
      liveSessions: p.sessions.size,
      agentsWorking: p.agents.size,
    })),
    epics: [...epics.values()],
    factorySessions: [...factory.values()],
  };
}

/**
 * The lineage members this CLI session wrote to: last event at or after its
 * start. With none qualifying, the lineage's newest member (the last one
 * listed when no time is known).
 */
function pickFactorySessions(ids: readonly string[], st: ActiveScopeStore, startedMs: number) {
  const at = (id: string): number => {
    const t = st.sessionLastEventAt[id];
    return t === undefined ? Number.NaN : Date.parse(t);
  };
  if (!Number.isNaN(startedMs)) {
    const fresh = ids.filter((id) => at(id) >= startedMs);
    if (fresh.length > 0) return fresh;
  } else if (ids.length > 0) {
    return [...ids];
  }
  let newest: string | undefined;
  for (const id of ids) {
    if (newest === undefined || !(at(id) < at(newest))) newest = id;
  }
  return newest === undefined ? [] : [newest];
}
