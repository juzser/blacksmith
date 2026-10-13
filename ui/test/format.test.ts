import { describe, expect, it } from 'vitest';
import {
  axisDayLabels,
  dailyTokensTakeaway,
  formatAbsolute,
  formatCalendarDay,
  formatCompactNumber,
  formatCompactValue,
  formatDurationMs,
  formatElapsed,
  formatElapsedRange,
  formatLiveStatus,
  formatRelativeVerbose,
  formatShortDate,
  formatShortDateTime,
  formatSinceVerbose,
  parentLabel,
  pluralize,
  shortTaskId,
  shortTaskName,
} from '../src/lib/format.js';

describe('lib/format.ts pluralize()', () => {
  it('uses the singular form for exactly 1', () => {
    expect(pluralize(1, 'task')).toBe('1 task');
    expect(pluralize(1, 'waiver')).toBe('1 waiver');
  });

  it('uses the plural form for 0 and >1', () => {
    expect(pluralize(0, 'task')).toBe('0 tasks');
    expect(pluralize(2, 'task')).toBe('2 tasks');
    expect(pluralize(3, 'waiver')).toBe('3 waivers');
  });

  it('accepts an explicit irregular plural', () => {
    expect(pluralize(2, 'child', 'children')).toBe('2 children');
    expect(pluralize(1, 'child', 'children')).toBe('1 child');
  });
});

describe('lib/format.ts formatElapsed()', () => {
  const now = '2026-08-05T12:00:00.000Z';

  it('renders seconds under a minute', () => {
    expect(formatElapsed('2026-08-05T11:59:53.000Z', now)).toBe('7s');
  });

  it('renders whole minutes under an hour', () => {
    expect(formatElapsed('2026-08-05T11:56:30.000Z', now)).toBe('3m');
  });

  it('renders hours with minutes under a day', () => {
    expect(formatElapsed('2026-08-05T09:47:00.000Z', now)).toBe('2h 13m');
  });

  it('drops the minutes part when it is zero', () => {
    expect(formatElapsed('2026-08-05T09:00:00.000Z', now)).toBe('3h');
  });

  it('renders days with hours past 24 hours', () => {
    expect(formatElapsed('2026-08-03T08:00:00.000Z', now)).toBe('2d 4h');
  });

  it('drops the hours part when it is zero', () => {
    expect(formatElapsed('2026-08-03T12:00:00.000Z', now)).toBe('2d');
  });

  it('clamps a future timestamp to 0s instead of showing a negative age', () => {
    expect(formatElapsed('2026-08-05T12:00:30.000Z', now)).toBe('0s');
  });

  it('returns an empty string for an unparseable timestamp', () => {
    expect(formatElapsed('not-a-date', now)).toBe('');
  });
});

describe('lib/format.ts formatDurationMs()', () => {
  it('renders seconds under a minute', () => {
    expect(formatDurationMs(7000)).toBe('7s');
  });

  it('renders hours with minutes under a day', () => {
    expect(formatDurationMs((2 * 60 + 13) * 60 * 1000)).toBe('2h 13m');
  });

  it('drops the minutes part when it is zero', () => {
    expect(formatDurationMs(3 * 60 * 60 * 1000)).toBe('3h');
  });

  it('clamps a negative duration to 0s', () => {
    expect(formatDurationMs(-500)).toBe('0s');
  });
});

