// The one definition of "active" for `GET /api/active-scope`: what the operator's
// live Claude Code CLI sessions are driving. A pure fold; app.ts gathers the
// inputs (the cli-sessions read, and each store's overview slices).
//
// Prompt-free by construction: the result is built field by field from ids,
// project names, store ids and counts, so no session name, cwd, prompt or
// transcript text can ride along.
//
// Home's fact strip reads four totals over one set. S is the active epics
// (`epics`); A is the live sessions linked to at least one epic in S. Agents
// add up over A; tokens and tasks add up over S, each epic once however many
// sessions drive it.
import { EPIC_IDLE_MS, type StatusCounts } from '../../../factory/orchestrator/dist/db/queries.js';
import { type CliSessionsResponse, HOME_STORE_ID, type StoreRef } from './cliSessions.js';

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
        /** The store closed this epic; it never counts as active. */
        closed: boolean;
        factorySessionIds: string[];
        /** Per member, the newest event THIS CLI session wrote into it. */
        factorySessionLastEventAt: Record<string, string>;
        workingAgents: { role: string; taskId: string | null; since: string }[];
        /** The epic's plan-task counts; null when it has no task rows. */
        progress: StatusCounts | null;
      }[];
    } | null;
    /** Subagents this session has running now; null when not measured. */
    subagentsRunning: number | null;
  }[];
}

/** One store's overview slices: taken from overview(), never re-derived. */
export interface ActiveScopeStore {
  store: StoreRef;
  /** `overview().epicsActivelyRunning`, the set Home's "Running now" reads. */
  activelyRunning: string[];
  /** epic id -> project, from the overview's per-project `epicsInFlight`. */
  epicProjects: Record<string, string>;
  /** epic id -> spend, from `overview().tokensByEpic`. */
  tokens: Record<string, { tokensSpent: number; unmeasured: number }>;
}

export interface ActiveScope {
  measured: boolean;
  readAt: string;
  liveSessions: number;
  unlinkedSessions: number;
  /** |A|: live sessions linked to at least one active epic. */
  activeSessions: number;
  /**
   * Over A, each group of sessions and the active epics they share counts
   * the larger of its sessions' running subagents and its epics' working
   * factory agents, so an agent seen both ways counts once. Nested
   * subagents are not counted, so this is a floor.
   */
  agentsRunning: number;
  /** Sessions in A whose subagents could not be counted. */
  agentsUnmeasured: number;
  /** Over the active epics, each once. */
  tokensSpent: number;
  /** Runs on the active epics whose tokens were not measured. */
  tokensUnmeasured: number;
  tasksDone: number;
  /** done + review + inProgress + todo; superseded tasks are left out. */
  tasksTotal: number;
  projects: {
    storeId: string;
    project: string;
    liveSessions: number;
    agentsWorking: number;
    /** The project's share of the totals above. */
    activeSessions: number;
    agentsRunning: number;
    agentsUnmeasured: number;
  }[];
  epics: {
    storeId: string;
    epicId: string;
    project: string | null;
    tokensSpent: number;
    tokensUnmeasured: number;
    tasksDone: number;
    tasksTotal: number;
  }[];
  factorySessions: { storeId: string; sessionId: string }[];
}

