import { describe, expect, it } from 'vitest';
import { formatElapsed, formatRelative, pluralize, summarize } from '../src/lib/format.js';

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
