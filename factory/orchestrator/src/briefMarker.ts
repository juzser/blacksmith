// The first-line comment that marks a prompt as a composed brief for one role.
// One definition: brief compose writes it, the PreToolUse hook reads it.

/**
 * Every role with an agent template. A marker naming anything else is no
 * marker. Kept local so the hook's hot path imports nothing heavy.
 */
const KNOWN_ROLES: ReadonlySet<string> = new Set([
  'coder',
  'tester',
  'planner',
  'researcher',
  'spec-reviewer',
  'grader',
  'reviewer',
  'verifier',
  'security-reviewer',
  'auditor',
  'uiux',
  'merger',
  'scribe',
  'wave-runner',
]);

export interface BriefMarker {
  readonly role: string;
  readonly taskId: string;
  readonly sessionId: string;
}

/** A marker is far shorter than this; a longer first line is never one. */
const MAX_FIRST_LINE = 1024;

const MARKER_RE = /^<!-- bs-brief role=([a-z][a-z-]*) task=(\S+) session=(\S+) -->$/;

/** Serves epic bs-optimize criterion 6: the one writer of the brief marker line. */
export function formatBriefMarker(marker: BriefMarker): string {
  return `<!-- bs-brief role=${marker.role} task=${marker.taskId} session=${marker.sessionId} -->`;
}

/**
 * Serves epic bs-optimize criterion 6: the marker if the whole first line of
 * `text` (after one leading BOM) is one naming a known role, else `null`.
 */
export function parseBriefMarker(text: string): BriefMarker | null {
  const start = text.startsWith('﻿') ? 1 : 0;
  const newline = text.indexOf('\n', start);
  const end = newline === -1 ? text.length : newline;
  if (end - start > MAX_FIRST_LINE) return null;
  let line = text.slice(start, end);
  if (line.endsWith('\r')) line = line.slice(0, -1);
  const match = MARKER_RE.exec(line);
  if (match === null) return null;
  const [, role = '', taskId = '', sessionId = ''] = match;
  if (!KNOWN_ROLES.has(role)) return null;
  return { role, taskId, sessionId };
}
