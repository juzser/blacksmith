import { describe, expect, it } from 'vitest';
import type { LessonRecord, LessonsResult } from '../src/lib/api.js';
import { LESSON_FILTERS, visibleLessons } from '../src/lib/lessonFilters.js';

function lesson(lessonId: string, lessonStatus: string): LessonRecord {
  return {
    sessionId: 'session-1',
    lessonId,
    lessonType: 'rule',
    lessonLevel: 'principle',
    lessonStatus,
    lessonScope: 'claim-path',
    statement: `statement for ${lessonId}`,
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: null,
    provenanceEventIds: '[]',
    evidence: null,
    timesPrevented: 0,
  } as LessonRecord;
}

const buckets: LessonsResult = {
  pending: [lesson('lesson-1', 'candidate')],
  approved: [lesson('lesson-2', 'approved')],
  closed: [lesson('lesson-3', 'invalidated'), lesson('lesson-4', 'novelty-rejected')],
};

describe('lib/lessonFilters.ts', () => {
  it('offers a filter for every bucket the API returns, plus All', () => {
    expect(LESSON_FILTERS).toEqual(['pending', 'approved', 'closed', 'all']);
  });

  it('shows each bucket under its own filter', () => {
    expect(visibleLessons(buckets, 'pending').map((l) => l.lessonId)).toEqual(['lesson-1']);
    expect(visibleLessons(buckets, 'approved').map((l) => l.lessonId)).toEqual(['lesson-2']);
    expect(visibleLessons(buckets, 'closed').map((l) => l.lessonId)).toEqual([
      'lesson-3',
      'lesson-4',
    ]);
  });

  /**
   * D-220. "All" used to mean pending + approved, so a lesson the operator had
   * just rejected was in no filter at all — including the one labelled All.
   */
  it('shows every bucket under All, closed ones included', () => {
    expect(visibleLessons(buckets, 'all').map((l) => l.lessonId)).toEqual([
      'lesson-1',
      'lesson-2',
      'lesson-3',
      'lesson-4',
    ]);
  });

  it('falls back to showing everything rather than nothing on an unknown filter', () => {
    expect(visibleLessons(buckets, 'nonsense' as never)).toHaveLength(4);
  });
});
