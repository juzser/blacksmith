import { describe, expect, it } from 'vitest';
import {
  foldIntoColumns,
  KANBAN_COLUMNS,
  subStatusSummary,
  visibleTaskCount,
} from '../src/lib/kanban.js';

describe('lib/kanban.ts — §5.3 status-column folding', () => {
  it('folds all 10 non-terminal statuses into the 5 default columns, in order', () => {
    const tasks = [
      { taskId: 't1', taskStatus: 'todo' },
      { taskId: 't2', taskStatus: 'ready' },
      { taskId: 't3', taskStatus: 'in-progress' },
      { taskId: 't4', taskStatus: 'grading' },
      { taskId: 't5', taskStatus: 'reviewing' },
      { taskId: 't6', taskStatus: 'merging' },
      { taskId: 't7', taskStatus: 'blocked' },
      { taskId: 't8', taskStatus: 'escalated' },
      { taskId: 't9', taskStatus: 'completed' },
      { taskId: 't10', taskStatus: 'waived' },
    ];
    const columns = foldIntoColumns(tasks);
    expect(columns.map((c) => c.name)).toEqual([...KANBAN_COLUMNS]);
    expect(columns.find((c) => c.name === 'Todo')?.tasks.map((t) => t.taskId)).toEqual([
      't1',
      't2',
    ]);
    expect(columns.find((c) => c.name === 'In progress')?.tasks.map((t) => t.taskId)).toEqual([
      't3',
      't4',
    ]);
    expect(columns.find((c) => c.name === 'Reviewing')?.tasks.map((t) => t.taskId)).toEqual([
      't5',
      't6',
    ]);
    expect(columns.find((c) => c.name === 'Blocked')?.tasks.map((t) => t.taskId)).toEqual([
      't7',
      't8',
    ]);
    expect(columns.find((c) => c.name === 'Completed')?.tasks.map((t) => t.taskId)).toEqual([
      't9',
      't10',
    ]);
  });

  it('hides failed/superseded by default', () => {
    const tasks = [
      { taskId: 't1', taskStatus: 'failed' },
      { taskId: 't2', taskStatus: 'superseded' },
      { taskId: 't3', taskStatus: 'todo' },
    ];
    const columns = foldIntoColumns(tasks);
    const total = columns.reduce((sum, c) => sum + c.tasks.length, 0);
    expect(total).toBe(1);
  });

  it('adds Failed/Superseded columns when showAll is true', () => {
    const tasks = [
      { taskId: 't1', taskStatus: 'failed' },
      { taskId: 't2', taskStatus: 'superseded' },
    ];
    const columns = foldIntoColumns(tasks, true);
    expect(columns.map((c) => c.name)).toEqual([...KANBAN_COLUMNS, 'Failed', 'Superseded']);
    expect(columns.find((c) => c.name === 'Failed')?.tasks).toHaveLength(1);
    expect(columns.find((c) => c.name === 'Superseded')?.tasks).toHaveLength(1);
  });
});

describe('lib/kanban.ts subStatusSummary() (operator directive 1)', () => {
  it('returns null when a folded column has only one raw status', () => {
    const tasks = [
      { taskId: 't1', taskStatus: 'reviewing' },
      { taskId: 't2', taskStatus: 'reviewing' },
    ];
    expect(subStatusSummary(tasks)).toBeNull();
  });

  it('summarizes mixed raw statuses, alphabetical, with counts', () => {
    const tasks = [
      { taskId: 't1', taskStatus: 'reviewing' },
      { taskId: 't2', taskStatus: 'merging' },
      { taskId: 't3', taskStatus: 'reviewing' },
    ];
    expect(subStatusSummary(tasks)).toBe('Merging 1 · Reviewing 2');
  });
});

describe('lib/kanban.ts visibleTaskCount() (D-242)', () => {
  // The board and the count that labels it read the same payload through two
  // different rules. KanbanPage summed the server's grouping, which is keyed
  // by raw task_status and hides nothing; KanbanBoard re-folded that same
  // payload through foldIntoColumns(), which drops `failed` and `superseded`
  // from the default board. So the Toolbar counted cards the board had
  // already decided not to draw -- "9 tasks" over a board holding 7.
  const columns = [
    { taskStatus: 'todo', tasks: [{ taskId: 't1', taskStatus: 'todo' }] },
    { taskStatus: 'failed', tasks: [{ taskId: 't2', taskStatus: 'failed' }] },
    { taskStatus: 'superseded', tasks: [{ taskId: 't3', taskStatus: 'superseded' }] },
  ];

  it('counts only what the default board renders', () => {
    expect(visibleTaskCount(columns)).toBe(1);
    expect(visibleTaskCount(columns)).toBe(
      foldIntoColumns(columns.flatMap((c) => c.tasks)).reduce((n, c) => n + c.tasks.length, 0),
    );
  });

  it('counts the hidden statuses too once showAll opens their columns', () => {
    expect(visibleTaskCount(columns, true)).toBe(3);
  });

  // The empty state is the same number wearing a different face: a board of
  // nothing but superseded tasks draws no cards, so claiming "no tasks match
  // these filters" is the honest reading -- and the old count blocked it.
  it('reports zero for a payload the default board renders as empty', () => {
    expect(
      visibleTaskCount([{ taskStatus: 'failed', tasks: [{ taskId: 'x', taskStatus: 'failed' }] }]),
    ).toBe(0);
  });

  // An unknown status has no column, so no card. Counting it would put the
  // board back in the same disagreement by a different door.
  it('does not count a status no column claims', () => {
    expect(
      visibleTaskCount([
        { taskStatus: 'invented', tasks: [{ taskId: 'x', taskStatus: 'invented' }] },
      ]),
    ).toBe(0);
    expect(
      visibleTaskCount(
        [{ taskStatus: 'invented', tasks: [{ taskId: 'x', taskStatus: 'invented' }] }],
        true,
      ),
    ).toBe(0);
  });
});
