// "Is this page still live, and what has been running longest?" — the pure
// half of the Overview's real-time zone (operator directive, Phase 6b round
// 7: "Tôi cần nhìn được ở Dashboard cái gì đang chạy, một dạng real-time
// update, để ý đến các mốc thời gian để hiển thị tốt hơn").
//
// The mechanism stays polling, not sockets — design-spec.md §8 ("No
// WebSockets") and composables/usePoll.ts. What was missing was not fresher
// data but any *evidence* of freshness: OverviewPage already re-fetched every
// 5s, and a page frozen by a dead server looked exactly like a page where
// nothing had changed. livenessLevel() turns "age of the last successful
// load" into that evidence.
//
// Kept out of the .vue files so it is unit-tested under ui/vitest.config.ts's
// `environment: node` — same split as lib/roadmapFlow.ts.
import type { LiveAgentEntry, RunningSession } from './api.js';
import { formatRelative } from './format.js';

/**
 * `connecting` — nothing has loaded yet.
 * `live` — the last load is within two poll intervals; polling is keeping up.
 * `lagging` — at least one poll has clearly been missed (slow API, or the tab
 *   was hidden, which pauses usePoll's interval by design).
 * `stale` — six intervals with no successful load: treat what is on screen as
 *   history, not as what the factory is doing now.
 */
export type LivenessLevel = 'connecting' | 'live' | 'lagging' | 'stale';

const LAGGING_AFTER_INTERVALS = 2;
const STALE_AFTER_INTERVALS = 6;

export function livenessLevel(
  lastUpdatedIso: string | null,
  nowIso: string,
  intervalMs: number,
): LivenessLevel {
  if (lastUpdatedIso === null) return 'connecting';
  const then = new Date(lastUpdatedIso).getTime();
  // An unreadable timestamp is not evidence of freshness, so it must not be
  // allowed to render as "Live".
  if (Number.isNaN(then)) return 'stale';
  // Clamped at 0: a browser clock a second behind the server must not make a
  // just-loaded page look ahead of itself.
  const ageMs = Math.max(0, new Date(nowIso).getTime() - then);
  if (ageMs < intervalMs * LAGGING_AFTER_INTERVALS) return 'live';
  if (ageMs < intervalMs * STALE_AFTER_INTERVALS) return 'lagging';
  return 'stale';
}

const LEVEL_WORD: Record<LivenessLevel, string> = {
  connecting: 'Connecting',
  live: 'Live',
  lagging: 'Lagging',
  stale: 'Stale',
};

/**
 * "Live · updated just now" / "Stale · updated 2m ago" — the state AND the
 * number behind it. The state word alone would be a claim the operator has to
 * take on trust; the age is what makes it checkable.
 */
export function livenessLabel(
  lastUpdatedIso: string | null,
  nowIso: string,
  intervalMs: number,
): string {
  const level = livenessLevel(lastUpdatedIso, nowIso, intervalMs);
  if (level === 'connecting' || lastUpdatedIso === null) return 'Connecting…';
  return `${LEVEL_WORD[level]} · updated ${formatRelative(lastUpdatedIso, nowIso)}`;
}

/**
 * `working` — dispatched recently enough that the factory itself still counts
 *   it as doing something.
 * `stalled` — still `live` in the registry, but past the point where the
 *   factory would report it as stale. It is on screen because nothing has
 *   closed it out, which is not the same as progress.
 * `unknown` — the timestamps do not support an answer. Never animated: a
 *   pulse is a claim that work is happening, and an unreadable clock is not
 *   evidence of that.
 */
export type AgentActivity = 'working' | 'stalled' | 'unknown';

/**
 * Mirrors `DEFAULT_STALE_HOURS = 4` in
 * factory/orchestrator/src/agents-registry.ts, which is what `detectStale()`
 * uses to decide a live agent has stopped being one (D-23/P9-12). The UI does
 * not get to invent its own threshold for "đang thực sự hoạt động" — if that
 * constant moves, this one moves with it.
 *
 * `LiveAgentEntry` carries no heartbeat (api.ts), only `dispatchedAt`, so age
 * is the only evidence available. That is a real limit of the signal and the
 * reason `stalled` is worded as "no terminal event yet", not as "hung".
 */
export const AGENT_STALE_AFTER_MS = 4 * 60 * 60 * 1000;

