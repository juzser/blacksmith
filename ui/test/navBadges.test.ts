import { describe, expect, it } from 'vitest';
import type { PulseResult } from '../src/lib/api.js';
import {
  applyNav,
  applyPulse,
  arrivalsSince,
  badgeLabel,
  badgeText,
  COUNTER_FOR_NAV,
  EMPTY_PULSE_STATE,
  LEVEL_NAV_ID,
  markSeen,
  navBadges,
  seenFromPulse,
} from '../src/lib/navBadges.js';

function pulse(events: number, errors: number, lessonsPending = 0): PulseResult {
  return {
    lastEventAt: '2026-08-27T12:00:00.000Z',
    lastEventType: 'task.completed',
    counts: { events, errors },
    lessonsPending,
  };
}

describe('COUNTER_FOR_NAV', () => {
  it('maps only monotonic counters', () => {
    // A level would produce a negative arrival the moment the operator
    // cleared one; the guard is that this table stays counters-only.
    expect(COUNTER_FOR_NAV).toEqual({ timeline: 'events', errors: 'errors' });
    expect(COUNTER_FOR_NAV[LEVEL_NAV_ID]).toBeUndefined();
  });
});

describe('arrivalsSince', () => {
  it('reports the difference when the counter grew', () => {
    expect(arrivalsSince(10, 13)).toBe(3);
  });

  it('reports nothing when the counter is unchanged', () => {
    expect(arrivalsSince(10, 10)).toBe(0);
  });

  it('clamps rather than going negative when the baseline is stale', () => {
    // A projection rebuild can drop the count below a baseline taken before
    // it. Nothing arrived; the baseline is simply no longer true.
    expect(arrivalsSince(10, 4)).toBe(0);
  });
});

describe('seenFromPulse', () => {
  it('takes only the counters, not the level', () => {
    expect(seenFromPulse(pulse(7, 2, 5))).toEqual({ events: 7, errors: 2 });
  });
});

describe('markSeen', () => {
  it('catches one counter up and leaves the others alone', () => {
    const seen = markSeen({ events: 1, errors: 1 }, pulse(9, 4), 'timeline');
    expect(seen).toEqual({ events: 9, errors: 1 });
  });

  it('leaves the baseline untouched for a nav id with no counter', () => {
    const before = { events: 1, errors: 1 };
    expect(markSeen(before, pulse(9, 4), 'analytics')).toEqual(before);
    expect(markSeen(before, pulse(9, 4), LEVEL_NAV_ID)).toEqual(before);
  });

  it('leaves the baseline untouched before any pulse has landed', () => {
    // Clearing a badge on evidence that has not arrived is how a badge
    // starts under-reporting.
    const before = { events: 1, errors: 1 };
    expect(markSeen(before, null, 'timeline')).toEqual(before);
  });
});

describe('navBadges', () => {
  it('draws nothing before the first poll', () => {
    expect(navBadges(null, { events: 1, errors: 1 })).toEqual({});
  });

  it('draws no arrivals without a baseline, so history is not greeted as new', () => {
    expect(navBadges(pulse(4000, 12), null)).toEqual({});
  });

  it('draws no arrivals with a baseline but a pending level', () => {
    expect(navBadges(pulse(4000, 12, 3), null)).toEqual({ lessons: 3 });
  });

  it('badges each counter that grew, and omits the ones that did not', () => {
    expect(navBadges(pulse(12, 3), { events: 9, errors: 3 })).toEqual({ timeline: 3 });
  });

  it('badges the pending level as itself, not as a difference', () => {
    const badges = navBadges(pulse(12, 5, 2), { events: 12, errors: 3 });
    expect(badges).toEqual({ errors: 2, lessons: 2 });
  });

  it('never returns a zero', () => {
    const badges = navBadges(pulse(9, 3, 0), { events: 9, errors: 3 });
    expect(badges).toEqual({});
    expect(Object.values(badges).every((n) => n > 0)).toBe(true);
  });
});

