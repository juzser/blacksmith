import { describe, expect, it } from 'vitest';
import type { ErrorClassSummary } from '../src/lib/api.js';
import {
  errorClassCardView,
  humanizeClass,
  severityPillLabel,
  severityShortLabel,
  trend7dCaption,
} from '../src/lib/errorClassCards.js';

function summary(overrides: Partial<ErrorClassSummary> = {}): ErrorClassSummary {
  return {
    id: 'economy.context-overrun',
    errorGroup: 'economy',
    errorClass: 'context-overrun',
    count: 109,
    severityMix: { 'S3-minor': 90, 'S2-major': 19 },
    lastSeen: '2026-10-01T09:58:00.000Z',
    projects: ['shop-ux-1'],
    trend7d: [1, 2, 0, 3, 4, 2, 1],
    ...overrides,
  };
}

describe('severityShortLabel', () => {
  it('drops the leading S-number and reads the dashes as spaces', () => {
    expect(severityShortLabel('S3-minor')).toBe('minor');
    expect(severityShortLabel('S1-stop-the-line')).toBe('stop the line');
    expect(severityShortLabel('S2-major')).toBe('major');
    expect(severityShortLabel('S4-nit')).toBe('nit');
  });
});

describe('humanizeClass', () => {
  it('reads dashes as spaces and capitalizes the first word only, also used for group ids', () => {
    expect(humanizeClass('context-overrun')).toBe('Context overrun');
    expect(humanizeClass('economy')).toBe('Economy');
    expect(humanizeClass('')).toBe('');
  });
});

describe('errorClassCardView', () => {
  it('builds a headline naming the class, its count, and the dominant severity', () => {
    const view = errorClassCardView(summary());
    expect(view.headline).toBe('Context overrun, 109 times, mostly minor');
  });

  it('reads a single occurrence as singular', () => {
    const view = errorClassCardView(summary({ count: 1, severityMix: { 'S3-minor': 1 } }));
    expect(view.headline).toBe('Context overrun, 1 time, mostly minor');
  });

  it('sorts the severity mix by count, descending, with a "label: count" pill when there are several', () => {
    const view = errorClassCardView(
      summary({ severityMix: { 'S3-minor': 2, 'S1-stop-the-line': 5, 'S2-major': 3 } }),
    );
    expect(view.severityMix).toEqual([
      {
        severity: 'S1-stop-the-line',
        label: 'stop the line',
        count: 5,
        pillLabel: 'stop the line: 5',
      },
      { severity: 'S2-major', label: 'major', count: 3, pillLabel: 'major: 3' },
      { severity: 'S3-minor', label: 'minor', count: 2, pillLabel: 'minor: 2' },
    ]);
  });

  it('shows just the severity label in the pill when the class has exactly one severity', () => {
    const view = errorClassCardView(summary({ severityMix: { 'S3-minor': 90 } }));
    expect(view.severityMix).toEqual([
      { severity: 'S3-minor', label: 'minor', count: 90, pillLabel: 'minor' },
    ]);
  });

  it('omits the "mostly" clause when there is no severity mix at all', () => {
    const view = errorClassCardView(summary({ severityMix: {} }));
    expect(view.headline).toBe('Context overrun, 109 times');
  });

  it('carries the trend and last-seen fields through unchanged', () => {
    const view = errorClassCardView(summary());
    expect(view.trend7d).toEqual([1, 2, 0, 3, 4, 2, 1]);
    expect(view.lastSeen).toBe('2026-10-01T09:58:00.000Z');
    expect(view.id).toBe('economy.context-overrun');
  });

  it('carries a trend caption built from the trend7d direction', () => {
    const view = errorClassCardView(summary({ trend7d: [0, 0, 0, 1, 2, 3, 4] }));
    expect(view.trendCaption).toBe('Rising over the last 7 days.');
  });
});

describe('severityPillLabel', () => {
  it('shows just the label when the class has exactly one severity', () => {
    expect(severityPillLabel('minor', 5, 1)).toBe('minor');
  });

  it('shows "label: count" when the class has several severities', () => {
    expect(severityPillLabel('minor', 5, 2)).toBe('minor: 5');
  });
});

describe('trend7dCaption', () => {
  it('reads an empty trend as none', () => {
    expect(trend7dCaption([])).toBe('None in the last 7 days.');
  });

  it('reads an all-zero trend as none, never a bare zero', () => {
    expect(trend7dCaption([0, 0, 0, 0, 0, 0, 0])).toBe('None in the last 7 days.');
  });

  it('reads a flat non-zero trend as steady', () => {
    expect(trend7dCaption([1, 1, 1, 1, 1, 1, 1])).toBe('Steady over the last 7 days.');
  });

  it('reads a rising second half as rising', () => {
    expect(trend7dCaption([0, 0, 0, 1, 2, 3, 4])).toBe('Rising over the last 7 days.');
  });

  it('reads a falling second half as falling', () => {
    expect(trend7dCaption([4, 3, 2, 1, 0, 0, 0])).toBe('Falling over the last 7 days.');
  });
});
