import { describe, expect, it } from 'vitest';
import type { InboxRow } from '../src/lib/api.js';
import {
  ALL_PROJECTS_GROUP,
  filterInbox,
  groupInbox,
  INBOX_FILTERS,
  INBOX_KIND,
  inboxActionTarget,
} from '../src/lib/inbox.js';

function row(over: Partial<InboxRow> & Pick<InboxRow, 'id' | 'kind'>): InboxRow {
  return {
    title: over.id,
    description: null,
    project: null,
    taskId: null,
    createdAt: '2026-09-30T00:00:00Z',
    ...over,
  };
}

// Server order: escalation < waiver < lesson candidate.
const ROWS: InboxRow[] = [
  row({ id: 'escalation:b-1', kind: 'escalation', project: 'beta', taskId: 'b-1' }),
  row({ id: 'waiver:a-1', kind: 'waiver', project: 'alpha', taskId: 'a-1' }),
  row({ id: 'waiver:b-2', kind: 'waiver', project: 'beta', taskId: 'b-2' }),
  row({ id: 'lesson:1', kind: 'lesson_candidate' }),
];

describe('lib/inbox.ts groupInbox()', () => {
  it('groups by project in first-appearance server order, project-less rows last', () => {
    const groups = groupInbox(ROWS);
    expect(groups.map((g) => g.label)).toEqual(['beta', 'alpha', ALL_PROJECTS_GROUP]);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['escalation:b-1', 'waiver:b-2']);
    expect(groups[2]?.project).toBeNull();
  });

  it('puts "All projects" last even when a project-less row comes first', () => {
    const groups = groupInbox([ROWS[3] as InboxRow, ROWS[1] as InboxRow]);
    expect(groups.map((g) => g.label)).toEqual(['alpha', ALL_PROJECTS_GROUP]);
  });

  it('omits the "All projects" group when no row lacks a project', () => {
    expect(groupInbox(ROWS.slice(0, 3)).map((g) => g.label)).toEqual(['beta', 'alpha']);
  });

  it('with a project selected keeps only that group and hides "All projects"', () => {
    const groups = groupInbox(ROWS, 'alpha');
    expect(groups.map((g) => g.label)).toEqual(['alpha']);
  });

  it('returns no groups for no rows', () => {
    expect(groupInbox([])).toEqual([]);
  });
});

describe('lib/inbox.ts filterInbox()', () => {
  it('passes every row through on "all"', () => {
    expect(filterInbox(ROWS, 'all')).toHaveLength(4);
  });

  it('keeps only the chosen kind', () => {
    expect(filterInbox(ROWS, 'waiver').map((r) => r.id)).toEqual(['waiver:a-1', 'waiver:b-2']);
  });

  it('offers one chip per kind the server sends, plus All', () => {
    expect(INBOX_FILTERS.map((f) => f.id)).toEqual([
      'all',
      'waiver',
      'escalation',
      'lesson_candidate',
    ]);
  });
});

describe('lib/inbox.ts per-kind wording and targets', () => {
  it('tags each kind with the spec tone', () => {
    expect(INBOX_KIND.escalation.tone).toBe('danger');
    expect(INBOX_KIND.waiver.tone).toBe('blocked');
    expect(INBOX_KIND.lesson_candidate.tone).toBe('review');
  });

  it('sends waivers and escalations to the task page, lessons to Lessons', () => {
    expect(inboxActionTarget(ROWS[0] as InboxRow)).toBe('/tasks/b-1');
    expect(inboxActionTarget(ROWS[1] as InboxRow)).toBe('/tasks/a-1');
    expect(inboxActionTarget(ROWS[3] as InboxRow)).toBe('/lessons');
  });

  it('encodes task ids that carry a slash', () => {
    expect(inboxActionTarget(row({ id: 'w', kind: 'waiver', taskId: 'epic/t1' }))).toBe(
      '/tasks/epic%2Ft1',
    );
  });

  it('falls back to Lessons when a task row somehow has no task id', () => {
    expect(inboxActionTarget(row({ id: 'w', kind: 'waiver' }))).toBe('/lessons');
  });
});
