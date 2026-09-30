// Shared tone/percent logic behind ProgressRing.vue and ProgressBarMini.vue
// (ds-spec.md §2.1, "Progress tones and placement"). Unlike the other
// kit*.test.ts files, this one is a real behavior test, not source-text
// scraping: progressTone.ts is plain DOM-free TS, directly importable under
// ui/vitest.config.ts's `environment: 'node'`, the same way ui/test/api.test.ts
// imports straight from ui/src/lib.
import { describe, expect, it } from 'vitest';
import {
  clampedPercent,
  computeProgressTone,
  progressToneColor,
} from '../src/components/kit/progressTone.js';

describe('computeProgressTone', () => {
  describe('kind: budget (over-budget is a real, exceedable state)', () => {
    it('is accent under 90%', () => {
      expect(computeProgressTone(89, 100, 'budget')).toBe('accent');
    });
    it('is warning at exactly 90%', () => {
      expect(computeProgressTone(90, 100, 'budget')).toBe('warning');
    });
    it('is still warning at exactly 100%', () => {
      expect(computeProgressTone(100, 100, 'budget')).toBe('warning');
    });
    it('is danger once over 100%', () => {
      expect(computeProgressTone(101, 100, 'budget')).toBe('danger');
    });
  });

  describe('kind: ratio (cannot exceed its own max by definition)', () => {
    it('is accent below max', () => {
      expect(computeProgressTone(50, 100, 'ratio')).toBe('accent');
    });
    it('is success once value reaches max', () => {
      expect(computeProgressTone(100, 100, 'ratio')).toBe('success');
    });
    it('stays success past max', () => {
      expect(computeProgressTone(110, 100, 'ratio')).toBe('success');
    });
  });
});

describe('clampedPercent', () => {
  it('reads a plain ratio unchanged', () => {
    expect(clampedPercent(25, 100)).toBe(25);
  });

  it('clamps a budget past 100% to 100 for the visual fill', () => {
    expect(clampedPercent(150, 100)).toBe(100);
  });

  it('never goes negative', () => {
    expect(clampedPercent(-10, 100)).toBe(0);
  });
});

describe('progressToneColor', () => {
  it('maps accent to the raw accent token, not a tone-family pair', () => {
    expect(progressToneColor('accent')).toBe('var(--bs-accent)');
  });

  it('maps success to done-text — no dedicated --bs-tone-success-* token exists', () => {
    expect(progressToneColor('success')).toBe('var(--bs-tone-done-text)');
  });

  it('maps warning/danger to their existing tone tokens', () => {
    expect(progressToneColor('warning')).toBe('var(--bs-tone-warning-text)');
    expect(progressToneColor('danger')).toBe('var(--bs-tone-danger-text)');
  });
});
