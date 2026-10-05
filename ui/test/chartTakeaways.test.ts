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

  it('reads a flat trend over a span other than 7 days by that span', () => {
    expect(
      errorsOverTimeTakeaway([
        { day: '2026-10-01', count: 3 },
        { day: '2026-10-02', count: 3 },
      ]),
    ).toBe('Errors held steady over the last 2 days.');
  });

  it('describes a roughly halved count as "fell by half" over its real span', () => {
    const days = [
      { day: '2026-09-29', count: 10 },
      { day: '2026-09-30', count: 10 },
      { day: '2026-10-01', count: 5 },
      { day: '2026-10-02', count: 5 },
    ];
    expect(errorsOverTimeTakeaway(days)).toBe('Errors fell by half over the last 4 days.');
  });

  it('describes a rise with a rounded percentage over its real span', () => {
    const days = [
      { day: '2026-09-29', count: 10 },
      { day: '2026-10-01', count: 20 },
    ];
    expect(errorsOverTimeTakeaway(days)).toBe('Errors rose by about 100% over the last 3 days.');
  });

  it('appends the dominant group when one is given', () => {
    const days = [
      { day: '2026-09-29', count: 10 },
      { day: '2026-10-01', count: 5 },
    ];
    expect(errorsOverTimeTakeaway(days, 'context window runs')).toBe(
      'Errors fell by half over the last 3 days, mostly context window runs.',
    );
  });

  it('says "this week" only when the span is exactly 7 days', () => {
    const sevenDays = [
      { day: '2026-09-25', count: 10 },
      { day: '2026-09-26', count: 10 },
      { day: '2026-09-27', count: 10 },
      { day: '2026-09-28', count: 2 },
      { day: '2026-09-29', count: 2 },
      { day: '2026-09-30', count: 2 },
      { day: '2026-10-01', count: 2 },
    ];
    expect(errorsOverTimeTakeaway(sevenDays)).toMatch(/this week\.$/);
  });

  it('says "over the last N days" for a 2-day series', () => {
    expect(
      errorsOverTimeTakeaway([
        { day: '2026-10-01', count: 1 },
        { day: '2026-10-02', count: 5 },
      ]),
    ).toMatch(/over the last 2 days\.$/);
  });

  it('says "over the last 30 days" for a 30-day series', () => {
    const days = [
      { day: '2026-09-01', count: 10 },
      { day: '2026-09-30', count: 20 },
    ];
    expect(errorsOverTimeTakeaway(days)).toMatch(/over the last 30 days\.$/);
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
