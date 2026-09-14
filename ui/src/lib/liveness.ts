// "Is this page still live, and what has been running longest?" — the pure
// half of the Overview's real-time zone (operator directive, Phase 6b round
// 7: "I need to see on the Dashboard what is running, a kind of real-time
// update; mind the timestamps so they display better").
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
import { formatRelative, pluralize } from './format.js';

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
 * "last event 12s ago" — the *factory's* pulse, which is a different question
 * from livenessLabel()'s.
 *
 * livenessLabel answers "is my screen current". This answers "is anything
 * happening". They come apart in exactly the case the shell indicator exists
 * for: a healthy server polled every five seconds reports `Live` forever, and
 * says nothing about a factory that has not emitted an event since Tuesday.
 * Both are shown, side by side, because neither implies the other.
 */
export function lastEventLabel(lastEventAtIso: string | null, nowIso: string): string {
  if (lastEventAtIso === null) return 'no events yet';
  return `last event ${formatRelative(lastEventAtIso, nowIso)}`;
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
 * not get to invent its own threshold for "actually working" — if that
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
export function workingCount(entries: readonly LiveAgentEntry[], nowIso: string): number {
  return entries.filter((e) => agentActivity(e, nowIso) === 'working').length;
}

/**
 * The entries that are actually working, in the order they came — this is a
 * filter, not a sort, so callers compose it with byRuntimeDesc() rather than
 * getting an ordering they did not ask for.
 *
 * Operator directive (running-only liveness): "remove idle sessions from the
 * session display, keep only the ones running. Same for idle agents." The
 * pages used to draw every `live` registry row and animate the working ones;
 * now they draw only these and *state* the rest (partitionAgents()).
 */
export function workingAgents(
  entries: readonly LiveAgentEntry[],
  nowIso: string,
): LiveAgentEntry[] {
  return entries.filter((e) => agentActivity(e, nowIso) === 'working');
}

/**
 * The working entries by name, and the hidden ones by *why* they were hidden.
 * Two counts rather than one because they are two different messages: a
 * stalled agent is a fact about the factory (nothing closed it out in 4h); an
 * unreadable timestamp is a fact about the data, and the operator should not
 * be told the former when the truth is the latter.
 */
export function partitionAgents(
  entries: readonly LiveAgentEntry[],
  nowIso: string,
): { working: LiveAgentEntry[]; stalled: number; unknown: number } {
  const working: LiveAgentEntry[] = [];
  let stalled = 0;
  let unknown = 0;
  for (const e of entries) {
    const activity = agentActivity(e, nowIso);
    if (activity === 'working') working.push(e);
    else if (activity === 'stalled') stalled += 1;
    else unknown += 1;
  }
  return { working, stalled, unknown };
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

/**
 * Whether a session belongs on a "running" surface at all.
 *
 * Event recency alone is not enough. Measured on the same logs that set
 * SESSION_ACTIVE_WITHIN_MS, about one inter-event gap in ten is longer than
 * that window, while a single coder commonly runs 12–35 minutes between the
 * dispatch event and its terminal one. An event-only rule would therefore
 * hide a session precisely while its agent is mid-task — the one moment the
 * operator most wants to see it. A *working* agent (agentActivity, 4h
 * window) is proof the session is not idle, so it carries the session even
 * when the event stream is quiet. A stalled or unknown agent carries nothing:
 * neither is evidence of progress, and a stalled agent under a quiet session
 * is exactly the picture of a run that died.
 *
 * `agentsOfSession` is the caller's responsibility to scope by `sessionId`;
 * partitionSessions() does that over the whole entry list.
 */
export function isSessionRunning(
  session: RunningSession,
  agentsOfSession: readonly LiveAgentEntry[],
  nowIso: string,
): boolean {
  return (
    sessionActivity(session.lastEventAt, nowIso) === 'active' ||
    workingCount(agentsOfSession, nowIso) > 0
  );
}

/**
 * The running sessions, most recent first, and the hidden ones counted by
 * why. `agents` is the whole `liveAgentEntries` list; matching by `sessionId`
 * happens here so every page applies the same rule.
 *
 * `unknown` is a session whose `lastEventAt` is unreadable *and* which no
 * working agent vouches for. It is never `running` — an unreadable clock is
 * not evidence of activity — and it is not folded into `idle` either, so the
 * operator is told "1 with an unreadable timestamp" rather than a false
 * "idle".
 */
export function partitionSessions(
  sessions: readonly RunningSession[],
  agents: readonly LiveAgentEntry[],
  nowIso: string,
): { running: RunningSession[]; idle: number; unknown: number } {
  const running: RunningSession[] = [];
  let idle = 0;
  let unknown = 0;
  for (const s of sessions) {
    const own = agents.filter((a) => a.sessionId === s.sessionId);
    if (isSessionRunning(s, own, nowIso)) running.push(s);
    else if (sessionActivity(s.lastEventAt, nowIso) === 'unknown') unknown += 1;
    else idle += 1;
  }
  return { running: bySessionRecency(running), idle, unknown };
}

/**
 * "3 idle sessions not shown, 1 with an unreadable timestamp" — the sentence
 * every surface that hides something must print (repo rule: stated, never
 * dropped silently). Empty when nothing was hidden: a standing "0 not shown"
 * line would train the operator to stop reading it.
 *
 * The unknown-only form spells out the noun ("1 session with an unreadable
 * timestamp not shown") because "0 idle sessions not shown, 1 with an
 * unreadable timestamp" is a true sentence that reads as a bug.
 */
function hiddenLabel(hidden: number, hiddenWord: string, unknown: number, noun: string): string {
  if (hidden === 0 && unknown === 0) return '';
  if (hidden === 0) return `${pluralize(unknown, noun)} with an unreadable timestamp not shown`;
  const tail = unknown > 0 ? `, ${unknown} with an unreadable timestamp` : '';
  return `${pluralize(hidden, `${hiddenWord} ${noun}`)} not shown${tail}`;
}

export function hiddenSessionsLabel(idle: number, unknown: number): string {
  return hiddenLabel(idle, 'idle', unknown, 'session');
}

export function hiddenAgentsLabel(stalled: number, unknown: number): string {
  return hiddenLabel(stalled, 'stalled', unknown, 'agent');
}