// The operator finds the dashboard too technical: a raw 6-7 digit token
// integer is noise next to the story it tells ("this task cost about 12M
// tokens"), so every rendered count goes through one compact formatter
// rather than each call site rolling its own rounding.
describe('lib/format.ts formatCompactNumber()', () => {
  it('renders sub-thousand counts exactly, no suffix', () => {
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(0)).toBe('0');
  });

  it('renders thousands with one decimal, dropping a trailing .0', () => {
    expect(formatCompactNumber(1234)).toBe('1.2K');
    expect(formatCompactNumber(5000)).toBe('5K');
  });

  it('renders millions with one decimal', () => {
    expect(formatCompactNumber(12345678)).toBe('12.3M');
  });

  it('renders billions with a B suffix', () => {
    expect(formatCompactNumber(2_500_000_000)).toBe('2.5B');
    expect(formatCompactNumber(1_000_000_000)).toBe('1B');
  });

  // A value that rounds up to 1000 within its tier used to render "1000K"
  // instead of promoting to the next tier up ("1M") — the rounded display
  // value, not the raw magnitude, decides which tier a number belongs to.
  describe('boundary values that round up into the next tier', () => {
    it('promotes a K value that rounds to 1000 up to 1M', () => {
      expect(formatCompactNumber(999_950)).toBe('1M');
    });

    it('does not promote a K value that rounds to 999.9', () => {
      expect(formatCompactNumber(999_949)).toBe('999.9K');
    });

    it('promotes an M value that rounds to 1000 up to 1B', () => {
      expect(formatCompactNumber(999_994_999)).toBe('1B');
    });

    it('promotes a negative K value that rounds to -1000 up to -1M', () => {
      expect(formatCompactNumber(-999_950)).toBe('-1M');
    });

    it('renders exactly 999 with no suffix', () => {
      expect(formatCompactNumber(999)).toBe('999');
    });

    it('renders exactly 1000 as 1K', () => {
      expect(formatCompactNumber(1000)).toBe('1K');
    });
  });
});

// One task is named the same short way on every surface: shortTaskName() is
// the one place that decides it (title, else slug, else "Follow-up fix"), so no
// page re-derives the slug rules inline (D-221).
describe('lib/format.ts shortTaskName()', () => {
  const longTitle =
    'Rewrite the entire onboarding flow end to end including every edge case we can think of';
  const hex = /[0-9a-f]{8}/;

  it('derives a name from the plan slug when no title is given', () => {
    expect(shortTaskName('epic-x/task-29-readme-merge-trim')).toBe('Readme merge trim');
  });

  it('strips a leading task-<n>- prefix even without an epic path segment', () => {
    expect(shortTaskName('task-3-fix-lint')).toBe('Fix lint');
  });

  it('prefers a short, non-empty title over the derived slug', () => {
    expect(shortTaskName('epic-x/task-29-readme-merge-trim', 'Merge trim')).toBe('Merge trim');
  });

  it('falls back to the derived slug when the title is empty or null', () => {
    expect(shortTaskName('epic-x/task-29-readme-merge-trim', '')).toBe('Readme merge trim');
    expect(shortTaskName('epic-x/task-29-readme-merge-trim', null)).toBe('Readme merge trim');
  });

  it('falls back to the derived slug when the title is longer than 60 characters', () => {
    expect(longTitle.length).toBeGreaterThan(60);
    expect(shortTaskName('epic-x/task-29-readme-merge-trim', longTitle)).toBe('Readme merge trim');
  });

  it('handles an id with no task- prefix by just spacing and capitalizing it', () => {
    expect(shortTaskName('cleanup-orphan-rows')).toBe('Cleanup orphan rows');
  });

  it('never prints the hex of a minted id', () => {
    for (const id of [
      'epic-a/followup-0a1b2c3d',
      '20260918-e6492f02.security',
      'epic-a/0a1b2c3d',
    ]) {
      const text = shortTaskName(id, longTitle);
      expect(text).toBe('Follow-up fix');
      expect(text).not.toMatch(hex);
    }
  });

  it('names a minted follow-up by its own short title when it has one', () => {
    expect(shortTaskName('epic-a/followup-0a1b2c3d', 'Clip the label')).toBe('Clip the label');
  });

  it('appends the parent to a generic follow-up name', () => {
    expect(shortTaskName('epic-a/followup-0a1b2c3d', null, 'Settings layout')).toBe(
      'Follow-up fix · Settings layout',
    );
  });
});

