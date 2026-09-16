// The shell-level notice that the projection behind every page is incomplete.
//
// /api/pulse carries `projectionIssues` — the sessions whose log the server
// could not read and the events whose payload it had to hold back. Until
// D-249 the first of those took the whole dashboard down with it: apply()
// folds findings and lessons from every log, so one non-JSON line in any
// session's log failed the fold for every session, and the operator saw an
// empty Sessions canvas and a Kanban with no cards — a quiet factory, by every
// visible sign. The server now folds what it can and reports the rest; this
// module is the reading of that report. It counts sessions, not issues,
// because one broken log is one problem however many events it holds.
import type { PulseResult } from './api.js';
import { pluralize } from './format.js';

export interface ProjectionNotice {
  /** One sentence: how many sessions are affected and what that costs. */
  lead: string;
  /** The server's own message per issue, in the server's order. */
  lines: string[];
}

export function projectionNotice(pulse: PulseResult | null): ProjectionNotice | null {
  const issues = pulse?.projectionIssues ?? [];
  if (issues.length === 0) return null;
  const sessions = new Set(issues.map((issue) => issue.sessionId)).size;
  return {
    lead: `${pluralize(sessions, 'session')} could not be projected in full. Every count, status and canvas below is computed without those events.`,
    lines: issues.map((issue) => issue.message),
  };
}
