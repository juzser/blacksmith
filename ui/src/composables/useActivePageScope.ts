// The one rule Activity and Cost & quality share for the Active/All scope.
// `resolveActivePageScope` is the pure decision; `useActivePageScope` binds it
// to the route and the shared active-scope read. See ds-spec §4.3 / §4.4 Scope.
import { computed } from 'vue';
import { activeHomeSessionIds } from '../lib/activeScope.js';
import type { ActiveScopeResult } from '../lib/api.js';
import { otherStoreProjects } from '../lib/sessionsSelection.js';
import { useActiveScope } from './useActiveScope.js';
import { useActivityScope } from './useActivityScope.js';

export type ActivePageMode =
  | 'explicit' // a ?session= / ?task= / ?epic= filter names its own scope
  | 'all'
  | 'loading' // Active, the scope read still in flight: hold, fetch nothing
  | 'unmeasured' // Active, live sessions unreadable: fetch All, say so
  | 'narrowed' // Active, measured, home-store sessions to narrow to
  | 'empty'; // Active, measured, none in this store: fetch nothing

export type ActiveEdge = 'nothing-live' | 'none-on-epic' | 'none-here';

export interface ActivePageScope {
  mode: ActivePageMode;
  /** false only while loading or empty: the page must not fetch. */
  fetchable: boolean;
  /** The `sessions` list to send; undefined sends nothing. */
  sessions: string[] | undefined;
  showToggle: boolean;
  /** Which edge line an empty Active view shows. */
  edge: ActiveEdge | null;
  /** Changes when the fetch should be redone, not on every fresh scope object. */
  key: string;
}

export function resolveActivePageScope(input: {
  scope: 'active' | 'all';
  explicit: boolean;
  active: ActiveScopeResult | null;
  settled: boolean;
}): ActivePageScope {
  const done = (mode: ActivePageMode, extra: Partial<ActivePageScope> = {}): ActivePageScope => ({
    mode,
    fetchable: mode !== 'loading' && mode !== 'empty',
    sessions: undefined,
    showToggle: mode !== 'explicit',
    edge: null,
    key: mode,
    ...extra,
  });
  if (input.explicit) return done('explicit');
  if (input.scope === 'all') return done('all');
  if (input.active === null && !input.settled) return done('loading');
  const ids = activeHomeSessionIds(input.active);
  if (ids === null || input.active === null) return done('unmeasured');
  if (ids.length > 0)
    return done('narrowed', { sessions: ids, key: `narrowed\n${ids.join('\n')}` });
  const edge: ActiveEdge =
    input.active.liveSessions === 0
      ? 'nothing-live'
      : input.active.factorySessions.length === 0 && input.active.unlinkedSessions > 0
        ? 'none-on-epic'
        : 'none-here';
  return done('empty', { edge });
}

export function useActivePageScope(explicit: () => boolean) {
  const { scope, scopeTo } = useActivityScope();
  const { scope: active, settled } = useActiveScope();
  const view = computed(() =>
    resolveActivePageScope({
      scope: scope.value,
      explicit: explicit(),
      active: active.value,
      settled: settled.value,
    }),
  );
  // Under Active, the line about projects whose sessions live in another store.
  const otherStores = computed(() =>
    view.value.mode === 'explicit' || scope.value !== 'active'
      ? []
      : otherStoreProjects(active.value),
  );
  return { view, active, otherStores, scopeTo };
}