// DS4 S3 fix round 1 finding 4: WaveTaskCard had no id at all. shortTaskId()
// is the same derivation KanbanTaskCard.vue's own `shortId` computed used
// inline, pulled out so both cards share it rather than each keeping a
// private copy of the same `split('/').pop()`.
describe('lib/format.ts shortTaskId()', () => {
  it('takes the last path segment of a task id', () => {
    expect(shortTaskId('epic-9/task-3-build-directory-search-ui')).toBe(
      'task-3-build-directory-search-ui',
    );
  });

  it('returns the id unchanged when it has no epic path segment', () => {
    expect(shortTaskId('task-3-fix-lint')).toBe('task-3-fix-lint');
  });
});

// kit/RelativeTime.vue's tooltip text (ds-spec.md §2.1: "the absolute time
// ('30 Sep 2026, 14:07:12') in a Tooltip").
describe('lib/format.ts formatAbsolute()', () => {
  // Timezone-naive (no "Z"/offset) ISO literals: per the JS Date spec these
  // parse as local time, same as the .getHours()-style local getters
  // formatAbsolute() itself (and formatTime()) use — so
  // the expected string is stable under any TZ the test runner happens to
  // sit in, unlike a "Z" literal compared against a local-time render.
  it("renders the spec's exact example shape: day, short month, year, comma, HH:MM:SS", () => {
    expect(formatAbsolute('2026-09-30T14:07:12')).toBe('30 Sep 2026, 14:07:12');
  });

  it('zero-pads hours, minutes and seconds but not the day of month', () => {
    expect(formatAbsolute('2026-09-05T09:03:01')).toBe('5 Sep 2026, 09:03:01');
  });

  it('returns the raw input for an unparseable date', () => {
    expect(formatAbsolute('not-a-date')).toBe('not-a-date');
  });
});

// RequestQuote.vue's timestamp (ds-review.html ~1239, ~1300: "12 Sep, 09:14" —
// short month, comma, zero-padded 24h HH:MM, no year). Scoped to
// RequestQuote only (DS4 S5c fix round 1, fix 4).
// DS6 PR4b Elapsed tooltip (TaskDetailPage totals bar): "29 Sep 2026, 14:02 to
// 16:12" -- the started day/date once, the ended time alone (same day in
// every call site this feeds, since a run never spans midnight today).
describe('lib/format.ts formatElapsedRange()', () => {
  it('renders the day/month/year once, then both times joined by "to"', () => {
    expect(formatElapsedRange('2026-09-29T14:02:00', '2026-09-29T16:12:00')).toBe(
      '29 Sep 2026, 14:02 to 16:12',
    );
  });

  it('zero-pads single-digit hours and minutes', () => {
    expect(formatElapsedRange('2026-01-05T03:07:00', '2026-01-05T09:00:00')).toBe(
      '5 Jan 2026, 03:07 to 09:00',
    );
  });
});

describe('lib/format.ts formatShortDateTime()', () => {
  it('renders day, short month, comma, zero-padded 24h time', () => {
    expect(formatShortDateTime('2026-09-12T09:14:00')).toBe('12 Sep, 09:14');
  });

  it('zero-pads single-digit hours and minutes but not the day of month', () => {
    expect(formatShortDateTime('2026-01-05T03:07:00')).toBe('5 Jan, 03:07');
  });

  it('returns the raw input for an unparseable date', () => {
    expect(formatShortDateTime('not-a-date')).toBe('not-a-date');
  });
});

// LessonCard's "learned from <session> on <date>" (ds-review.html ~1510:
// "7 Sep" -- day + short month, no year, no leading zero). Scoped to
// LessonCard only.
describe('lib/format.ts formatShortDate()', () => {
  it('renders day (no leading zero) and short month, no year', () => {
    expect(formatShortDate('2026-09-07T00:00:00.000Z')).toBe('7 Sep');
  });

  it('does not zero-pad a single-digit day', () => {
    expect(formatShortDate('2026-01-05T03:07:00')).toBe('5 Jan');
  });

  it('returns the raw input for an unparseable date', () => {
    expect(formatShortDate('not-a-date')).toBe('not-a-date');
  });
});

