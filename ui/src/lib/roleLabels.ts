/**
 * Plain-word labels for factory/policies/taxonomy.yml's `agent` enum
 * (version 11, ~line 25-27) — the operator finds the dashboard's raw role
 * strings ("spec-reviewer", "security-reviewer") too technical. The raw
 * `role · tier` pair is never actually lost: every call site keeps it in a
 * `title` tooltip alongside this label.
 *
 * Kept in sync with taxonomy.yml by hand (no yaml dependency in this
 * project) — a role the taxonomy adds before this map catches up still
 * renders something readable, via roleLabel()'s title-cased fallback below,
 * rather than a blank chip.
 */
const ROLE_LABELS: Record<string, string> = {
  planner: 'Planner',
  'spec-reviewer': 'Plan reviewer',
  researcher: 'Researcher',
  coder: 'Builder',
  tester: 'Tester',
  grader: 'Quality grader',
  reviewer: 'Code reviewer',
  verifier: 'Finding checker',
  'security-reviewer': 'Security reviewer',
  merger: 'Merge fixer',
  scribe: 'Note writer',
  uiux: 'Designer',
  'wave-runner': 'Batch runner',
  auditor: 'Auditor',
  operator: 'You',
};

/** "Builder" for "coder", "You" for the human operator, and so on. */
export function roleLabel(role: string): string {
  const known = ROLE_LABELS[role];
  if (known) return known;
  // Unknown role: title-case the raw hyphenated string rather than render
  // it blank or verbatim, so a taxonomy addition never outruns this map by
  // showing nothing.
  return role
    .split('-')
    .map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}
