import { describe, expect, it } from 'vitest';
import { identityColorVar, identitySlot } from '../src/lib/identityColor.js';

describe('identityColor.ts', () => {
  it('is deterministic — the same id always maps to the same slot', () => {
    expect(identitySlot('epic-1')).toBe(identitySlot('epic-1'));
    expect(identityColorVar('epic-1')).toBe(identityColorVar('epic-1'));
  });

  it('returns a slot in range 1..8', () => {
    for (const id of [
      'epic-1',
      'epic-2',
      'demo-hub',
      'black-smith',
      'a',
      'zzz-long-project-name',
    ]) {
      const slot = identitySlot(id);
      expect(slot).toBeGreaterThanOrEqual(1);
      expect(slot).toBeLessThanOrEqual(8);
    }
  });

  it('renders a --ds-chart-N custom property reference', () => {
    expect(identityColorVar('epic-1')).toMatch(/^var\(--ds-chart-[1-8]\)$/);
  });

  it('different ids usually map to different slots (not every id collides)', () => {
    const slots = new Set(['epic-1', 'epic-2', 'epic-3', 'epic-4', 'epic-5'].map(identitySlot));
    expect(slots.size).toBeGreaterThan(1);
  });
});