export function agentActivity(entry: LiveAgentEntry, nowIso: string): AgentActivity {
  const then = new Date(entry.dispatchedAt).getTime();
  const nowMs = new Date(nowIso).getTime();
  if (Number.isNaN(then) || Number.isNaN(nowMs)) return 'unknown';
  // Clamped like livenessLevel(): a browser clock a moment behind the server
  // must not turn a just-dispatched agent into four hours of runtime.
  const ageMs = Math.max(0, nowMs - then);
  // `>`, not `>=` — detectStale() uses `liveHours > staleHours`, and an
  // off-by-one at the boundary would make the two disagree about the same
  // agent at exactly 4h.
  return ageMs > AGENT_STALE_AFTER_MS ? 'stalled' : 'working';
}

/** How many of these agents are actually working — the count the pulse claims. */
export function workingCount(entries: LiveAgentEntry[], nowIso: string): number {
  return entries.filter((e) => agentActivity(e, nowIso) === 'working').length;
}

function dispatchedMs(a: LiveAgentEntry): number {
  const t = new Date(a.dispatchedAt).getTime();
  // Unusable timestamps sort last rather than to the top: "longest running"
  // is a stuck-agent signal, and an entry with no readable start time is not
  // evidence of one.
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Longest-running agent first. That ordering is the point of the list: the
 * agent that has been running for 40 minutes is the one worth looking at,
 * and it is invisible in dispatch order. Ties break on `id` so the rows do
 * not swap places under the 5s poll.
 */
export function byRuntimeDesc(entries: LiveAgentEntry[]): LiveAgentEntry[] {
  return [...entries].sort((a, b) => dispatchedMs(a) - dispatchedMs(b) || a.id.localeCompare(b.id));
}

/** Oldest `dispatchedAt` in a group — the runtime to show on a collapsed group row. */
export function longestRunningSince(entries: LiveAgentEntry[]): string | null {
  let oldest: LiveAgentEntry | null = null;
  for (const a of entries) {
    if (dispatchedMs(a) === Number.POSITIVE_INFINITY) continue;
    if (oldest === null || dispatchedMs(a) < dispatchedMs(oldest)) oldest = a;
  }
  return oldest?.dispatchedAt ?? null;
}

/**
 * `active` — this session appended an event inside the window below, so the
 *   run is producing something right now.
 * `idle` — the session exists and was never closed (there is no
 *   `session-ended` event in the schema), but it has gone quiet.
 * `unknown` — the timestamps do not support an answer. Never animated, for
 *   the same reason as AgentActivity's `unknown`.
 */
export type SessionActivity = 'active' | 'idle' | 'unknown';

/**
 * How long a session may go without appending an event before the UI stops
 * calling it active.
 *
 * Measured, not guessed, from the inter-event gaps in this repo's own
 * state/smith.db (2026-08-11): dogfood-mcp-1 n=354 → p50 0s, p90 408s, p95
 * 561s, p99 1163s; dogfood-envkit-1 n=70 → p95 1245s. So a genuinely working
 * run is quiet for ~9.5 min at p95 and ~19 min at p99. 15 minutes sits
 * between them: long enough that a run thinking through a slow agent turn is
 * not flagged dead, short enough that a run abandoned yesterday is not
 * animated as if it were alive.
 *
 * The `sessions` table is projected purely from the event array (schema.ts) —
 * there is no session-ended event and no heartbeat — so event recency is the
 * only evidence available, and `idle` therefore means "quiet", not "over".
 */
export const SESSION_ACTIVE_WITHIN_MS = 15 * 60 * 1000;

export function sessionActivity(lastEventAtIso: string, nowIso: string): SessionActivity {
  const then = new Date(lastEventAtIso).getTime();
  const nowMs = new Date(nowIso).getTime();
  if (Number.isNaN(then) || Number.isNaN(nowMs)) return 'unknown';
  // Clamped like agentActivity(): a browser clock behind the server must not
  // age a just-appended event out of the window.
  const ageMs = Math.max(0, nowMs - then);
  return ageMs <= SESSION_ACTIVE_WITHIN_MS ? 'active' : 'idle';
}

function lastEventMs(s: RunningSession): number {
  const t = new Date(s.lastEventAt).getTime();
  // Unreadable timestamps sort last: this list is ordered by "what happened
  // most recently", and a row with no readable clock is not a candidate for
  // the top of it.
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Most recently active session first — the run happening now belongs at the
 * top. Ties break on `sessionId` so rows do not swap under the 5s poll.
 */
export function bySessionRecency(sessions: RunningSession[]): RunningSession[] {
  return [...sessions].sort(
    (a, b) => lastEventMs(b) - lastEventMs(a) || a.sessionId.localeCompare(b.sessionId),
  );
}

/** How many runs are actually producing events — the count the pulse claims. */
export function activeSessionCount(sessions: RunningSession[], nowIso: string): number {
  return sessions.filter((s) => sessionActivity(s.lastEventAt, nowIso) === 'active').length;
}
