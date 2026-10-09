import { describe, expect, it } from 'vitest';
import type { InboxRow } from '../src/lib/api.js';
import {
  ALL_PROJECTS_GROUP,
  filterInbox,
  groupInbox,
  INBOX_FILTERS,
  INBOX_KIND,
  inboxActionTarget,
  inboxCopy,
  inboxMetaPrefix,
} from '../src/lib/inbox.js';

function row(over: Partial<InboxRow> & Pick<InboxRow, 'id' | 'kind'>): InboxRow {
  return {
    project: null,
    taskId: null,
    taskTitle: null,
    role: null,
    reason: null,
    findingCount: 0,
    findingSummaries: [],
    statement: null,
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

  it('carries the store of a foreign row, and none for the served store', () => {
    const base = { id: 'w', kind: 'waiver', taskId: 'epic/t1' } as const;
    expect(inboxActionTarget(row({ ...base, store: { id: 'ab12cd34', label: 'p' } }))).toBe(
      '/tasks/epic%2Ft1?store=ab12cd34',
    );
    expect(inboxActionTarget(row({ ...base, store: { id: 'home', label: 'h' } }))).toBe(
      '/tasks/epic%2Ft1',
    );
  });

  it('falls back to Lessons when a task row somehow has no task id', () => {
    expect(inboxActionTarget(row({ id: 'w', kind: 'waiver' }))).toBe('/lessons');
  });
});

describe('lib/inbox.ts inboxCopy()', () => {
  const waiver = (over: Partial<InboxRow> = {}) =>
    row({
      id: 'waiver:epic-a/task-3-show-fee',
      kind: 'waiver',
      taskId: 'epic-a/task-3-show-fee',
      findingCount: 1,
      findingSummaries: ['Stray console.log in the widget renderer. More detail follows.'],
      ...over,
    });
  const escalation = (over: Partial<InboxRow> = {}) =>
    row({
      id: 'escalation:epic-a/task-4-checkout-flow',
      kind: 'escalation',
      taskId: 'epic-a/task-4-checkout-flow',
      role: 'coder',
      ...over,
    });

  it('waiver: names the count and the one finding', () => {
    expect(inboxCopy(waiver())).toEqual({
      title: 'Approve waiver for 1 minor finding',
      description: 'Show fee · Stray console.log in the widget renderer; merge is waiting on you',
    });
  });

  it('waiver: several findings say how many issues review found', () => {
    const copy = inboxCopy(
      waiver({ findingCount: 3, findingSummaries: ['One.', 'Two.', 'Three.'] }),
    );
    expect(copy.title).toBe('Approve waiver for 3 minor findings');
    expect(copy.description).toBe('Show fee · review found 3 issues; merge is waiting on you');
  });

  it('waiver: no summaries drops that clause', () => {
    expect(inboxCopy(waiver({ findingSummaries: [] })).description).toBe(
      'Show fee; merge is waiting on you',
    );
  });

  it('escalation: the role label and the short task name', () => {
    expect(inboxCopy(escalation())).toEqual({
      title: 'Decide on an escalated task',
      description: 'Builder stopped on Checkout flow; the task stays blocked until you choose',
    });
  });

  it('escalation: a readable reason goes before the semicolon', () => {
    expect(
      inboxCopy(escalation({ reason: 'worker deadlocked waiting on a claim' })).description,
    ).toBe(
      'Builder stopped on Checkout flow (worker deadlocked waiting on a claim); the task stays blocked until you choose',
    );
  });

  it('escalation: a long reason is left out', () => {
    const reason = 'x'.repeat(200);
    expect(inboxCopy(escalation({ reason })).description).not.toContain('xxx');
  });

  it('escalation: no role drops the role clause', () => {
    expect(inboxCopy(escalation({ role: null })).description).toBe(
      'Checkout flow stopped; the task stays blocked until you choose',
    );
  });

  it('lesson: the rule text without its trailing period', () => {
    expect(
      inboxCopy(row({ id: 'l', kind: 'lesson_candidate', statement: 'Run the linter first.' })),
    ).toEqual({
      title: 'Review a new lesson candidate',
      description: 'Run the linter first; approving applies it to future runs',
    });
  });

  it('lesson: an empty statement drops the rule clause', () => {
    expect(inboxCopy(row({ id: 'l', kind: 'lesson_candidate', statement: '  ' })).description).toBe(
      'Approving applies it to future runs',
    );
  });

  it('uses the task title when short, the slug when the title is long', () => {
    expect(inboxCopy(waiver({ taskTitle: 'Fee on the cart' })).description).toMatch(
      /^Fee on the cart · /,
    );
    expect(inboxCopy(waiver({ taskTitle: 'y'.repeat(61) })).description).toMatch(/^Show fee · /);
  });

  it('a minted id reads Follow-up fix, never the hex', () => {
    const copy = inboxCopy(waiver({ taskId: 'epic-a/followup-1a2b3c4d' }));
    expect(copy.description).toMatch(/^Follow-up fix · /);
    expect(copy.description).not.toContain('1a2b3c4d');
  });

  it('never leaks a severity code, a model name or an undefined', () => {
    for (const r of [
      waiver(),
      waiver({ findingSummaries: [] }),
      escalation(),
      escalation({ role: null }),
      row({ id: 'l', kind: 'lesson_candidate', statement: '' }),
    ]) {
      const { title, description } = inboxCopy(r);
      const text = `${title} ${description}`;
      expect(text).not.toMatch(/undefined|null|S3|S4|opus|sonnet|haiku|· ;|· $/i);
    }
  });
});

describe('lib/inbox.ts inboxMetaPrefix()', () => {
  const esc = (over: Partial<InboxRow> = {}) =>
    row({ id: 'e', kind: 'escalation', taskId: 'epic-a/task-4-checkout-flow', ...over });

  it('escalation: the short task title', () => {
    expect(inboxMetaPrefix(esc({ taskTitle: 'Checkout flow' }))).toBe('Checkout flow');
  });

  it('escalation with no title: the slug name, never the objective', () => {
    expect(inboxMetaPrefix(esc())).toBe('Checkout flow');
  });

  it('escalation with no task, waiver and lesson: null', () => {
    expect(inboxMetaPrefix(esc({ taskId: null }))).toBeNull();
    expect(inboxMetaPrefix(row({ id: 'w', kind: 'waiver', taskId: 'a/t-1-x' }))).toBeNull();
    expect(inboxMetaPrefix(row({ id: 'l', kind: 'lesson_candidate' }))).toBeNull();
  });
});
