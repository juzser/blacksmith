// The session half of the dashboard's scope: which run is being asked about,
// and whether the question reaches that run's lineage.
//
// The server has answered both since D-263/D-264 -- `sessionScope(c)` in
// ui/server/src/app.ts reads `?session` and `?lineage`, eleven routes spread
// it, and projectedLineage() walks the causal edges down as well as up (D-266).
// Nothing sent either. That was deliberate at the time: "a session picker in
// the UI is a feature in its own right, not a line in this one, and shipping
// the parameter first would be building a road to a door that does not exist
// yet". This is the door.
//
// It matters more now than it did then, because an epic no longer runs in one
// session. The epic tier plans and closes, the wave tier runs steps 2-10 in a
// session of its own, and a dispatched wave-runner opens a third -- so "what
// did this epic do" is a question about a lineage, and the dashboard had no
// way to ask it about anything narrower than the whole state dir.
//
// Kept out of App.vue and out of api.ts for the reason epicPicker.ts states:
// .vue files are checked by neither tsc nor biome here, and api.ts is
// excluded from this suite's coverage as the layer ui/e2e exercises. Rules
// that live in either have no gate on them. These have sessionScope.test.ts.

/** Structurally the option shape Select.vue declares. Not imported for the
 *  reason epicPicker.ts gives: shims.d.ts types every `.vue` module as a
 *  default export, so a named type cannot cross out of an SFC. */
export interface SessionOption {
  value: string;
  label: string;
}

/**
 * A scope the server will accept, by construction.
 *
 * `session` is required, so the pair app.ts refuses -- a `lineage` with no
 * `session` to widen, on the argument that "a lineage is resolved from a
 * session, and every session at once is not one" -- cannot be built here at
 * all. That is the whole reason this is an object rather than the two loose
 * parameters the query string carries: the refusal becomes unrepresentable
 * instead of remembered.
 */
export interface SessionScope {
  session: string;
  /** Widen to the session's causal lineage, ancestors and descendants both. */
  lineage?: boolean;
}

/** The picker's "don't filter" choice, and what the `session` query param
 *  reads as when absent. */
export const ALL_SESSIONS = '';

/** The two widths app.ts implements. Values, not booleans, because they are
 *  what a <select> binds to. */
export const WIDTH_SESSION = 'session';
export const WIDTH_LINEAGE = 'lineage';

export const SCOPE_WIDTH_OPTIONS: readonly SessionOption[] = [
  { value: WIDTH_SESSION, label: 'This session' },
  { value: WIDTH_LINEAGE, label: 'With its lineage' },
];

/**
 * How many sessions the picker offers.
 *
 * queries.ts's runningSessions() is misnamed: it returns every row in the
 * `sessions` table in scope, not the live ones. A month-old state dir has
 * hundreds, and a picker that long is a picker nobody scrolls. The list is
 * ordered by last event, so the cap keeps the runs an operator is actually
 * looking at -- and sessionOptions() never lets it drop the current
 * selection.
 */
export const SESSION_OPTION_CAP = 25;

/**
 * Which routes show the topbar session picker (App.vue).
 *
 * Same IFF as SCOPABLE_ROUTES, for the same reason and stated before it costs
 * anything: a page shows the picker if and only if it consumes the scope.
 * Shown but unread is a control that does nothing; read but unsettable is a
 * filter the operator can neither see nor clear, which is what D-216 was.
 * sessionScope.test.ts derives the expected set from router.ts plus the page
 * sources and fails on drift.
 *
 * Not one page per endpoint. Three that accept the param are deliberately
 * absent: Roadmap and Lessons take it upstream but read as repo-wide
 * artifacts -- a milestone's progress is not a property of the run that
 * happened to advance it -- and the Projects hub is the one page whose job is
 * to sit above every scope there is. The eleventh, /api/sessions, is this
 * picker's own feed and belongs to no page at all.
 */
export const SESSION_SCOPABLE_ROUTES: ReadonlySet<string> = new Set([
  'overview-global',
  'overview-project',
  // The headline case: a screenful of dispatched wave-runners, and the only
  // question worth asking of it is "which of these belong to my epic".
  'sessions',
  'timeline',
  'kanban',
  'flow',
  'errors',
  'analytics',
]);

/** What sessionOptions() needs off a RunningSession. Structural, so the
 *  overview payload satisfies it without being imported. */
