// The log-order vocabulary, split out of events.ts (the log's I/O hub) so a
// pure reader can order events without pulling in filesystem access.
// errorIssues.ts is that reader: task-2's purity clauses keep it free of any
// runtime import from `./events.js`, so this module has NO import statement
// at all — not even `./errors.js` — and its transitive import graph is
// empty.

export interface ParsedEventId {
  sessionId: string;
  index: number;
}

/**
 * Split an event id into the session that owns it and its line index.
 *
 * Event ids have always been `<session-id>#<index>` — that shape is what makes
 * a cross-session reference resolvable at all (P9-7): given only the id, a
 * reader knows which log file to open. Splitting on the LAST `#` keeps a
 * session id that happens to contain one from silently resolving to the wrong
 * session.
 *
 * This is the ONE parser of that shape. Unlike `parseEventId` in
 * `events.ts` (the throwing wrapper callers reach for at the log's edges),
 * this never throws — it returns `null` for anything malformed, including a
 * non-string reached through a cast, so a pure comparator can stay total.
 */
export function tryParseEventId(eventId: string): ParsedEventId | null {
  if (typeof eventId !== 'string') return null;
  const cut = eventId.lastIndexOf('#');
  const sessionId = cut === -1 ? '' : eventId.slice(0, cut);
  const rawIndex = eventId.slice(cut + 1);
  // Number.parseInt would accept "3abc"; an event id is exact or it is a typo.
  const index = /^\d+$/.test(rawIndex) ? Number(rawIndex) : Number.NaN;
  if (cut === -1 || sessionId.length === 0 || Number.isNaN(index)) return null;
  return { sessionId, index };
}

/**
 * Where an event sits in the order the log actually wrote it.
 *
 * An event id is `<session-id>#<index>` and the index is the event's line in
 * its session's log, so within a session this *is* the order rather than a
 * proxy for it. Across sessions the logs are separate files that nothing
 * interleaves, so the session id is here to make the answer the same on every
 * call, not because one session precedes another.
 *
 * Total where tryParseEventId returns null, and the fallback is unreachable
 * by construction — every id this sees came out of readEvents() or a
 * projection of it, and readEvents builds each one as `<session>#<index>`. It
 * is here because the readers on top of this are a dashboard `/api/pulse`
 * polls every 5s and two audits the operator runs on a whole log, and an id
 * that somehow would not parse should sort somewhere rather than take the
 * caller down with it. Where it lands is deliberately modest: an event whose
 * place in the log is unreadable does not get to win a tie on it.
 */
function logOrderOf(eventId: string): ParsedEventId {
  return tryParseEventId(eventId) ?? { sessionId: eventId, index: -1 };
}

/**
 * The order the log wrote two events in: negative when `a` came first,
 * positive when `b` did, zero only for the same event.
 *
 * `ts` is stamped at millisecond resolution (`appendEvent` in `events.ts`
 * stamps it), so a burst of appends routinely shares one: the test fixture's
 * own last two events tie in roughly one build in three, and a gate outcome
 * and the retry dispatched in answer to it are written back to back. Nothing
 * else in the record carries the sequence — `events_raw` has no such column
 * and the JSONL line has no such field — so on a tie `ts` has nothing left to
 * say, and nothing downstream of it does either. A `>` between two tied rows
 * is not a decision, it is whichever the scan reached first; `ORDER BY ts` is
 * the same non-answer spelled in SQL, since SQLite promises nothing about
 * tied rows and hands them back in physical order, which changes the moment a
 * row is rewritten; and a JS `.sort()` whose comparator returns 0 throughout
 * is stable, so it keeps that same scan order and passes it off as
 * chronology.
 *
 * The log index behind the event id is what actually decides, and it has to
 * be read as a number: ordered as text — which is what `ORDER BY ts,
 * event_id` does — `#9` sorts after `#10`, so the tiebreaker inverts as soon
 * as a session's log passes ten events.
 *
 * It lives here, below `events.ts`, rather than in any one reader because
 * more than one of them asks this question: the dashboard queries fold and
 * sort rows, escalation.ts walks a task's rounds looking for the dispatch on
 * either side of one, and errorIssues.ts's pure fold needs the same answer
 * without importing the fs hub that owns the log's I/O. Every ordering a
 * reader would call chronological routes through here, so that no two of them
 * can answer the same question about the same two events differently — which
 * is exactly what happened when the callers spelled the comparison
 * themselves, with opposite operators.
 */
export function compareLogOrder(
  a: { ts: string; eventId: string },
  b: { ts: string; eventId: string },
): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  const left = logOrderOf(a.eventId);
  const right = logOrderOf(b.eventId);
  if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1;
  return left.index - right.index;
}

/**
 * Whether `a` is the later of two events — the one a reader means by "what
 * just happened".
 */
export function isLaterEvent(
  a: { ts: string; eventId: string },
  b: { ts: string; eventId: string },
): boolean {
  return compareLogOrder(a, b) > 0;
}
