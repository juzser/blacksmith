import { describe, expect, it } from 'vitest';
import type { ErrorClassSummary } from '../src/lib/api.js';
import { errorClassCardView, severityShortLabel } from '../src/lib/errorClassCards.js';

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

describe('errorClassCardView', () => {
  it('builds a headline naming the class, its count, and the dominant severity', () => {
    const view = errorClassCardView(summary());
    expect(view.headline).toBe('Context overrun, 109 times, mostly minor');
  });

  it('reads a single occurrence as singular', () => {
    const view = errorClassCardView(summary({ count: 1, severityMix: { 'S3-minor': 1 } }));
    expect(view.headline).toBe('Context overrun, 1 time, mostly minor');
  });

  it('sorts the severity mix by count, descending', () => {
    const view = errorClassCardView(
      summary({ severityMix: { 'S3-minor': 2, 'S1-stop-the-line': 5, 'S2-major': 3 } }),
    );
    expect(view.severityMix).toEqual([
      { severity: 'S1-stop-the-line', label: 'stop the line', count: 5 },
      { severity: 'S2-major', label: 'major', count: 3 },
      { severity: 'S3-minor', label: 'minor', count: 2 },
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
});
