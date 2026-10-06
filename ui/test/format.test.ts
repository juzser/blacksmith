import { describe, expect, it } from 'vitest';
import {
  boardTitle,
  formatAbsolute,
  formatBudgetPct,
  formatCompactNumber,
  formatCompactValue,
  formatDurationMs,
  formatElapsed,
  formatElapsedRange,
  formatLiveStatus,
  formatMeasuredTokens,
  formatRelative,
  formatRelativeVerbose,
  formatShortDate,
  formatShortDateTime,
  parentLabel,
  pluralize,
  shortTaskId,
  summarize,
  taskLabel,
} from '../src/lib/format.js';

describe('lib/format.ts formatRelative()', () => {
  const now = '2026-08-04T12:00:00.000Z';

  it('renders "just now" for sub-5-second gaps', () => {
    expect(formatRelative('2026-08-04T11:59:58.000Z', now)).toBe('just now');
  });

  it('renders minutes/hours/days ago', () => {
    expect(formatRelative('2026-08-04T11:55:00.000Z', now)).toBe('5m ago');
    expect(formatRelative('2026-08-04T10:00:00.000Z', now)).toBe('2h ago');
    expect(formatRelative('2026-08-02T12:00:00.000Z', now)).toBe('2d ago');
  });

  // The suffix used to be the unit word's first letter, so "minute" and
  // "month" both rendered "m". A Roadmap row last touched three months ago
  // read "3m ago" -- the same string a row touched three minutes ago gets,
  // and the mini-timeline is exactly where the two need telling apart.
  it('does not spell months the way it spells minutes', () => {
    expect(formatRelative('2026-05-04T12:00:00.000Z', now)).toBe('3mo ago');
    // 181 days is 5.95 average-months, so it floors to five -- and used to
    // render the very string the assertion below produces from 5 minutes.
    expect(formatRelative('2026-02-04T12:00:00.000Z', now)).toBe('5mo ago');
    expect(formatRelative('2026-08-04T11:55:00.000Z', now)).toBe('5m ago');
  });

  it('renders weeks and years', () => {
    expect(formatRelative('2026-07-21T12:00:00.000Z', now)).toBe('2w ago');
    expect(formatRelative('2023-08-04T12:00:00.000Z', now)).toBe('3y ago');
  });

  // 4.348 weeks/month put twelve months at 365.2 days, so a gap of exactly a
  // year fell one hundredth of a month short of the year bucket and came out
  // as the largest month value there is.
  it('calls a year a year, not the largest month it can count to', () => {
    expect(formatRelative('2025-08-04T12:00:00.000Z', now)).toBe('1y ago');
  });
});

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

