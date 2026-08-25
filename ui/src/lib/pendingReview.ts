// Overview's "Pending your review" card and its "Needs you" banner both answer
// one question: is anything waiting on the operator? Two of the three counts
// arrive on /api/overview and the third on /api/lessons, and those two calls
// fail independently -- so the third count can be missing while the other two
// are real.
//
// A count that never arrived is not a count of zero. Carrying the unknown as
// `null` all the way to the render is what this module exists for: before
// D-225 the page's supplementary catch wrote 0, and a failed lessons fetch
// rendered the positive claim "Nothing pending." on the one card whose whole
// job is to say whether the operator is needed.
import { pluralize } from './format.js';

export interface PendingReviewCounts {
  pendingWaivers: number;
  escalations: number;
  /** `null` while the lessons fetch has not succeeded. Never coerce it to 0. */
  pendingLessons: number | null;
}

/**
 * The all-clear. True only when every count is known AND every count is zero
 * -- `null === 0` is false, which is the entire guard: an unknown count can
 * never produce the claim.
 */
export function nothingPending(counts: PendingReviewCounts): boolean {
  return counts.pendingWaivers === 0 && counts.escalations === 0 && counts.pendingLessons === 0;
}

/**
 * Clauses for the banner title -- only the non-zero ones (uiux S3 #10: three
 * clauses with two zeros in them made the operator read past the answer).
 *
 * An unknown lesson count contributes no clause, so it can neither claim work
 * nor deny it. `length > 0` is also the page's "does the banner render at all"
 * test, which keeps the banner and the sentence from ever disagreeing.
 */
export function pendingClauses(counts: PendingReviewCounts): string[] {
  const clauses: string[] = [];
  if (counts.pendingWaivers > 0)
    clauses.push(`${pluralize(counts.pendingWaivers, 'waiver')} pending`);
  if (counts.escalations > 0) clauses.push(`${pluralize(counts.escalations, 'task')} escalated`);
  if (counts.pendingLessons !== null && counts.pendingLessons > 0) {
    clauses.push(pluralize(counts.pendingLessons, 'lesson candidate'));
  }
  return clauses;
}
