/**
 * Reads that span every store: run the ordinary query against each store's
 * database, tag what comes back with `store: {id, label}`, and combine in
 * TypeScript. Nothing here reimplements a query.
 *
 * Two things differ for a foreign store. Its rows carry the default project
 * name (`blacksmith`) unless the project said otherwise, which would make every
 * foreign project read as the factory itself, so the default is replaced by the
 * store's label. And a `?project=<label>` filter has to be translated back into
 * the default name before it reaches that store's own query.
 */

import type { SmithDb } from '../../../factory/orchestrator/dist/db/projector.js';
import type {
  KanbanColumn,
  KanbanTask,
  OverviewResult,
} from '../../../factory/orchestrator/dist/db/queries.js';
import { DEFAULT_PROJECT } from '../../../factory/orchestrator/dist/db/queries.js';
import type { StoreEntry, StoreRef } from './stores.js';

export type Tagged<T> = T & { store: StoreRef };

const ref = (e: StoreEntry): StoreRef => ({ id: e.id, label: e.label });
const tag = <T extends object>(rows: T[], store: StoreRef): Tagged<T>[] =>
  rows.map((r) => ({ ...r, store }));

/** Replaces the default project name with `label` wherever a foreign row carries it. */
export function relabelProject<T>(value: T, label: string): T {
  if (Array.isArray(value)) return value.map((v) => relabelProject(v, label)) as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'project' && (v === null || v === DEFAULT_PROJECT)) out[key] = label;
    else if (key === 'projects' && Array.isArray(v)) {
      out[key] = v.map((p) => (p === DEFAULT_PROJECT ? label : relabelProject(p, label)));
    } else if (key === 'epicLabel' && typeof v === 'string') {
      out[key] = v.startsWith(`${DEFAULT_PROJECT}: `)
        ? `${label}: ${v.slice(DEFAULT_PROJECT.length + 2)}`
        : v;
    } else out[key] = relabelProject(v, label);
  }
  return out as T;
}

/**
 * Runs `query` against every store. `project` is the requested filter; a
 * foreign store gets `undefined` back when the filter names another store, or
 * is skipped outright when it can hold no row of that project.
 */
export function fanOut<T>(
  entries: StoreEntry[],
  project: string | undefined,
  query: (db: SmithDb, project: string | undefined) => T,
): { store: StoreRef; data: T }[] {
  const parts: { store: StoreRef; data: T }[] = [];
  for (const e of entries) {
    if (e.home) {
      parts.push({ store: ref(e), data: query(e.handle.db, project) });
      continue;
    }
    if (project === DEFAULT_PROJECT && e.label !== DEFAULT_PROJECT) continue;
    try {
      const data = query(e.handle.db, project === e.label ? DEFAULT_PROJECT : project);
      parts.push({ store: ref(e), data: relabelProject(data, e.label) });
    } catch {
      // A foreign cache that cannot be read is one store fewer, never a 500.
    }
  }
  return parts;
}

const byStore = (a: { store: StoreRef }, b: { store: StoreRef }) =>
  a.store.id.localeCompare(b.store.id);
const sum = (parts: { data: OverviewResult }[], f: (o: OverviewResult) => number) =>
  parts.reduce((n, p) => n + f(p.data), 0);

