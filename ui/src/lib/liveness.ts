// Agent liveness: whether a live registry entry is still doing something or
// has outlived the factory's own stale window. The mechanism stays polling,
// not sockets (design-spec.md §8, composables/usePoll.ts).
//
// Kept out of the .vue files so it is unit-tested under ui/vitest.config.ts's
// `environment: node` — same split as lib/roadmapFlow.ts.
import type { LiveAgentEntry } from './api.js';

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

/**
 * True when `fromIso` is more than AGENT_STALE_AFTER_MS before `nowIso`. The
 * one spelling of the stale boundary (`>`, clamped at 0); an unreadable
 * timestamp is not evidence of staleness, so it answers false.
 */
export function isPastStaleWindow(fromIso: string, nowIso: string): boolean {
  const then = new Date(fromIso).getTime();
  const nowMs = new Date(nowIso).getTime();
  if (Number.isNaN(then) || Number.isNaN(nowMs)) return false;
  return Math.max(0, nowMs - then) > AGENT_STALE_AFTER_MS;
}

export function agentActivity(entry: LiveAgentEntry, nowIso: string): AgentActivity {
  const then = new Date(entry.dispatchedAt).getTime();
  const nowMs = new Date(nowIso).getTime();
  if (Number.isNaN(then) || Number.isNaN(nowMs)) return 'unknown';
  // `>`, not `>=` (see isPastStaleWindow) — detectStale() uses
  // `liveHours > staleHours`, and an off-by-one at the boundary would make the
  // two disagree about the same agent at exactly 4h.
  return isPastStaleWindow(entry.dispatchedAt, nowIso) ? 'stalled' : 'working';
}

/**
 * The entries that are actually working, in the order they came — this is a
 * filter, not a sort, so callers get no ordering they did not ask for.
 *
 * Operator directive (running-only liveness): keep only the running agents on
 * the session display.
 */
export function workingAgents(
  entries: readonly LiveAgentEntry[],
  nowIso: string,
): LiveAgentEntry[] {
  return entries.filter((e) => agentActivity(e, nowIso) === 'working');
}

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
 */
export const SESSION_ACTIVE_WITHIN_MS = 15 * 60 * 1000;