// kit/RelativeTime.vue's visible text (ds-spec.md §2.1: renders "5 min ago" /
// "2 h ago" / "3 d ago"; ds-review.html's rendered .tip-trigger text matches
// exactly, e.g. "5 min ago", "2 h ago", "8 s ago"). Spaced, and "min"
// spelled out.
describe('lib/format.ts formatRelativeVerbose()', () => {
  const now = '2026-08-04T12:00:00.000Z';

  it('renders "just now" for sub-5-second gaps', () => {
    expect(formatRelativeVerbose('2026-08-04T11:59:58.000Z', now)).toBe('just now');
  });

  it('renders a bare few-seconds gap as "N s ago", not "just now"', () => {
    expect(formatRelativeVerbose('2026-08-04T11:59:52.000Z', now)).toBe('8\u00a0s ago');
  });

  it('spells minutes as "min", not "m"', () => {
    expect(formatRelativeVerbose('2026-08-04T11:55:00.000Z', now)).toBe('5\u00a0min ago');
  });

  it('renders hours and days with a space before the unit', () => {
    expect(formatRelativeVerbose('2026-08-04T10:00:00.000Z', now)).toBe('2\u00a0h ago');
    expect(formatRelativeVerbose('2026-08-02T12:00:00.000Z', now)).toBe('2\u00a0d ago');
  });
});

describe('lib/format.ts formatSinceVerbose()', () => {
  const now = '2026-08-04T12:00:00.000Z';

  it('reads a duration with the same units as formatRelativeVerbose', () => {
    expect(formatSinceVerbose('2026-08-04T11:48:00.000Z', now)).toBe('for 12\u00a0min');
    expect(formatSinceVerbose('2026-08-04T10:00:00.000Z', now)).toBe('for 2\u00a0h');
    expect(formatSinceVerbose('2026-08-01T12:00:00.000Z', now)).toBe('for 3\u00a0d');
  });

  it('says "just now" under a minute and for a future time, never "for 0 min"', () => {
    expect(formatSinceVerbose('2026-08-04T11:59:30.000Z', now)).toBe('just now');
    expect(formatSinceVerbose('2026-08-04T11:59:59.000Z', now)).toBe('just now');
    expect(formatSinceVerbose('2026-08-04T12:05:00.000Z', now)).toBe('just now');
  });

  it('renders no text for an invalid ISO string', () => {
    expect(formatSinceVerbose('not a date', now)).toBe('');
  });
});

// kit/MobileTopBar.vue's liveness dot (ds-spec.md §3.1: "the LiveIndicator
// dot only, with aria-label 'Live — last activity 5 min ago'"). Same
// derivation LiveIndicator.vue's own template already does (statusLabel +
// RelativeTime), factored out so the dot's aria-label cannot drift from the
// text the full indicator shows on desktop.
describe('lib/format.ts formatLiveStatus()', () => {
  const now = '2026-08-04T12:00:00.000Z';

  it('reads "Live" with no last-activity suffix when there is none', () => {
    expect(formatLiveStatus(true, null, now)).toBe('Live');
  });

  it('reads "Paused" with no last-activity suffix when there is none', () => {
    expect(formatLiveStatus(false, null, now)).toBe('Paused');
  });

  it('appends the last activity when present, live', () => {
    expect(formatLiveStatus(true, '2026-08-04T11:55:00.000Z', now)).toBe(
      'Live · last activity 5\u00a0min ago',
    );
  });

  it('appends the last activity when present, paused', () => {
    expect(formatLiveStatus(false, '2026-08-04T11:55:00.000Z', now)).toBe(
      'Paused · last activity 5\u00a0min ago',
    );
  });
});