/** Combines per-store overviews. Order is untouched while only one store reports. */
export function mergeOverview(
  parts: { store: StoreRef; data: OverviewResult }[],
): Record<string, unknown> {
  const first = parts[0]?.data;
  const many = parts.length > 1;
  const rows = <
    K extends
      | 'liveAgentEntries'
      | 'runningSessions'
      | 'closedEpics'
      | 'tokensByEpic'
      | 'milestoneProgress'
      | 'recentDispatches',
  >(
    key: K,
  ) =>
    parts.flatMap((p) => tag(p.data[key] as object[], p.store)) as Tagged<
      OverviewResult[K][number]
    >[];
  const groups = new Map<string, OverviewResult['liveAgents'][number]>();
  for (const p of parts) {
    for (const g of p.data.liveAgents) {
      const k = `${g.agentRole}|${g.provider}|${g.modelTier}`;
      groups.set(k, { ...g, count: (groups.get(k)?.count ?? 0) + g.count });
    }
  }
  const strings = (key: 'epicsInFlight' | 'epicsActivelyRunning') => [
    ...new Set(parts.flatMap((p) => p.data[key])),
  ];
  const withStore = (key: 'epicsInFlight' | 'epicsActivelyRunning') =>
    parts.flatMap((p) => p.data[key].map((epicId) => ({ epicId, store: p.store })));
  const projects = parts.flatMap((p) => tag(p.data.projects ?? [], p.store));
  const sorted = <T>(list: T[], cmp: (a: T, b: T) => number): T[] =>
    many ? [...list].sort(cmp) : list;
  const newest = (a: string, b: string) => (a === b ? 0 : a < b ? 1 : -1);
  return {
    ...first,
    liveAgents: [...groups.values()],
    liveAgentEntries: rows('liveAgentEntries'),
    liveAgentCount: sum(parts, (o) => o.liveAgentCount),
    workingAgentCount: sum(parts, (o) => o.workingAgentCount),
    stalledAgentCount: sum(parts, (o) => o.stalledAgentCount),
    runningSessions: sorted(
      rows('runningSessions'),
      (a, b) => newest(a.lastEventAt, b.lastEventAt) || byStore(a, b),
    ),
    epicsInFlight: strings('epicsInFlight'),
    epicsActivelyRunning: strings('epicsActivelyRunning'),
    epicsInFlightByStore: withStore('epicsInFlight'),
    epicsActivelyRunningByStore: withStore('epicsActivelyRunning'),
    closedEpics: sorted(
      rows('closedEpics'),
      (a, b) => newest(a.closedAt, b.closedAt) || byStore(a, b),
    ),
    tokensByEpic: sorted(
      rows('tokensByEpic'),
      (a, b) => a.epicId.localeCompare(b.epicId) || byStore(a, b),
    ),
    alerts: {
      escalations: sum(parts, (o) => o.alerts.escalations),
      pendingWaivers: sum(parts, (o) => o.alerts.pendingWaivers),
    },
    milestoneProgress: rows('milestoneProgress'),
    recentDispatches: sorted(
      rows('recentDispatches'),
      (a, b) => newest(a.ts, b.ts) || byStore(a, b),
    ).slice(0, 10),
    liveAgentCountDelta5m: sum(parts, (o) => o.liveAgentCountDelta5m),
    workingAgentCountDelta5m: sum(parts, (o) => o.workingAgentCountDelta5m),
    // Budgets are per store and not comparable; the home store's own movement stands.
    budgetUsedPctPointDelta1h: first?.budgetUsedPctPointDelta1h ?? null,
    ...(first?.projects === undefined
      ? {}
      : {
          projects: sorted(projects, (a, b) => a.project.localeCompare(b.project) || byStore(a, b)),
        }),
  };
}

/** Combines per-store boards: same columns, tasks re-sorted the way one store sorts them. */
export function mergeKanban(
  parts: { store: StoreRef; data: KanbanColumn[] }[],
): { taskStatus: string; tasks: Tagged<KanbanTask>[] }[] {
  const columns = new Map<string, Tagged<KanbanTask>[]>();
  for (const p of parts) {
    for (const col of p.data) {
      columns.set(col.taskStatus, [
        ...(columns.get(col.taskStatus) ?? []),
        ...tag(col.tasks, p.store),
      ]);
    }
  }
  return [...columns.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([taskStatus, tasks]) => ({
      taskStatus,
      tasks:
        parts.length > 1
          ? tasks.sort((a, b) =>
              a.updatedAt !== b.updatedAt
                ? a.updatedAt < b.updatedAt
                  ? 1
                  : -1
                : a.taskId.localeCompare(b.taskId) || byStore(a, b),
            )
          : tasks,
    }));
}
