import { isActiveSession } from './activeScope.js';
import type { ActivityScope } from './activityScope.js';
import type { ActiveScopeResult } from './api.js';
import { foreignStoreId, HOME_STORE_ID, type StoreRef, storeKey } from './storeKey.js';

// SessionsPage's deep link (DS8 PR3 item 4): `?session=<id>` is this page's
// own "which run is open" marker, read and written only here -- unlike
// lib/sessionScope.ts's `?session`, which widens or narrows every OTHER
// page's server fetch (timeline, roadmap). The two share a query key, so
// this helper only ever selects an id this page's own history list already
// knows about, rather than trusting the string on faith the way a scope
// reader would. A session id repeats between stores, so `&store=<id>` names
// the store (no `store` means the served one) and the answer is the row's
// storeKey, the page's one key for a selection.
export function selectedSessionFromQuery(
  query: { session?: unknown; store?: unknown },
  sessions: readonly { sessionId: string; store?: StoreRef }[],
): string | null {
  const id = typeof query.session === 'string' ? query.session : null;
  if (!id || (query.store !== undefined && typeof query.store !== 'string')) return null;
  const hit = sessions.find(
    (s) =>
      s.sessionId === id &&
      foreignStoreId(s) === (query.store === HOME_STORE_ID ? undefined : query.store),
  );
  return hit ? storeKey(hit, id) : null;
}

/**
 * The list a scope shows: Active keeps the sessions a live CLI session drives
 * plus the selected one (pinned, so a session that turns quiet under an open
 * detail does not lose its row); All keeps everything. An unmeasured (or not
 * yet loaded) `live` cannot tell active from quiet, so Active shows everything
 * rather than claim nothing is active. A selected id not in the list adds
 * nothing.
 */
export function sessionsInScope<T extends { sessionId: string; store?: StoreRef }>(
  sessions: readonly T[],
  scope: ActivityScope,
  selectedKey: string | null,
  live: ActiveScopeResult | null,
): T[] {
  if (scope === 'all' || live?.measured !== true) return [...sessions];
  return sessions.filter(
    (s) => isSessionActive(live, s) || storeKey(s, s.sessionId) === selectedKey,
  );
}

// SessionsPage.loadAgents() runs for both the poll path and the click path.
// Both ids are storeKeys, so the same session id in two stores is two runs.
// A fetch started for run A can still be in flight when the user clicks run
// B; A's response must not overwrite B's agents once it finally lands. Both
// callers check this before applying their result.
export function isStaleResponse(responseId: string, currentSelectedId: string | null): boolean {
  return responseId !== currentSelectedId;
}

// The active/quiet split, as its own helper rather than inlined in
// SessionsPage.vue. A session is active when a live CLI session is writing
// into it (`/api/active-scope`'s factorySessions), not when an agent row says
// `live` or `working`: those come from the factory's own 4h staleness window
// and read zero while a CLI session is plainly at work. A row with no `store`
// matches the home store.
export function isSessionActive(
  live: ActiveScopeResult | null,
  session: { sessionId: string; store?: StoreRef },
): boolean {
  return isActiveSession(live, session, session.sessionId);
}

/** Names of active projects living outside the home store, each once. */
export function otherStoreProjects(live: ActiveScopeResult | null): string[] {
  if (live?.measured !== true) return [];
  return [
    ...new Set(live.projects.filter((p) => p.storeId !== HOME_STORE_ID).map((p) => p.project)),
  ];
}

/** One project's slice of the Sessions list, newest session first. */
export interface ProjectSessionGroup<T> {
  project: string;
  sessions: T[];
}

function byRecency(a: { lastEventAt: string }, b: { lastEventAt: string }): number {
  return b.lastEventAt.localeCompare(a.lastEventAt);
}

// SessionsPage's unscoped (no project in context) grouping. Pure fold:
// groups by `session.projects`, newest-first within a group, groups ordered
// by their own newest session (the server already hands back sessions
// newest-first, but this sorts again so the result is correct regardless of
// caller order).
//
// A session naming several projects is listed under every one of them --
// `projects: string[]` already represents genuine multi-project membership
// elsewhere (Home's per-project "Running now" cards), so picking just the
// first would hide it from the others' groups. A session naming none (no
// task created yet) goes under the `''` key rather than being dropped --
// SessionsPage renders that key's header as "No project", the same label
// SessionRow.vue already uses for the same case.
export function sessionsByProject<T extends { lastEventAt: string; projects: readonly string[] }>(
  sessions: readonly T[],
): ProjectSessionGroup<T>[] {
  const ordered = [...sessions].sort(byRecency);
  const groups = new Map<string, T[]>();
  for (const s of ordered) {
    const keys = s.projects.length > 0 ? s.projects : [''];
    for (const key of keys) {
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }
  }
  return [...groups.entries()].map(([project, sessions]) => ({ project, sessions }));
}

/** Newest first, then a stable split: active sessions ahead of quiet ones. */
export function activeFirst<T extends { sessionId: string; lastEventAt: string; store?: StoreRef }>(
  sessions: readonly T[],
  live: ActiveScopeResult | null,
): T[] {
  const ordered = [...sessions].sort(byRecency);
  return [
    ...ordered.filter((s) => isSessionActive(live, s)),
    ...ordered.filter((s) => !isSessionActive(live, s)),
  ];
}