describe('badgeText', () => {
  it('draws the count as itself up to the cap', () => {
    expect(badgeText(1)).toBe('1');
    expect(badgeText(99)).toBe('99');
  });

  it('caps beyond it, so the rail cannot be stretched by a long-lived factory', () => {
    expect(badgeText(100)).toBe('99+');
    expect(badgeText(41234)).toBe('99+');
  });
});

describe('badgeLabel', () => {
  it('says what the number counts', () => {
    expect(badgeLabel('timeline', 3)).toBe('3 new');
    expect(badgeLabel('errors', 1)).toBe('1 new');
    expect(badgeLabel(LEVEL_NAV_ID, 3)).toBe('3 pending');
  });
});

describe('applyPulse', () => {
  it('takes the first poll as the baseline, so nothing is badged on arrival', () => {
    const state = applyPulse(EMPTY_PULSE_STATE, pulse(4000, 12), 'all', 'overview');
    expect(state.seen).toEqual({ events: 4000, errors: 12 });
    expect(state.scopeKey).toBe('all');
    expect(navBadges(state.pulse, state.seen)).toEqual({});
  });

  it('carries the baseline forward within one scope, so arrivals accumulate', () => {
    let state = applyPulse(EMPTY_PULSE_STATE, pulse(10, 1), 'all', 'overview');
    state = applyPulse(state, pulse(13, 1), 'all', 'overview');
    state = applyPulse(state, pulse(15, 2), 'all', 'overview');
    expect(navBadges(state.pulse, state.seen)).toEqual({ timeline: 5, errors: 1 });
  });

  it('never badges the page the operator is on', () => {
    let state = applyPulse(EMPTY_PULSE_STATE, pulse(10, 1), 'all', 'timeline');
    state = applyPulse(state, pulse(13, 4), 'all', 'timeline');
    // Timeline is on screen and current; only Errors accumulated behind it.
    expect(navBadges(state.pulse, state.seen)).toEqual({ errors: 3 });
  });

  it('re-baselines on a scope switch rather than subtracting two populations', () => {
    let state = applyPulse(EMPTY_PULSE_STATE, pulse(4000, 40), 'all', 'overview');
    // Scoping to one project drops the counts to that project's rows. The
    // difference between the two is not an arrival.
    state = applyPulse(state, pulse(120, 2), 'blacksmith', 'overview');
    expect(state.seen).toEqual({ events: 120, errors: 2 });
    expect(navBadges(state.pulse, state.seen)).toEqual({});
  });

  it('keeps a full baseline when no page is active', () => {
    const state = applyPulse(EMPTY_PULSE_STATE, pulse(10, 1), 'all', undefined);
    expect(state.seen).toEqual({ events: 10, errors: 1 });
  });
});

describe('applyNav', () => {
  it('clears that page badge and starts counting again from the last poll', () => {
    let state = applyPulse(EMPTY_PULSE_STATE, pulse(10, 1), 'all', 'overview');
    state = applyPulse(state, pulse(14, 3), 'all', 'overview');
    expect(navBadges(state.pulse, state.seen)).toEqual({ timeline: 4, errors: 2 });

    state = applyNav(state, 'timeline');
    expect(navBadges(state.pulse, state.seen)).toEqual({ errors: 2 });

    state = applyPulse(state, pulse(16, 3), 'all', 'timeline');
    expect(navBadges(state.pulse, state.seen)).toEqual({ errors: 2 });
  });

  it('is a no-op before the first poll, and for a page with no counter', () => {
    expect(applyNav(EMPTY_PULSE_STATE, 'timeline')).toBe(EMPTY_PULSE_STATE);
    const state = applyPulse(EMPTY_PULSE_STATE, pulse(10, 1), 'all', 'overview');
    expect(applyNav(state, undefined)).toBe(state);
    expect(applyNav(state, 'analytics').seen).toEqual(state.seen);
  });
});