/** What the route answers: the fold, plus stores it could not read. */
export type ActiveScopeResponse = ActiveScope & {
  /** Readable stores whose overview failed; the counts may be low. */
  storesUnread: number;
};

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
      activeSessions: 0,
      agentsRunning: 0,
      agentsUnmeasured: 0,
      tokensSpent: 0,
      tokensUnmeasured: 0,
      tasksDone: 0,
      tasksTotal: 0,
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
      /** Sessions in A with an active epic of this project. */
      active: Set<number>;
      /** Each session in `active`, with this project's active epics it links. */
      activeEpics: Map<number, Set<string>>;
    }
  >();
  const epics = new Map<string, ActiveScope['epics'][number]>();
  const factory = new Map<string, ActiveScope['factorySessions'][number]>();
  /** A, by session index. */
  const active = new Set<number>();
  /** Each session in A, with the active epics it links (store + epic id). */
  const sessionEpics = new Map<number, Set<string>>();
  /** Working factory agents of each active epic, keyed with its store. */
  const epicAgents = new Map<string, Set<string>>();
  let unlinked = 0;

  cli.sessions.forEach((s, index) => {
    const entries = s.linked?.epics ?? [];
    if (entries.length === 0) {
      unlinked++;
      return;
    }
    const startedMs = s.startedAt === null ? Number.NaN : Date.parse(s.startedAt);
    const nowMs = Date.parse(nowIso);
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
        // Active: not closed, and either the store's running set holds it, or
        // this CLI session is writing into it now (an epic with no task rows
        // yet, in its research step, is in no running set).
        const running = st?.activelyRunning.includes(e.epicId) === true;
        if (
          e.closed ||
          !(
            running ||
            writtenSinceStart(e.factorySessionIds, e.factorySessionLastEventAt, startedMs, nowMs)
          )
        )
          continue;
        project = projectOf();
        active.add(index);
        const key = `${e.store.id}\u0000${e.epicId}`;
        const spend = st?.tokens[e.epicId];
        const known = epics.get(key);
        if (known === undefined) {
          epics.set(key, {
            storeId: e.store.id,
            epicId: e.epicId,
            project,
            tokensSpent: spend?.tokensSpent ?? 0,
            tokensUnmeasured: spend?.unmeasured ?? 0,
            ...taskCounts(e.progress),
          });
        } else if (known.tasksTotal === 0 && e.progress !== null) {
          Object.assign(known, taskCounts(e.progress));
        }
        const mine = sessionEpics.get(index) ?? new Set<string>();
        mine.add(key);
        sessionEpics.set(index, mine);
        const agents = epicAgents.get(key) ?? new Set<string>();
        for (const a of e.workingAgents) agents.add(agentKey(e.epicId, a));
        epicAgents.set(key, agents);
        for (const id of pickFactorySessions(
          e.factorySessionIds,
          e.factorySessionLastEventAt,
          startedMs,
        )) {
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
          active: new Set(),
          activeEpics: new Map(),
        };
        projects.set(pkey, p);
      }
      p.sessions.add(index);
      if (e.epicId !== null) {
        // Only an active epic reaches here with an id (the rest `continue`d).
        p.active.add(index);
        const mine = p.activeEpics.get(index) ?? new Set<string>();
        mine.add(`${e.store.id}\u0000${e.epicId}`);
        p.activeEpics.set(index, mine);
        for (const a of e.workingAgents) p.agents.add(agentKey(e.epicId, a));
      }
    }
  });

  const all = countAgents(cli, sessionEpics, epicAgents);
  const epicList = [...epics.values()];
  const sum = (pick: (e: ActiveScope['epics'][number]) => number) =>
    epicList.reduce((n, e) => n + pick(e), 0);

  return {
    measured: true,
    readAt: cli.readAt,
    liveSessions: cli.sessions.length,
    unlinkedSessions: unlinked,
    activeSessions: active.size,
    agentsRunning: all.running,
    agentsUnmeasured: all.unmeasured,
    tokensSpent: sum((e) => e.tokensSpent),
    tokensUnmeasured: sum((e) => e.tokensUnmeasured),
    tasksDone: sum((e) => e.tasksDone),
    tasksTotal: sum((e) => e.tasksTotal),
    projects: [...projects.values()].map((p) => {
      const mine = countAgents(cli, p.activeEpics, epicAgents);
      return {
        storeId: p.storeId,
        project: p.project,
        liveSessions: p.sessions.size,
        agentsWorking: p.agents.size,
        activeSessions: p.active.size,
        agentsRunning: mine.running,
        agentsUnmeasured: mine.unmeasured,
      };
    }),
    epics: epicList,
    factorySessions: [...factory.values()],
  };
}