// Operator directive (Phase 6b round 6): "on Flow, a block is far too long and
// has far too much text -- a short summary is enough". A flow node renders
// tasks.objective, measured at 942–1472 chars on envkit-mcp-surface's
// plan-v3 — summarize() is what turns that into the node's one-line label.
describe('lib/format.ts summarize()', () => {
  it('returns the first sentence when it fits', () => {
    expect(summarize('Ship env_lint end to end. Then a second sentence follows.', 90)).toBe(
      'Ship env_lint end to end.',
    );
  });

  it('keeps a whole short string that ends in a period', () => {
    expect(summarize('Build src/mcp/paths.ts and cover it.', 90)).toBe(
      'Build src/mcp/paths.ts and cover it.',
    );
  });

  it('does not treat a filename dot as a sentence boundary', () => {
    expect(summarize('Edit src/mcp/redact.ts now', 90)).toBe('Edit src/mcp/redact.ts now');
  });

  it('hard-caps a long first sentence at a word boundary with an ellipsis', () => {
    const long =
      'Close the one hole in redact that this epic is guaranteed to walk into: redactText recognises credential shapes but has no rule for env files';
    const out = summarize(long, 90);
    expect(out.length).toBeLessThanOrEqual(91);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\s…$/);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
  });

  it('collapses newlines and runs of whitespace', () => {
    expect(summarize('Ship  env_lint\n\n  end to end.', 90)).toBe('Ship env_lint end to end.');
  });

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(summarize('', 90)).toBe('');
    expect(summarize('   \n ', 90)).toBe('');
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

// Issue #220 follow-up: {measured:false} is now a valid token_usage, so a
// spend total that includes one or more unmeasured results is a floor, not
// an exact figure — it must never read the same as a fully-measured total.
describe('lib/format.ts formatMeasuredTokens()', () => {
  it('renders a compact count when every result was measured', () => {
    expect(formatMeasuredTokens(2000, 0)).toBe('2K tok');
  });

  it('renders a floor plus the unmeasured count when spend is a mix', () => {
    expect(formatMeasuredTokens(2000, 3)).toBe('≥2K tok · 3 not measured');
  });

  it('renders "not measured" rather than "0 tok" when nothing was measured', () => {
    expect(formatMeasuredTokens(0, 3)).toBe('not measured');
  });

  it('keeps small counts exact — no suffix below a thousand', () => {
    expect(formatMeasuredTokens(999, 0)).toBe('999 tok');
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

// OverviewPage's "Recent dispatch decisions" and Timeline both show a bare
// taskId when nothing better is on hand (queries.ts's `tasks` table carries
// no title). taskLabel() is the one place that turns
// "epic-x/task-29-readme-merge-trim" into "Readme merge trim" so neither
// page re-derives the slug rules inline (D-221).
describe('lib/format.ts taskLabel()', () => {
  it('derives a label from the id when no title is given', () => {
    expect(taskLabel('epic-x/task-29-readme-merge-trim')).toBe('Readme merge trim');
  });

  it('strips a leading task-<n>- prefix even without an epic path segment', () => {
    expect(taskLabel('task-3-fix-lint')).toBe('Fix lint');
  });

  it('prefers a short, non-empty title over the derived slug', () => {
    expect(taskLabel('epic-x/task-29-readme-merge-trim', 'Merge trim')).toBe('Merge trim');
  });

  it('falls back to the derived slug when the title is empty', () => {
    expect(taskLabel('epic-x/task-29-readme-merge-trim', '')).toBe('Readme merge trim');
  });

  it('falls back to the derived slug when the title is too long to be a label', () => {
    const longTitle =
      'Rewrite the entire onboarding flow end to end including every edge case we can think of';
    expect(taskLabel('epic-x/task-29-readme-merge-trim', longTitle)).toBe('Readme merge trim');
  });

  it('handles an id with no task- prefix by just spacing and capitalizing it', () => {
    expect(taskLabel('cleanup-orphan-rows')).toBe('Cleanup orphan rows');
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

// Issue #220 follow-up: ProjectsPage's budget-used stat divided tokensSpent
// by tokensBudget inline and rendered a bare "N%" — once `tokensSpent` can be
// a floor (one or more results carry `token_usage: { measured: false }`),
// that percentage reads as exact when it is really a lower bound, and a
// project whose results are all unmeasured rendered "0%" -- a fabricated
// zero rather than "we don't know".
describe('lib/format.ts formatBudgetPct()', () => {
  it('renders a dash when the project has no budget', () => {
    expect(formatBudgetPct(0, null, 0)).toBe('-');
    expect(formatBudgetPct(500, 0, 0)).toBe('-');
  });

  it('renders a plain percentage when every result was measured', () => {
    expect(formatBudgetPct(500, 1000, 0)).toBe('50%');
  });

  it('rounds to the nearest whole percent', () => {
    expect(formatBudgetPct(333, 1000, 0)).toBe('33%');
  });

  it('renders a floor once one or more results are unmeasured', () => {
    expect(formatBudgetPct(500, 1000, 2)).toBe('≥50%');
  });

  it('renders "not measured" rather than a fabricated "0%" when nothing was measured', () => {
    expect(formatBudgetPct(0, 1000, 3)).toBe('not measured');
  });
});

// kit/RelativeTime.vue's tooltip text (ds-spec.md §2.1: "the absolute time
// ('30 Sep 2026, 14:07:12') in a Tooltip"). Distinct from formatDateTime()
// above (design-spec.md §9's numeric DD/MM/YYYY, no seconds) — that shape
// stays put for pages that already render it.
describe('lib/format.ts formatAbsolute()', () => {
  // Timezone-naive (no "Z"/offset) ISO literals: per the JS Date spec these
  // parse as local time, same as the .getHours()-style local getters
  // formatAbsolute() itself (and formatDate()/formatTime() above) use — so
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
// RequestQuote only (DS4 S5c fix round 1, fix 4) — formatDateTime() keeps
// its numeric DD/MM/YYYY shape for the pages that already render it.
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
// LessonCard only; formatDate() keeps its DD/MM/YYYY shape for other pages.
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
// exactly, e.g. "5 min ago", "2 h ago", "8 s ago"). Same tiering as
// formatRelative() above, but spaced, and "min" spelled out rather than "m" —
// formatRelative() itself is left alone since Roadmap's mini-timeline and
// Timeline rows already render its "5m ago" shape and are outside DS0 (§5).
describe('lib/format.ts formatRelativeVerbose()', () => {
  const now = '2026-08-04T12:00:00.000Z';

  it('renders "just now" for sub-5-second gaps', () => {
    expect(formatRelativeVerbose('2026-08-04T11:59:58.000Z', now)).toBe('just now');
  });

  it('renders a bare few-seconds gap as "N s ago", not "just now"', () => {
    expect(formatRelativeVerbose('2026-08-04T11:59:52.000Z', now)).toBe('8 s ago');
  });

  it('spells minutes as "min", not "m"', () => {
    expect(formatRelativeVerbose('2026-08-04T11:55:00.000Z', now)).toBe('5 min ago');
  });

  it('renders hours and days with a space before the unit', () => {
    expect(formatRelativeVerbose('2026-08-04T10:00:00.000Z', now)).toBe('2 h ago');
    expect(formatRelativeVerbose('2026-08-02T12:00:00.000Z', now)).toBe('2 d ago');
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
      'Live · last activity 5 min ago',
    );
  });

  it('appends the last activity when present, paused', () => {
    expect(formatLiveStatus(false, '2026-08-04T11:55:00.000Z', now)).toBe(
      'Paused · last activity 5 min ago',
    );
  });
});

// kit/CompactNumber.vue (ds-spec.md §2.1: `value`, `unit?: "tok"` renders
// "1.2M tokens", "127K", "43"). The "tok" prop value is the enum literal
// (matches the spec's own type spelling); the word it renders is spelled out
// in full ("tokens"), which is a deliberate difference from
// formatMeasuredTokens() above — a narrower, already-shipped budget-caption
// formatter whose "tok" abbreviation stays put for its own call sites.
describe('lib/format.ts formatCompactValue()', () => {
  it('renders the bare compact number when no unit is given', () => {
    expect(formatCompactValue(127_000)).toBe('127K');
    expect(formatCompactValue(43)).toBe('43');
  });

  it('appends " tokens" (spelled out) when unit is "tok"', () => {
    expect(formatCompactValue(1_200_000, 'tok')).toBe('1.2M tokens');
  });

  it('appends the unit word to a small, unsuffixed number too', () => {
    expect(formatCompactValue(43, 'tok')).toBe('43 tokens');
  });
});

describe('lib/format.ts boardTitle() / parentLabel() (Kanban readable titles)', () => {
  const long = `Fix: ${'the label is clipped on narrow screens and '.repeat(3)}done`;

  it('keeps a short objective as is', () => {
    expect(boardTitle('epic-a/task-1-settings', 'Settings layout')).toBe('Settings layout');
  });

  it('keeps a long objective whole instead of falling back to the id slug', () => {
    expect(long.length).toBeGreaterThan(60);
    expect(boardTitle('epic-a/followup-0a1b2c3d', long)).toBe(long);
  });

  it('humanises a plan task id without its ordinal when there is no objective', () => {
    expect(boardTitle('epic-a/task-12-settings-layout', null)).toBe('Settings layout');
    expect(boardTitle('epic-a/task-12-settings-layout', '  ')).toBe('Settings layout');
  });

  it('never prints the hex of a minted id', () => {
    for (const id of [
      'epic-a/followup-0a1b2c3d',
      '20260918-e6492f02.security',
      'epic-a/0a1b2c3d',
    ]) {
      const text = boardTitle(id, null);
      expect(text).toBe('Follow-up fix');
      expect(text).not.toMatch(/[0-9a-f]{8}/);
    }
  });

  it('appends the parent to a generic follow-up title', () => {
    expect(boardTitle('epic-a/followup-0a1b2c3d', null, 'Settings layout')).toBe(
      'Follow-up fix · Settings layout',
    );
  });

  it('reads the parent from its title, else its plan slug, else nothing', () => {
    expect(parentLabel('epic-a/task-1-settings', 'Settings layout')).toBe('Settings layout');
    expect(parentLabel('epic-a/task-1-settings-layout', null)).toBe('Settings layout');
    expect(parentLabel('epic-a/followup-0a1b2c3d', null)).toBeNull();
    expect(parentLabel(null, null)).toBeNull();
  });

  it('leaves taskLabel() as it was: a long title still falls back to the slug', () => {
    expect(taskLabel('epic-a/followup-0a1b2c3d', long)).toBe('Followup 0a1b2c3d');
  });
});
