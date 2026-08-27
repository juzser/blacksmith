// Which write actions the Lessons review Dialog may legally offer, and what
// the novelty gate found on the way in (P9-36).
//
// Both halves live here rather than in LessonsPage.vue for the reason
// lib/timelineDisplay.ts spells out: ui/tsconfig.json doesn't type-check .vue
// files and this repo has no component-test harness, so logic asserted from
// an SFC is logic nothing can test. Which button is legal on which status is
// the memory-poisoning boundary (architecture §9.4) — the last place to put
// an untested judgement.
import type { LessonNoveltyReview } from './api.js';

/**
 * A copy of factory/orchestrator/src/lessons.ts's LEGAL_LESSON_TRANSITIONS.
 *
 * Copied, not imported: that module reaches for node:fs and node:crypto, and
 * ui/ builds to a browser bundle. ui/test/lessonActions.test.ts imports the
 * real table and asserts this mirror equals it, so the copy cannot drift
 * silently — the same guard ui/test/taxonomy.test.ts runs over AGENT_STATUSES.
 */
export const LEGAL_LESSON_TRANSITIONS_MIRROR: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    candidate: ['pending-approval', 'approved', 'invalidated', 'novelty-rejected'],
    'pending-approval': ['approved', 'invalidated'],
    approved: ['superseded', 'invalidated'],
    'novelty-rejected': [],
    superseded: [],
    invalidated: [],
  });

export interface LessonActions {
  approve: boolean;
  /**
   * Edit's terminal action is "Save & approve" — ui/server's
   * /api/lessons/:id/edit route calls transitionLesson(..., 'approved', ...).
   * So editing is exactly as legal as approving, never more.
   */
  edit: boolean;
  reject: boolean;
}

/**
 * The review Dialog's footer, derived from the lesson's current status.
 *
 * An unknown status yields no actions at all. A build that has never heard of
 * a status cannot know its legal moves, and "probably fine" is the wrong
 * default on the boundary that exists to stop memory poisoning.
 */
export function lessonActions(lessonStatus: string): LessonActions {
  const legal = LEGAL_LESSON_TRANSITIONS_MIRROR[lessonStatus] ?? [];
  const approve = legal.includes('approved');
  return { approve, edit: approve, reject: legal.includes('invalidated') };
}

/**
 * Why the footer is missing buttons, in one line, or null when it isn't.
 *
 * A control that silently disappears reads as a broken page; the operator
 * needs to know they are looking at a lesson that is already past the point
 * of approval, not at a Dialog that failed to render. The onward statuses are
 * read out of the table rather than spelled out here, so this line cannot
 * drift from the transitions it describes.
 */
export function lessonActionsNote(lessonStatus: string): string | null {
  const legal = LEGAL_LESSON_TRANSITIONS_MIRROR[lessonStatus];
  if (!legal) {
    return `Unknown status "${lessonStatus}" — this build doesn't know which moves are legal here, so it offers none.`;
  }
  if (legal.length === 0) {
    return `This lesson is ${lessonStatus}, a terminal status: nothing moves it from here.`;
  }
  if (!legal.includes('approved')) {
    return `Already ${lessonStatus} — from here a lesson can only become ${legal.join(' or ')}, so there is nothing left to approve.`;
  }
  return null;
}

export interface NoveltyNotice {
  tone: 'warning';
  text: string;
}

/**
 * What to tell the operator about a write the novelty gate let through.
 *
 * The case that matters is the quiet one: transitionLesson only *refuses* a
 * non-novel statement when the statement was edited, so a plain Approve on a
 * near-duplicate candidate enters memory with nothing but a success toast.
 * Two near-identical rules in lessons.md are injected into every dispatch
 * from then on, and no screen ever said so.
 *
 * Returns null when there is nothing to report — a clean novel approval must
 * not grow a banner, or the operator learns to dismiss it without reading.
 */
/**
 * The bar the verdict was actually taken at, spelled for an operator.
 *
 * `review.threshold` is what the policy file says; `mostSimilar.threshold` is
 * what this pair was measured against, and for a lesson shorter than ~29 words
 * those differ (P9-35 (a)). Quoting the policy number next to the score would
 * put "scores 0.65, threshold 0.8" under the word REJECTED.
 */
function thresholdPhrase(review: LessonNoveltyReview): string {
  const bar = review.mostSimilar?.threshold ?? review.threshold;
  if (bar === review.threshold) return `threshold ${review.threshold}`;
  return `threshold ${bar.toFixed(2)}, corrected down from ${review.threshold} for the length of the shorter statement`;
}

export function noveltyNotice(review: LessonNoveltyReview | null): NoveltyNotice | null {
  if (!review?.mostSimilar) return null;
  const near = review.mostSimilarLessonId ?? 'an existing lesson';
  const score = review.mostSimilar.score.toFixed(2);

  // Checked before novelty: a polarity conflict scores as novel by
  // construction (§9.6 — "always X" vs "never X" share their shingles but
  // not their meaning), and two rules that contradict each other in memory
  // is worse news than two that agree.
  if (review.polarityConflict) {
    return {
      tone: 'warning',
      text: `This may contradict ${near} (similarity ${score}): "${review.mostSimilar.statement}". Both are now in memory and both are injected at dispatch.`,
    };
  }

  if (!review.novel) {
    return review.overridden
      ? {
          tone: 'warning',
          text: `Approved as a recorded duplicate override — scores ${score} against ${near} (${thresholdPhrase(review)}): "${review.mostSimilar.statement}".`,
        }
      : {
          tone: 'warning',
          text: `Near-duplicate of ${near} (similarity ${score}, ${thresholdPhrase(review)}): "${review.mostSimilar.statement}". An unedited approval isn't gated, so this entered memory alongside it.`,
        };
  }

  return null;
}
