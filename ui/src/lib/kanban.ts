// Kanban §5.3 status-column folding: reconciles taxonomy.yml's 12-value
// task_status against §10's 5-column board. `failed`/`superseded` are
// terminal/replaced, hidden from the default board (design-spec.md §5.3).
export const KANBAN_COLUMNS = ['Todo', 'In progress', 'Reviewing', 'Blocked', 'Completed'] as const;
export type KanbanColumnName = (typeof KANBAN_COLUMNS)[number];

const COLUMN_FOR_STATUS: Record<string, KanbanColumnName> = {
  todo: 'Todo',
  ready: 'Todo',
  'in-progress': 'In progress',
  grading: 'In progress',
  reviewing: 'Reviewing',
  merging: 'Reviewing',
  blocked: 'Blocked',
  escalated: 'Blocked',
  completed: 'Completed',
  waived: 'Completed',
};

const HIDDEN_BY_DEFAULT = new Set(['failed', 'superseded']);

/** Board column for a task_status, or null when it's hidden from the default (non-"All") board. */
export function columnForStatus(taskStatus: string, showAll = false): KanbanColumnName | null {
  if (!showAll && HIDDEN_BY_DEFAULT.has(taskStatus)) return null;
  return COLUMN_FOR_STATUS[taskStatus] ?? null;
}

export interface KanbanTaskLike {
  taskId: string;
  taskStatus: string;
}

/** Groups tasks into the 5 default columns (or 7 with showAll), in KANBAN_COLUMNS order. */
export function foldIntoColumns<T extends KanbanTaskLike>(
  tasks: readonly T[],
  showAll = false,
): Array<{ name: string; tasks: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const name of KANBAN_COLUMNS) buckets.set(name, []);
  if (showAll) {
    buckets.set('Failed', []);
    buckets.set('Superseded', []);
  }

  for (const task of tasks) {
    let column = columnForStatus(task.taskStatus, showAll);
    if (!column && showAll) {
      if (task.taskStatus === 'failed') column = 'Failed' as KanbanColumnName;
      else if (task.taskStatus === 'superseded') column = 'Superseded' as KanbanColumnName;
    }
    if (!column) continue;
    const bucket = buckets.get(column);
    if (bucket) bucket.push(task);
  }

  return [...buckets.entries()].map(([name, tasksInColumn]) => ({ name, tasks: tasksInColumn }));
}

function titleCase(status: string): string {
  return status
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Operator directive 1 (Kanban cleanup pass): "sub-status text only where
 * it adds signal" — a folded column whose raw task_status values differ
 * (e.g. Reviewing = reviewing + merging) gets a "Reviewing 5 · Merging 2"
 * caption; a column with only one raw status underneath returns null (no
 * sub-status line — nothing more to say than the count already shown).
 */
export function subStatusSummary<T extends KanbanTaskLike>(tasks: readonly T[]): string | null {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.taskStatus, (counts.get(t.taskStatus) ?? 0) + 1);
  if (counts.size <= 1) return null;
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${titleCase(status)} ${count}`)
    .join(' · ');
}

/**
 * How many tasks the board actually draws for this payload.
 *
 * The server groups by raw task_status and hides nothing, so summing its
 * columns counts `failed`/`superseded` rows that foldIntoColumns() then drops
 * from the default board. A caller that labels the board with that sum quotes
 * a number the board disagrees with -- and the same number, at zero, is what
 * gates the empty state (D-242). Defined through foldIntoColumns() on purpose:
 * the count and the board cannot drift while only one of them decides.
 */
export function visibleTaskCount(
  // The server's column shape, `taskStatus` included: this reads a payload,
  // not an arbitrary bag of tasks, and a signature that only accepted part of
  // one would reject the very literal a test writes to describe it.
  columns: ReadonlyArray<{ taskStatus: string; tasks: readonly KanbanTaskLike[] }>,
  showAll = false,
): number {
  const tasks = columns.flatMap((column) => [...column.tasks]);
  return foldIntoColumns(tasks, showAll).reduce((total, column) => total + column.tasks.length, 0);
}
