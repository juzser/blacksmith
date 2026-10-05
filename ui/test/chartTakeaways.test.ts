import { describe, expect, it } from 'vitest';
import { errorsByGroupTakeaway, errorsOverTimeTakeaway } from '../src/lib/chartTakeaways.js';

describe('errorsOverTimeTakeaway', () => {
  it('reads an empty window as no errors, never a bare zero', () => {
    expect(errorsOverTimeTakeaway([])).toBe('No errors recorded in this window.');
  });

  it('reads every day at zero the same as empty', () => {
    expect(
      errorsOverTimeTakeaway([
        { day: '2026-10-01', count: 0 },
        { day: '2026-10-02', count: 0 },
      ]),
    ).toBe('No errors recorded in this window.');
  });

  it('names the single day when only one point is given', () => {
    expect(errorsOverTimeTakeaway([{ day: '2026-10-01', count: 1 }])).toBe(
      '1 error on 2026-10-01.',
    );
    expect(errorsOverTimeTakeaway([{ day: '2026-10-01', count: 4 }])).toBe(
      '4 errors on 2026-10-01.',
    );
  });

  it('reads a flat trend as steady', () => {
    expect(
      errorsOverTimeTakeaway([
        { day: '2026-10-01', count: 3 },
        { day: '2026-10-02', count: 3 },
      ]),
    ).toBe('Errors held steady this week.');
  });

  it('describes a roughly halved count as "fell by half"', () => {
    const days = [
      { day: '2026-09-29', count: 10 },
      { day: '2026-09-30', count: 10 },
      { day: '2026-10-01', count: 5 },
      { day: '2026-10-02', count: 5 },
    ];
    expect(errorsOverTimeTakeaway(days)).toBe('Errors fell by half this week.');
  });

  it('describes a rise with a rounded percentage', () => {
    const days = [
      { day: '2026-09-29', count: 10 },
      { day: '2026-10-01', count: 20 },
    ];
    expect(errorsOverTimeTakeaway(days)).toBe('Errors rose by about 100% this week.');
  });

  it('appends the dominant group when one is given', () => {
    const days = [
      { day: '2026-09-29', count: 10 },
      { day: '2026-10-01', count: 5 },
    ];
    expect(errorsOverTimeTakeaway(days, 'context window runs')).toBe(
      'Errors fell by half this week, mostly context window runs.',
    );
  });

  it('excludes an unmeasured (non-finite) count from the trend instead of reading it as zero', () => {
    const days = [
      { day: '2026-09-29', count: Number.NaN },
      { day: '2026-09-30', count: 5 },
    ];
    expect(errorsOverTimeTakeaway(days)).toBe('5 errors on 2026-09-30.');
  });
});

describe('errorsByGroupTakeaway', () => {
  it('reads an empty set as no errors', () => {
    expect(errorsByGroupTakeaway([])).toBe('No errors recorded in this window.');
  });

  it('reads every group at zero the same as empty', () => {
    expect(
      errorsByGroupTakeaway([
        { label: 'context window', count: 0 },
        { label: 'tool error', count: 0 },
      ]),
    ).toBe('No errors recorded in this window.');
  });

  it('names the sole group when only one is present', () => {
    expect(errorsByGroupTakeaway([{ label: 'context window', count: 9 }])).toBe(
      'All errors are context window.',
    );
  });

  it('names the most common group and its share of the total', () => {
    const groups = [
      { label: 'context window', count: 60 },
      { label: 'tool error', count: 40 },
    ];
    expect(errorsByGroupTakeaway(groups)).toBe(
      'context window is the most common error, 60% of the total.',
    );
  });

  it('excludes an unmeasured (non-finite) count from the total and the ranking', () => {
    const groups = [
      { label: 'context window', count: Number.NaN },
      { label: 'tool error', count: 10 },
    ];
    expect(errorsByGroupTakeaway(groups)).toBe('All errors are tool error.');
  });
});
