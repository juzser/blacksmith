import { describe, expect, it } from 'vitest';
import { isWaivable, WAIVABLE_SEVERITIES, WAIVABLE_STATUSES } from '../src/lib/waivable';

/**
 * The predicate has to agree with two things it cannot import: the
 * orchestrator's waivers.ts (which decides whether applyBatch accepts the
 * decision at all) and queries.ts's overview counter (which decides whether
 * the "Needs you" banner claims there is something to do). Divergence in
 * either direction is a UI that lies -- a banner counting work with no
 * control, or a control whose click the API rejects.
 */
const finding = (severity: string, findingStatus: string, waiverId: string | null = null) => ({
  severity,
  findingStatus,
  waiverId,
});

describe('waivable severities and statuses', () => {
  it('matches factory/orchestrator/src/waivers.ts WAIVABLE_SEVERITIES', () => {
    expect([...WAIVABLE_SEVERITIES]).toEqual(['S3-minor', 'S4-nit']);
  });

  it('matches factory/orchestrator/src/waivers.ts WAIVABLE_STATUSES', () => {
    expect([...WAIVABLE_STATUSES]).toEqual(['raised', 'confirmed']);
  });
});

describe('isWaivable', () => {
  it('accepts every severity x status pair the overview counter counts', () => {
    for (const severity of WAIVABLE_SEVERITIES) {
      for (const status of WAIVABLE_STATUSES) {
        expect(isWaivable(finding(severity, status)), `${severity}/${status}`).toBe(true);
      }
    }
  });

  it('refuses S1/S2 -- severity.yml: those are fixed or escalated, never waived', () => {
    expect(isWaivable(finding('S1-stop-the-line', 'confirmed'))).toBe(false);
    expect(isWaivable(finding('S2-major', 'confirmed'))).toBe(false);
  });

  it('refuses a status transition() has no waived edge from', () => {
    expect(isWaivable(finding('S3-minor', 'fix-verified'))).toBe(false);
    expect(isWaivable(finding('S3-minor', 'waived'))).toBe(false);
    expect(isWaivable(finding('S3-minor', 'refuted'))).toBe(false);
  });

  it('refuses a finding that already carries a waiver', () => {
    expect(isWaivable(finding('S3-minor', 'confirmed', 'evt-9'))).toBe(false);
    expect(isWaivable(finding('S4-nit', 'raised', 'evt-9'))).toBe(false);
  });

  it('refuses an unknown severity rather than guessing it is minor', () => {
    expect(isWaivable(finding('S5-whatever', 'confirmed'))).toBe(false);
    expect(isWaivable(finding('', 'confirmed'))).toBe(false);
  });
});
