// Work view (Kanban/Roadmap) switch logic. Pure helpers so
// WorkPage.vue, SegmentedControl and router.ts's legacy redirects stay thin
// and testable without mounting a component or a router.
import type { LocationQueryRaw } from 'vue-router';

export type WorkView = 'kanban' | 'roadmap';

export interface WorkViewDef {
  value: WorkView;
  label: string;
  path: string;
  routeName: 'work-kanban' | 'work-roadmap';
}

export const WORK_VIEWS: WorkViewDef[] = [
  { value: 'kanban', label: 'Kanban', path: '/work/kanban', routeName: 'work-kanban' },
  { value: 'roadmap', label: 'Roadmap', path: '/work/roadmap', routeName: 'work-roadmap' },
];

/** Query params a view switch carries over; everything else (Kanban's
 * `milestone`, Roadmap's `phase`) is dropped (operator decision). */
const CARRIED_QUERY_KEYS = ['epic', 'project', 'session'] as const;

export function switchQuery(query: LocationQueryRaw): LocationQueryRaw {
  const src = query as Record<string, unknown>;
  const out: LocationQueryRaw = {};
  for (const key of CARRIED_QUERY_KEYS) {
    if (src[key] !== undefined) out[key] = src[key] as never;
  }
  return out;
}

export function workViewFromRouteName(name: unknown): WorkView {
  return name === 'work-roadmap' ? 'roadmap' : 'kanban';
}

/** A `redirect` for the retired `/kanban` and `/roadmap` top-level routes:
 * same target, full query string kept (unlike switchQuery, which only
 * carries three keys when the SegmentedControl changes view). */
export function legacyWorkRedirect(targetPath: string) {
  return (to: { query: LocationQueryRaw; hash: string }) => ({
    path: targetPath,
    query: to.query,
    hash: to.hash,
  });
}