/**
 * Agents running over the given sessions, each with the active epics it
 * links. Sessions that share an epic form one group (a session on two epics
 * joins them). A group counts max(its sessions' running subagents, its epics'
 * working factory agents): the factory's agents are dispatched as subagents
 * of the session running the epic, so the two counts overlap by an unknown
 * amount and the larger is the floor that never counts one agent twice. A
 * session whose subagents could not be counted adds to `unmeasured`.
 */
function countAgents(
  cli: ActiveScopeCli,
  sessions: ReadonlyMap<number, ReadonlySet<string>>,
  epicAgents: ReadonlyMap<string, ReadonlySet<string>>,
): { running: number; unmeasured: number } {
  // Union-find over session indexes, joined through shared epic keys.
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) r = parent.get(r) as number;
    parent.set(i, r);
    return r;
  };
  const firstOfEpic = new Map<string, number>();
  for (const [i, epicKeys] of sessions) {
    if (!parent.has(i)) parent.set(i, i);
    for (const k of epicKeys) {
      const first = firstOfEpic.get(k);
      if (first === undefined) firstOfEpic.set(k, i);
      else parent.set(find(i), find(first));
    }
  }
  const subs = new Map<number, number>();
  const agents = new Map<number, Set<string>>();
  let unmeasured = 0;
  for (const i of sessions.keys()) {
    const n = cli.sessions[i]?.subagentsRunning ?? null;
    const root = find(i);
    if (n === null) unmeasured++;
    else subs.set(root, (subs.get(root) ?? 0) + n);
    if (!subs.has(root)) subs.set(root, 0);
  }
  for (const [k, i] of firstOfEpic) {
    const root = find(i);
    const set = agents.get(root) ?? new Set<string>();
    for (const a of epicAgents.get(k) ?? []) set.add(`${k}\u0000${a}`);
    agents.set(root, set);
  }
  let running = 0;
  for (const [root, n] of subs) running += Math.max(n, agents.get(root)?.size ?? 0);
  return { running, unmeasured };
}

/** A working factory agent, the same one whichever session links its epic. */
function agentKey(
  epicId: string,
  a: { role: string; taskId: string | null; since: string },
): string {
  return `${epicId}\u0000${a.role}\u0000${a.taskId ?? ''}\u0000${a.since}`;
}

/** Plan tasks done, out of all but the superseded. No rows: 0 of 0. */
function taskCounts(c: StatusCounts | null): { tasksDone: number; tasksTotal: number } {
  if (c === null) return { tasksDone: 0, tasksTotal: 0 };
  return { tasksDone: c.done, tasksTotal: c.done + c.review + c.inProgress + c.todo };
}

/**
 * Whether this CLI session wrote into one of the members at or after it
 * started (the test pickFactorySessions makes), with the newest such write
 * inside the overview's idle window of now. No known start: no.
 */
function writtenSinceStart(
  ids: readonly string[],
  lastEventAt: Readonly<Record<string, string>>,
  startedMs: number,
  nowMs: number,
): boolean {
  if (Number.isNaN(startedMs)) return false;
  let newest = Number.NaN;
  for (const id of ids) {
    const t = lastEventAt[id];
    const at = t === undefined ? Number.NaN : Date.parse(t);
    if (at >= startedMs && (Number.isNaN(newest) || at > newest)) newest = at;
  }
  return !Number.isNaN(newest) && nowMs - newest <= EPIC_IDLE_MS;
}

/**
 * The lineage members this CLI session wrote to: last event at or after its
 * start. With none qualifying, the lineage's newest member (the last one
 * listed when no time is known).
 */
function pickFactorySessions(
  ids: readonly string[],
  lastEventAt: Readonly<Record<string, string>>,
  startedMs: number,
) {
  const at = (id: string): number => {
    const t = lastEventAt[id];
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
    if (newest === undefined) newest = id;
    else if (Number.isNaN(at(id)) && !Number.isNaN(at(newest))) continue;
    else if (Number.isNaN(at(newest)) || at(id) >= at(newest)) newest = id;
  }
  return newest === undefined ? [] : [newest];
}
