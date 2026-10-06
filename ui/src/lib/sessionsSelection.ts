// SessionsPage's deep link (DS8 PR3 item 4): `?session=<id>` is this page's
// own "which run is open" marker, read and written only here -- unlike
// lib/sessionScope.ts's `?session`, which widens or narrows every OTHER
// page's server fetch (timeline, roadmap). The two share a query key, so
// this helper only ever selects an id this page's own history list already
// knows about, rather than trusting the string on faith the way a scope
// reader would.
export function selectedSessionFromQuery(
  query: { session?: unknown },
  sessions: readonly { sessionId: string }[],
): string | null {
  const id = typeof query.session === 'string' ? query.session : null;
  if (id && sessions.some((s) => s.sessionId === id)) return id;
  return null;
}

// SessionsPage.loadAgents() runs for both the poll path and the click path.
// A fetch started for run A can still be in flight when the user clicks run
// B; A's response must not overwrite B's agents once it finally lands. Both
// callers check this before applying their result.
export function isStaleResponse(responseId: string, currentSelectedId: string | null): boolean {
  return responseId !== currentSelectedId;
}

// The running/finished split, as its own helper rather than inlined in
// SessionsPage.vue: `liveAgentCount > 0` includes stale ghosts (an agent row
// still `live` because its run crashed before a terminal event landed), the
// exact trap documented at api.ts's RunningSession.workingAgentCount and the
// design spec §2. `workingAgentCount` narrows to agents dispatched within
// the factory's own 4h staleness window, so a session with live-but-stale
// agents (liveAgentCount > 0, workingAgentCount 0) now lands in finished/
// quiet rather than running.
export function isSessionActive(session: { workingAgentCount: number }): boolean {
  return session.workingAgentCount > 0;
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
