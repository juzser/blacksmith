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
