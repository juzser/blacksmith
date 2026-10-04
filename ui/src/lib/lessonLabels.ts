// Human copy for one LessonCard (DS8 PR2, ds-spec.md §4.5). Kept out of the
// .vue for the reason lib/lessonActions.ts spells out: ui/tsconfig.json
// doesn't type-check .vue files and this repo has no component-test harness,
// so logic asserted from an SFC is logic nothing can test.
import { formatShortDate } from './format.js';

/**
 * The scope line under a lesson's rule. `stack-wide`/`security` have no
 * selector field — they apply to every dispatch, so there is nothing to
 * name but the breadth itself. The other three scopes are each filtered by
 * exactly one of `agentRole`/`claimPath`/`caseType` (factory/orchestrator's
 * lessons.ts table); a missing selector falls back to the scope id itself
 * rather than inventing a placeholder.
 */
export function lessonScopeLabel(
  lessonScope: string,
  selectors: { agentRole: string | null; claimPath: string | null; caseType: string | null },
): string {
  switch (lessonScope) {
    case 'stack-wide':
    case 'security':
      return 'Applies to all projects';
    case 'agent-role':
      return selectors.agentRole ? `Role: ${selectors.agentRole}` : lessonScope;
    case 'claim-path':
      return selectors.claimPath ?? lessonScope;
    case 'case-type':
      return selectors.caseType ?? lessonScope;
    default:
      return lessonScope;
  }
}

/**
 * The effectiveness line. `0` reads as "hasn't" rather than a bare 0 — the
 * plan's operator override ("unmeasured never shown as 0") is about missing
 * data, but a lesson that has genuinely never caught a repeat is not missing
 * data, so it still gets its own sentence rather than a raw count.
 */
export function preventedLabel(timesPrevented: number): string {
  if (timesPrevented <= 0) return "Hasn't prevented a repeat yet";
  if (timesPrevented === 1) return 'Prevented 1 repeat';
  return `Prevented ${timesPrevented} repeats`;
}

/**
 * "Learned from <session> on <date>", date omitted when `validFrom` is
 * null. The schema column is `NOT NULL` today, but the server widened the
 * read path to send through whatever a row actually carries rather than
 * assume every future writer keeps that guarantee — so the reader stays
 * defensive on the one field it cannot itself re-check.
 */
export function learnedFromLabel(sessionId: string, validFrom: string | null): string {
  if (!validFrom) return `Learned from ${sessionId}`;
  return `Learned from ${sessionId} on ${formatShortDate(validFrom)}`;
}
