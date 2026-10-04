// Human copy for one LessonCard (DS8 PR2, ds-spec.md §4.5). Kept out of the
// .vue for the reason lib/lessonActions.ts spells out: ui/tsconfig.json
// doesn't type-check .vue files and this repo has no component-test harness,
// so logic asserted from an SFC is logic nothing can test.
import { formatRelativeVerbose, formatShortDate } from './format.js';

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

/**
 * The phone row's short form of `learnedFromLabel` (ds-review.html .mm):
 * "From <session> · <date>", date dropped when `validFrom` is null. The
 * compact meta line has no room for the full sentence beside the
 * effectiveness clause.
 */
export function shortLearnedFromLabel(sessionId: string, validFrom: string | null): string {
  if (!validFrom) return `From ${sessionId}`;
  return `From ${sessionId} · ${formatShortDate(validFrom)}`;
}

/**
 * The phone row's short form of `preventedLabel`, lower case to read as the
 * tail of one sentence after `shortLearnedFromLabel` rather than its own.
 */
export function shortPreventedLabel(timesPrevented: number): string {
  if (timesPrevented <= 0) return 'no repeat prevented yet';
  if (timesPrevented === 1) return 'prevented 1 repeat';
  return `prevented ${timesPrevented} repeats`;
}

/**
 * The Pending tab's empty-state body (ds-spec.md §4.5, audit item Lessons-2).
 * Always names what this tab is for — a sentence an operator who has never
 * seen this page can read on its own — never the spec's own "(runs
 * automatically)" clause, which the kit's lessons pass does not promise. The
 * "Last checked" clause only appears once a pass has actually completed —
 * `lastCheckedAt` null means dream() has never run, and claiming a check
 * time for a check that never happened would be worse than omitting it.
 */
export function pendingEmptyBody(lastCheckedAt: string | null, nowIso?: string): string {
  const base = 'The factory proposes new lessons after it reviews its recent mistakes.';
  if (!lastCheckedAt) return base;
  return `${base} Last checked ${formatRelativeVerbose(lastCheckedAt, nowIso)}.`;
}