export interface SessionPickerEntry {
  sessionId: string;
  liveAgentCount: number;
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The scope carried by a route query, or none.
 *
 * Total, and every value it returns is a request /api/* accepts -- so no page
 * on a scopable route can render a 400 it did not ask for. Two readings are
 * worth naming:
 *
 * An unreadable `lineage` fails NARROW. The server 400s on one because it has
 * a caller to tell; the URL bar has nobody, so the choice here is between
 * showing less than was asked and showing more. Less is an error the operator
 * can see -- the width control reads "This session" and one click fixes it.
 * More is an error that looks like an answer: a child wave's failure
 * attributed to the parent run, with nothing on screen saying the scope was
 * widened on a guess.
 *
 * A repeated `session` is no scope at all. Vue Router hands `?session=a&
 * session=b` over as an array, and that is two answers to a single-choice
 * control; picking one of them would be inventing a scope.
 */
export function readSessionScope(query: Record<string, unknown>): SessionScope | undefined {
  const session = firstString(query.session);
  if (session === undefined || session === ALL_SESSIONS) return undefined;
  return firstString(query.lineage) === 'true' ? { session, lineage: true } : { session };
}

/**
 * Write a scope onto an outgoing query. The ONE place `session` and `lineage`
 * are set, which is the point of it: they are two params that mean one thing,
 * and a fetch that sets the first and forgets the second sends a narrower
 * scope than the operator selected, silently and successfully.
 *
 * `lineage=false` is omitted rather than sent, because it is what the server
 * defaults to -- one spelling for one meaning.
 */
export function applySessionScope(q: URLSearchParams, scope?: SessionScope): void {
  if (!scope?.session) return;
  q.set('session', scope.session);
  if (scope.lineage) q.set('lineage', 'true');
}

/**
 * A stable string for one scope, for pages to watch.
 *
 * They watch this and not the scope itself because the scope is a computed
 * that rebuilds `{ session }` whenever the route query changes -- a fresh
 * object every time, unequal to the last by reference, so a watcher on it
 * would re-fetch on an unrelated `?project=` or `?epic=` edit.
 */
export function sessionScopeKey(scope: SessionScope | undefined): string {
  if (!scope) return '';
  return scope.lineage ? `${scope.session}#lineage` : scope.session;
}

/** The width control's value for a scope. Answers for the no-scope state too:
 *  a <select> renders nothing selected for a value it does not carry, and the
 *  shell should not have to know that the control is hidden there. */
export function scopeWidth(scope: SessionScope | undefined): string {
  return scope?.lineage ? WIDTH_LINEAGE : WIDTH_SESSION;
}

/**
 * The scope the width control produces. Returns none without a session to
 * widen -- the type says a lineage cannot exist alone and this is where that
 * stops being a claim -- and narrows on a width it does not recognise, the
 * same asymmetry readSessionScope() keeps.
 */
export function withScopeWidth(
  scope: SessionScope | undefined,
  width: string,
): SessionScope | undefined {
  if (!scope?.session) return undefined;
  return width === WIDTH_LINEAGE
    ? { session: scope.session, lineage: true }
    : { session: scope.session };
}

/**
 * The picker's options: the all-sessions escape hatch, then the runs the
 * overview reported, most recently active first, capped.
 *
 * `selected` is threaded in rather than applied by the caller because the cap
 * and the selection interact: a selection past the cap, or one the list does
 * not know about at all (typed into the URL, or belonging to a project the
 * page is no longer scoped to), still has to be an option. D-43's argument at
 * one layer up -- a <select> shows nothing selected for a value it does not
 * carry, so the control would read "All sessions" while every page stayed
 * filtered to a run the operator can no longer clear.
 */
export function sessionOptions(
  sessions: readonly SessionPickerEntry[],
  selected: string,
): SessionOption[] {
  const seen = new Set<string>([ALL_SESSIONS]);
  const options: SessionOption[] = [{ value: ALL_SESSIONS, label: 'All sessions' }];
  for (const session of sessions) {
    if (seen.has(session.sessionId)) continue;
    if (options.length > SESSION_OPTION_CAP) break;
    seen.add(session.sessionId);
    options.push({ value: session.sessionId, label: sessionLabel(session) });
  }
  if (selected !== ALL_SESSIONS && !seen.has(selected)) {
    const known = sessions.find((s) => s.sessionId === selected);
    options.push({ value: selected, label: known ? sessionLabel(known) : selected });
  }
  return options;
}

/** The id, plus the one fact that tells a screenful of dispatched runs apart:
 *  how many agents are still live under it. Omitted at zero rather than
 *  written as "0 live" -- most rows in the list are finished runs, and a
 *  column of zeroes is noise in front of the ids being scanned. */
function sessionLabel(session: SessionPickerEntry): string {
  return session.liveAgentCount > 0
    ? `${session.sessionId} · ${session.liveAgentCount} live`
    : session.sessionId;
}