// kit/CompactNumber.vue (ds-spec.md §2.1: `value`, `unit?: "tok"` renders
// "1.2M tokens", "127K", "43"). The "tok" prop value is the enum literal
// (matches the spec's own type spelling); the word it renders is spelled out
// in full ("tokens").
describe('lib/format.ts formatCompactValue()', () => {
  it('renders the bare compact number when no unit is given', () => {
    expect(formatCompactValue(127_000)).toBe('127K');
    expect(formatCompactValue(43)).toBe('43');
  });

  it('appends " tokens" (spelled out) when unit is "tok"', () => {
    expect(formatCompactValue(1_200_000, 'tok')).toBe('1.2M\u00a0tokens');
  });

  it('appends the unit word to a small, unsuffixed number too', () => {
    expect(formatCompactValue(43, 'tok')).toBe('43\u00a0tokens');
  });
});

describe('lib/format.ts parentLabel() (a follow-up names its origin)', () => {
  const long = `Fix: ${'the label is clipped on narrow screens and '.repeat(3)}done`;

  it('reads the parent from its title, else its plan slug, else nothing', () => {
    expect(parentLabel('epic-a/task-1-settings', 'Settings layout')).toBe('Settings layout');
    expect(parentLabel('epic-a/task-1-settings-layout', null)).toBe('Settings layout');
    expect(parentLabel('epic-a/followup-0a1b2c3d', null)).toBeNull();
    expect(parentLabel(null, null)).toBeNull();
  });

  it('never reads a parent title longer than 60 characters', () => {
    expect(long.length).toBeGreaterThan(60);
    expect(parentLabel('epic-a/task-1-settings-layout', long)).toBe('Settings layout');
    expect(parentLabel('epic-a/followup-0a1b2c3d', long)).toBeNull();
  });
});

describe('lib/format.ts formatCalendarDay()', () => {
  it('renders day and short month, no leading zero', () => {
    expect(formatCalendarDay('2026-01-23')).toBe('23 Jan');
    expect(formatCalendarDay('2026-09-05')).toBe('5 Sep');
  });

  it('does not shift the day west of UTC', () => {
    const before = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      // The trap this guards against: a date-only string parses as UTC midnight.
      expect(new Date('2026-01-23').getDate()).toBe(22);
      expect(formatCalendarDay('2026-01-23')).toBe('23 Jan');
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('returns anything that is not a YYYY-MM-DD day unchanged', () => {
    expect(formatCalendarDay('Builder')).toBe('Builder');
    expect(formatCalendarDay('2026-13-01')).toBe('2026-13-01');
  });
});

describe('lib/format.ts axisDayLabels()', () => {
  it('has no label for no days', () => {
    expect(axisDayLabels([])).toEqual([]);
  });

  it('names a single day once', () => {
    expect(axisDayLabels(['2026-01-23'])).toEqual(['23 Jan']);
  });

  it('names the first and the last of two days', () => {
    expect(axisDayLabels(['2026-01-23', '2026-01-24'])).toEqual(['23 Jan', '24 Jan']);
  });

  it('names only the first and the last of many days', () => {
    expect(axisDayLabels(['2026-01-20', '2026-01-21', '2026-01-22', '2026-01-23'])).toEqual([
      '20 Jan',
      '23 Jan',
    ]);
  });

  it('passes a label that is not a day through unchanged', () => {
    expect(axisDayLabels(['Builder', '2026-01-23'])).toEqual(['Builder', '23 Jan']);
  });
});

describe('lib/format.ts dailyTokensTakeaway()', () => {
  it('reads "the last day" for one day', () => {
    expect(dailyTokensTakeaway('role', 1)).toBe('Daily tokens by role over the last day.');
  });

  it('counts two or more days', () => {
    expect(dailyTokensTakeaway('model tier', 2)).toBe(
      'Daily tokens by model tier over the last 2 days.',
    );
    expect(dailyTokensTakeaway('role', 8)).toBe('Daily tokens by role over the last 8 days.');
  });
});
