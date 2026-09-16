// The pure half of the change stream (design-spec.md's 2026-09-15 addendum to
// §8). Everything here is a function of its arguments: parsing one frame, and
// deciding whether the interval fallback should be running given what the
// stream is doing. The EventSource itself — the part that needs a browser —
// lives in composables/useEventStream.ts, because ui/vitest.config.ts runs
// `environment: 'node'` and covers ui/src/lib/** on purpose.

/**
 * One fact from an `advanced` frame: a session's log grew, and to how many
 * events. The server's SessionAdvance (ui/server/src/app.ts), restated here
 * rather than imported because ui/ and ui/server/ are separate tsconfig
 * projects and a type import across them would drag the server's whole
 * module graph into the browser bundle.
 *
 * Deliberately not a status. Architecture §18 rules 1 and 2: a page derives
 * what it shows from the query it refetches, never from the wire.
 */
export interface SessionAdvance {
  session: string;
  events: number;
}

/**
 * What the client knows about the connection, which is what decides whether
 * the interval fallback runs.
 *
 * `connecting` is separated from `open` because they are different answers to
 * "is the poll still needed": a stream that has not said `ready` yet may
 * never say it (no EventSource, a proxy that buffers, a server built before
 * the endpoint existed), and the page must not go quiet waiting to find out.
 */
export type StreamState = 'idle' | 'connecting' | 'open' | 'closed';

/**
 * The fallback rule, in one place so it can be asserted rather than inferred
 * from three call sites: the interval runs unless the stream has actually
 * confirmed itself open.
 *
 * Erring toward polling is the whole point. A page that polls while a healthy
 * stream is open does redundant work; a page that trusts a stream that is not
 * there shows stale data forever, which is precisely the failure §8's own
 * "the kanban still is not updating" note records.
 *
 * `heartbeat` is the one interval the stream may never stand down, and
 * composables/usePulse.ts is its only caller. The distinction is what the
 * interval is asking. A page's interval asks "has the data changed?", and an
 * open stream answers that better than any timer — silence means nothing
 * changed. The shell's pulse asks "is the server still answering?", and
 * silence is exactly the state that question exists to disambiguate: a live
 * factory with nothing to report and a dead one look identical on a stream
 * that has stopped speaking, and a half-open socket can hold `open` for as
 * long as it takes the next keepalive write to fail. design-spec.md §A.6
 * hoisted that probe into the frame precisely so no page could be quietly
 * frozen; letting the stream silence it would give the freeze back.
 */
export function shouldRunInterval(state: StreamState, heartbeat = false): boolean {
  return heartbeat || state !== 'open';
}

/**
 * Parse an `advanced` frame's `data` into facts.
 *
 * Returns [] for anything that is not the expected shape rather than
 * throwing: the caller is an EventSource message handler, where a throw is an
 * unhandled rejection in the page and buys nothing. A frame we cannot read is
 * a frame we do not act on, and the interval fallback is still there.
 *
 * Entries are filtered individually, so one malformed member does not
 * discard the sessions beside it that were perfectly well-formed.
 */
export function parseAdvanced(data: string): SessionAdvance[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return [];
  const out: SessionAdvance[] = [];
  for (const entry of sessions) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { session, events } = entry as { session?: unknown; events?: unknown };
    if (typeof session !== 'string' || session.length === 0) continue;
    if (typeof events !== 'number' || !Number.isFinite(events)) continue;
    out.push({ session, events });
  }
  return out;
}

/**
 * Whether a frame is worth waking the page for, given what the page last saw.
 *
 * The server reports a session's total event count, not a delta, so this is a
 * comparison and not an accumulation — which is what makes it idempotent. A
 * reconnecting EventSource replays nothing, but a scan that ran twice over
 * the same log (a fingerprint that changed without the count changing: a
 * touched mtime, a rewritten line) reports the same number twice, and
 * refetching every page on that is work with no news behind it.
 *
 * `seen` is read, never written, so the caller owns when to commit — after
 * the refetch it triggered, not before.
 */
export function hasNews(advances: SessionAdvance[], seen: ReadonlyMap<string, number>): boolean {
  return advances.some(({ session, events }) => (seen.get(session) ?? -1) !== events);
}
