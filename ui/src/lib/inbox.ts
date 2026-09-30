// NeedsYouInbox's pure half (ds-spec.md §2.2 `NeedsYouInbox`, §4.1 point 1):
// grouping, filtering and per-kind wording, kept out of the .vue file so the
// DOM-free vitest config can hold it to the spec's rules.
import type { InboxKind, InboxRow } from './api.js';

/** The last group's header: rows with no project (lesson candidates today). */
export const ALL_PROJECTS_GROUP = 'All projects';

export interface InboxGroup {
  /** The project key, or null for the "All projects" group. */
  project: string | null;
  label: string;
  rows: InboxRow[];
}

/**
 * One group per project, in the order the server returned the rows. The
 * server sorts by urgency (escalation < waiver < lesson candidate, then
 * oldest), so the group holding the most urgent row comes first; project-less
 * rows always go in a last "All projects" group. With a project selected only
 * that project's group is kept, and "All projects" is hidden.
 */
export function groupInbox(rows: InboxRow[], selectedProject?: string): InboxGroup[] {
  const byProject = new Map<string, InboxRow[]>();
  const projectless: InboxRow[] = [];
  for (const row of rows) {
    if (row.project === null) {
      projectless.push(row);
      continue;
    }
    const list = byProject.get(row.project) ?? [];
    list.push(row);
    byProject.set(row.project, list);
  }
  const groups: InboxGroup[] = [...byProject].map(([project, list]) => ({
    project,
    label: project,
    rows: list,
  }));
  if (selectedProject !== undefined) return groups.filter((g) => g.project === selectedProject);
  if (projectless.length > 0) {
    groups.push({ project: null, label: ALL_PROJECTS_GROUP, rows: projectless });
  }
  return groups;
}

export type InboxFilter = 'all' | InboxKind;

/** The filter chips, in the spec's order. Stop points have no source yet. */
export const INBOX_FILTERS: { id: InboxFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'waiver', label: 'Waivers' },
  { id: 'escalation', label: 'Escalations' },
  { id: 'lesson_candidate', label: 'Lesson candidates' },
];

export function filterInbox(rows: InboxRow[], filter: InboxFilter): InboxRow[] {
  return filter === 'all' ? rows : rows.filter((r) => r.kind === filter);
}

type TagTone = 'danger' | 'blocked' | 'review';

/** Per-kind tag text, tag tone, and the action the row offers. */
export const INBOX_KIND: Record<InboxKind, { tag: string; tone: TagTone; action: string }> = {
  escalation: { tag: 'Escalation', tone: 'danger', action: 'Open' },
  waiver: { tag: 'Waiver', tone: 'blocked', action: 'Review' },
  lesson_candidate: { tag: 'Lesson', tone: 'review', action: 'Review' },
};

/**
 * Where a row's action goes: the existing page for that kind. Waivers and
 * escalations are decided on the task's own page; lesson candidates on
 * Lessons.
 */
export function inboxActionTarget(row: InboxRow): string {
  if (row.taskId !== null && row.kind !== 'lesson_candidate') {
    return `/tasks/${encodeURIComponent(row.taskId)}`;
  }
  return '/lessons';
}
