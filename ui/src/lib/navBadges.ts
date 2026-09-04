// "Something arrived while you were on another page" — the pure half of the
// shell pulse (composables/usePulse.ts).
//
// Why a badge and not a toast. The operator asked whether an event, trigger
// or dispatch should raise a toast, "so the system feels like it is running".
// It
// should not, for reasons that are properties of this transport rather than
// matters of taste:
//
//   - useToast.ts already means one thing — *your* action landed. A toast the
//     operator did not cause would overload that.
//   - The data arrives by poll (design-spec.md §8, "No WebSockets"), so a
//     toast fired off a diff reports when the *poll* noticed, not when the
//     thing happened — and a wave that lands ten events between two ticks
//     either storms the corner or lies about the count.
//   - usePoll pauses while the tab is hidden, so a toast is lossy for
//     something the event log records durably. An arrival the operator did
//     not cause belongs on a surface they can come back to.
//
// A badge is that surface: it accumulates, it survives a hidden tab, and it
// is still there when the operator looks up.
import type { PulseResult } from './api.js';

/**
 * Nav id → the pulse counter whose *arrivals* it badges.
 *
 * Only monotonic counters may appear here. "3 new" is a claim that three
 * things arrived, and a difference between two polls only means that when the
 * underlying number can never fall. Subtract a *level* — open tasks, pending
 * lessons — and the operator clearing one produces a negative arrival. Both
 * counters below are counts of rows projected from an append-only log.
 */
export const COUNTER_FOR_NAV: Readonly<Record<string, keyof PulseResult['counts']>> = {
  timeline: 'events',
  errors: 'errors',
};

/**
 * The one nav item whose badge is a level rather than an arrival: lessons
 * waiting on an operator decision. It is rendered as itself — the number that
 * is waiting — because it falls when the operator approves one.
 */
export const LEVEL_NAV_ID = 'lessons';

/** A snapshot of the monotonic counters as of the last time the operator looked. */
export type SeenCounts = PulseResult['counts'];

/** Two-digit rail, so a long-running factory cannot stretch the sidebar. */
const BADGE_MAX = 99;

export function seenFromPulse(pulse: PulseResult): SeenCounts {
  return { events: pulse.counts.events, errors: pulse.counts.errors };
}

export function arrivalsSince(seen: number, current: number): number {
  // Clamped, not signed. A projection rebuild or a project-scope switch can
  // put the current count *below* the baseline, and "-12 new" is not a thing
  // that can have arrived — the baseline is stale, not the count. usePulse
  // re-baselines on a scope change; this is the backstop for a rebuild, which
  // it cannot see.
  return current > seen ? current - seen : 0;
}

/**
 * The operator opened `navId`: that page's counter is caught up to the latest
 * poll, so its badge goes away and starts counting again from here.
 *
 * A nav id with no counter (or a pulse that has not landed) leaves the
 * baseline untouched rather than inventing one — clearing a badge on evidence
 * that has not arrived is how a badge starts under-reporting.
 */
export function markSeen(seen: SeenCounts, pulse: PulseResult | null, navId: string): SeenCounts {
  const counter = COUNTER_FOR_NAV[navId];
  if (pulse === null || counter === undefined) return seen;
  return { ...seen, [counter]: pulse.counts[counter] };
}

/**
 * Nav id → the number its badge should show. An id absent from the result has
 * no badge; a zero is never returned, so the caller never has to decide
 * whether "0 new" is worth drawing.
 */
export function navBadges(
  pulse: PulseResult | null,
  seen: SeenCounts | null,
): Record<string, number> {
  const badges: Record<string, number> = {};
  if (pulse === null) return badges;
  // No baseline means the first poll has not landed yet. Everything already
  // in the log is history, not arrival — badging it would greet the operator
  // with "99+ new" every time they opened the dashboard.
  if (seen !== null) {
    for (const [navId, counter] of Object.entries(COUNTER_FOR_NAV)) {
      const arrived = arrivalsSince(seen[counter], pulse.counts[counter]);
      if (arrived > 0) badges[navId] = arrived;
    }
  }
  if (pulse.lessonsPending > 0) badges[LEVEL_NAV_ID] = pulse.lessonsPending;
  return badges;
}

/** What the badge draws. Capped, because the rail is not a counter display. */
export function badgeText(count: number): string {
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

/**
 * What the badge *means*, for the accessible name. The glyph is a bare
 * number, and "3 pending" and "3 new" are not the same claim — a screen
 * reader that hears only "Lessons 3" has been told neither.
 */
export function badgeLabel(navId: string, count: number): string {
  return navId === LEVEL_NAV_ID ? `${count} pending` : `${count} new`;
}

/**
 * Everything the shell remembers between polls. Kept here, as a value, so the
 * two rules that are easy to break silently — re-baseline on a scope switch,
 * and never badge the page the operator is on — are testable without a DOM.
 * composables/usePulse.ts is the ref-shaped wiring around it.
 */
export interface PulseState {
  pulse: PulseResult | null;
  seen: SeenCounts | null;
  /** Which scope `seen` was taken under; `null` before the first poll. */
  scopeKey: string | null;
}

export const EMPTY_PULSE_STATE: PulseState = { pulse: null, seen: null, scopeKey: null };

/** A poll landed. */
export function applyPulse(
  state: PulseState,
  next: PulseResult,
  scopeKey: string,
  currentNavId: string | undefined,
): PulseState {
  // A scope switch changes what the counters count, so the old baseline
  // describes a different population — reporting the difference between two
  // different questions as an arrival is worse than reporting nothing.
  const carried = state.seen !== null && state.scopeKey === scopeKey ? state.seen : null;
  const base = carried ?? seenFromPulse(next);
  return {
    pulse: next,
    // There are no unread arrivals on the page the operator is looking at.
    seen: currentNavId === undefined ? base : markSeen(base, next, currentNavId),
    scopeKey,
  };
}

/** The operator navigated. */
export function applyNav(state: PulseState, navId: string | undefined): PulseState {
  if (navId === undefined || state.seen === null) return state;
  return { ...state, seen: markSeen(state.seen, state.pulse, navId) };
}
