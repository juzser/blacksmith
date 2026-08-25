import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  nothingPending,
  type PendingReviewCounts,
  pendingClauses,
} from '../src/lib/pendingReview.js';

const SRC = join(import.meta.dirname, '..', 'src');

function counts(over: Partial<PendingReviewCounts> = {}): PendingReviewCounts {
  return { pendingWaivers: 0, escalations: 0, pendingLessons: 0, ...over };
}

describe('nothingPending', () => {
  it('is the all-clear when all three counts are known and zero', () => {
    expect(nothingPending(counts())).toBe(true);
  });

  for (const field of ['pendingWaivers', 'escalations', 'pendingLessons'] as const) {
    it(`is false when ${field} is non-zero`, () => {
      expect(nothingPending(counts({ [field]: 2 }))).toBe(false);
    });
  }

  // D-225. The lessons fetch is supplementary and its failure must not block
  // the page -- but it also must not be answered for. A page that says
  // "Nothing pending." off a request that never returned is making a claim
  // about the factory out of its own silence.
  it('refuses the all-clear while the lesson count is unknown', () => {
    expect(nothingPending(counts({ pendingLessons: null }))).toBe(false);
  });

  it('refuses it whatever the other two counts say', () => {
    expect(nothingPending({ pendingWaivers: 0, escalations: 0, pendingLessons: null })).toBe(false);
    expect(nothingPending({ pendingWaivers: 3, escalations: 1, pendingLessons: null })).toBe(false);
  });
});

describe('pendingClauses', () => {
  it('names nothing when nothing is pending', () => {
    expect(pendingClauses(counts())).toEqual([]);
  });

  it('drops the zero clauses rather than reading them out', () => {
    expect(pendingClauses(counts({ escalations: 2 }))).toEqual(['2 tasks escalated']);
  });

  it('pluralises each clause on its own count', () => {
    expect(pendingClauses({ pendingWaivers: 1, escalations: 2, pendingLessons: 1 })).toEqual([
      '1 waiver pending',
      '2 tasks escalated',
      '1 lesson candidate',
    ]);
  });

  // An unknown count cannot be spoken for in either direction: no clause
  // claiming candidates, and no absence implying there are none.
  it('says nothing at all about an unknown lesson count', () => {
    expect(pendingClauses(counts({ pendingLessons: null, escalations: 1 }))).toEqual([
      '1 task escalated',
    ]);
  });

  // The banner renders iff there is a clause to put in it, so an empty list
  // and a hidden banner can never disagree.
  it('is empty exactly when nothing is known to be pending', () => {
    expect(pendingClauses(counts({ pendingLessons: null })).length).toBe(0);
    expect(pendingClauses(counts({ pendingLessons: 1 })).length).toBe(1);
  });
});

// .vue templates are read by neither tsc nor biome here, so the only thing
// holding the page to this module is a test that reads its source (D-216).
describe('OverviewPage asks this module rather than re-deriving the answer', () => {
  const src = readFileSync(join(SRC, 'pages', 'OverviewPage.vue'), 'utf8');

  it('imports both helpers', () => {
    expect(src).toContain('pendingReview.js');
    expect(src).toContain('nothingPending');
    expect(src).toContain('pendingClauses');
  });

  it('does not compare the lesson count to zero itself', () => {
    expect(src).not.toContain('pendingLessons === 0');
  });

  it('does not answer a failed lessons fetch with a zero', () => {
    expect(src).not.toContain('pendingLessons.value = 0');
  });
});
