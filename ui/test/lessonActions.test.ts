import { describe, expect, it } from 'vitest';
// The drift guard: the real transition table, imported the way
// ui/test/taxonomy.test.ts imports AGENT_STATUSES/MILESTONE_STATUSES. The
// UI cannot import this at runtime (ui/ is a browser bundle, lessons.ts
// reaches for node:fs), so lessonActions.ts keeps a copy — and a copy that
// nothing checks is a copy that goes stale.
import { LEGAL_LESSON_TRANSITIONS } from '../../factory/orchestrator/src/lessons.js';
import type { LessonNoveltyReview } from '../src/lib/api.js';
import {
  LEGAL_LESSON_TRANSITIONS_MIRROR,
  lessonActions,
  lessonActionsNote,
  noveltyNotice,
} from '../src/lib/lessonActions.js';

function review(overrides: Partial<LessonNoveltyReview>): LessonNoveltyReview {
  return {
    statement: 'Always check the upper loop bound against array length.',
    edited: false,
    novel: true,
    polarityConflict: false,
    threshold: 0.8,
    mostSimilar: null,
    mostSimilarLessonId: null,
    overridden: false,
    ...overrides,
  };
}

describe('lib/lessonActions.ts', () => {
  it('mirrors the orchestrator transition table exactly', () => {
    expect(LEGAL_LESSON_TRANSITIONS_MIRROR).toEqual(LEGAL_LESSON_TRANSITIONS);
  });

  describe('lessonActions', () => {
    // The bug this file exists to close. lessonsPage() returns an `approved`
    // bucket and the page renders it under the Approved/All filters, so the
    // review Dialog was offering Approve on a row whose only legal moves are
    // superseded and invalidated — a button that could only ever produce
    // `lessons.illegal-transition` in a red Banner.
    it('offers no Approve on an already-approved lesson, but keeps Reject', () => {
      expect(lessonActions('approved')).toEqual({ approve: false, edit: false, reject: true });
    });

    it('offers everything on a candidate and on pending-approval', () => {
      expect(lessonActions('candidate')).toEqual({ approve: true, edit: true, reject: true });
      expect(lessonActions('pending-approval')).toEqual({
        approve: true,
        edit: true,
        reject: true,
      });
    });

    // Terminal per architecture §9.4 — the memory-poisoning boundary. A
    // lesson the operator threw out must not come back through a button.
    it('offers nothing on a terminal status', () => {
      for (const status of ['novelty-rejected', 'superseded', 'invalidated']) {
        expect(lessonActions(status)).toEqual({ approve: false, edit: false, reject: false });
      }
    });

    // Fails closed: a status this build has never heard of is a status whose
    // legal moves it cannot know, and guessing "probably fine" on the write
    // boundary is the wrong default.
    it('offers nothing on an unknown status', () => {
      expect(lessonActions('invented-tomorrow')).toEqual({
        approve: false,
        edit: false,
        reject: false,
      });
    });

    // Edit's terminal action is "Save & approve": ui/server's /edit route
    // posts transitionLesson(..., 'approved', ...). So the Edit affordance is
    // exactly as legal as Approve, never more.
    it('never offers edit where it would not offer approve', () => {
      for (const status of Object.keys(LEGAL_LESSON_TRANSITIONS)) {
        const actions = lessonActions(status);
        expect(actions.edit).toBe(actions.approve);
      }
    });
  });

  // A button that vanishes with no explanation reads as a broken page. The
  // note says which status the operator is looking at and where it can still go.
  describe('lessonActionsNote', () => {
    it('says why there is nothing to approve on an approved lesson', () => {
      const note = lessonActionsNote('approved');
      expect(note).toContain('approved');
      expect(note).toContain('superseded');
      expect(note).toContain('invalidated');
    });

    it('names a terminal status as terminal', () => {
      for (const status of ['novelty-rejected', 'superseded', 'invalidated']) {
        expect(lessonActionsNote(status)).toMatch(/terminal/i);
      }
    });

    it('says nothing where every action is on offer', () => {
      expect(lessonActionsNote('candidate')).toBeNull();
      expect(lessonActionsNote('pending-approval')).toBeNull();
    });

    it('admits it does not recognise an unknown status', () => {
      expect(lessonActionsNote('invented-tomorrow')).toMatch(/unknown/i);
    });
  });

  describe('noveltyNotice', () => {
    // Approve WITHOUT an edit is not gated — transitionLesson only throws
    // `lessons.edit-not-novel` when a statement was edited. So a near-duplicate
    // can enter memory on a plain Approve, and until now the operator saw a
    // "Lesson approved." toast and nothing else.
    it('warns when a non-novel statement was approved anyway', () => {
      const notice = noveltyNotice(
        review({
          novel: false,
          mostSimilar: {
            statement: 'Check the loop bound, not a constant.',
            score: 0.91,
            threshold: 0.8,
          },
          mostSimilarLessonId: 'lesson-3',
        }),
      );
      expect(notice?.tone).toBe('warning');
      expect(notice?.text).toContain('lesson-3');
      expect(notice?.text).toContain('0.91');
    });

    it('names an override as an override', () => {
      const notice = noveltyNotice(
        review({
          novel: false,
          edited: true,
          overridden: true,
          mostSimilar: { statement: 'Check the loop bound.', score: 0.86, threshold: 0.8 },
          mostSimilarLessonId: 'lesson-3',
        }),
      );
      expect(notice?.tone).toBe('warning');
      expect(notice?.text).toMatch(/override/i);
    });

    // §9.6: a polarity conflict is a lesson that says the opposite of one
    // already in memory. Novel by score, and the most dangerous thing the
    // gate can find — two rules that contradict each other both get injected.
    it('warns on a polarity conflict even when the statement scores novel', () => {
      const notice = noveltyNotice(
        review({
          novel: true,
          polarityConflict: true,
          mostSimilar: { statement: 'Never check the loop bound.', score: 0.72, threshold: 0.6 },
          mostSimilarLessonId: 'lesson-9',
        }),
      );
      expect(notice?.tone).toBe('warning');
      expect(notice?.text).toMatch(/contradict/i);
      expect(notice?.text).toContain('lesson-9');
    });

    // The notice quotes the bar the verdict was taken at. Most real lessons
    // are short enough that the gate corrects the configured 0.8 down (P9-35
    // (a)), so printing the policy number beside the score would tell the
    // operator their rejected statement scored 0.65 against a threshold of
    // 0.8 — a contradiction with no way to resolve it.
    it('quotes the corrected bar, and says it was corrected', () => {
      const notice = noveltyNotice(
        review({
          novel: false,
          mostSimilar: {
            statement: 'Check the loop bound, not a constant.',
            score: 0.65,
            threshold: 0.6,
          },
          mostSimilarLessonId: 'lesson-3',
        }),
      );
      expect(notice?.text).toContain('threshold 0.60');
      expect(notice?.text).toMatch(/corrected down from 0\.8/);
    });

    // ...and stays quiet about the correction when there was none.
    it('names the configured threshold plainly when no correction applied', () => {
      const notice = noveltyNotice(
        review({
          novel: false,
          mostSimilar: { statement: 'Check the loop bound.', score: 0.91, threshold: 0.8 },
          mostSimilarLessonId: 'lesson-3',
        }),
      );
      expect(notice?.text).toContain('threshold 0.8');
      expect(notice?.text).not.toMatch(/corrected/);
    });

    // Nothing to say is said with nothing: a clean approval must not grow a
    // banner the operator learns to dismiss without reading.
    it('says nothing about a clean novel approval, or about a write with no review', () => {
      expect(noveltyNotice(review({}))).toBeNull();
      expect(noveltyNotice(null)).toBeNull();
    });

    // The corpus is empty on the very first lesson: novel, but with no
    // nearest neighbour to name.
    it('says nothing when there was no corpus to compare against', () => {
      expect(noveltyNotice(review({ novel: true, mostSimilar: null }))).toBeNull();
    });
  });
});
