// Which lessons the Lessons page shows under which filter.
//
// Here rather than in LessonsPage.vue for the reason lib/lessonActions.ts
// spells out: ui/tsconfig.json doesn't type-check .vue files and this repo has
// no component-test harness, so logic asserted from an SFC is logic nothing
// can test. What "All" means is exactly that kind of judgement — it used to
// mean pending + approved, which left a just-rejected lesson in no filter at
// all (D-220).
import type { LessonRecord, LessonsResult } from './api.js';

/** Every filter the page offers, in the order it renders them. */
export const LESSON_FILTERS = ['pending', 'approved', 'closed', 'all'] as const;

export type LessonFilter = (typeof LESSON_FILTERS)[number];

/**
 * The rows one filter shows. `all` means all three buckets — the name is a
 * promise to the operator, and a lesson the API returned but no filter lists
 * is a lesson they cannot audit, approve, or even confirm they rejected.
 */
export function visibleLessons(result: LessonsResult, filter: LessonFilter): LessonRecord[] {
  switch (filter) {
    case 'pending':
      return result.pending;
    case 'approved':
      return result.approved;
    case 'closed':
      return result.closed;
    default:
      // Includes `all`, and anything a future caller passes that isn't a
      // filter: showing everything is the safe miss, showing nothing is not.
      return [...result.pending, ...result.approved, ...result.closed];
  }
}
