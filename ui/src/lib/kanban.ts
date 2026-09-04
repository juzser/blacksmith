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

/**
 * How many tasks a column draws before it stops and offers the rest.
 *
 * Operator directive (Phase 10): "cap each column at ten tasks, with a view
 * more after that -- avoid having to scroll a very long way." A column is an
 * unbounded list of
 * cards inside a page that already scrolls, so a Completed column holding two
 * hundred merged tasks pushed every other column's contents off the screen --
 * the board stopped being a board and became one very long list with four
 * short ones beside it.
 */
export const KANBAN_PAGE_SIZE = 10;

export interface CappedColumn<T> {
  /** The slice the column draws. */
  visible: T[];
  /** How many it is not drawing. Zero means the column is showing everything. */
  hidden: number;
  /** How many the next reveal would add -- the number a "view more" control names. */
  nextStep: number;
}

/**
 * Take the slice of a column the board draws, and say how much it left.
 *
 * `revealedPages` is the count of EXTRA pages the reader has asked for, so 0
 * is the first render and the cap is one page. Reveal is additive rather than
 * all-or-nothing: a column of two hundred has no useful state between "ten"
 * and "two hundred", and jumping straight to the second reproduces the scroll
 * the directive is about.
 *
 * `hidden` is always the truth about the remainder, whatever the caller then
 * paints -- a cap that did not report its own remainder would be a column
 * that quietly disagrees with the count in its own header (D-242's rule for
 * visibleTaskCount(), applied one level down).
 *
 * A `pageSize` below 1 is read as "no cap" rather than as an error: the only
 * way to reach it is a caller passing a computed size, and a board that drew
 * zero cards would be a worse answer to that mistake than a board that drew
 * all of them.
 */
export function capColumn<T>(
  tasks: readonly T[],
  revealedPages = 0,
  pageSize: number = KANBAN_PAGE_SIZE,
): CappedColumn<T> {
  if (pageSize < 1) return { visible: [...tasks], hidden: 0, nextStep: 0 };
  const pages = Math.max(0, Math.floor(revealedPages)) + 1;
  const limit = pages * pageSize;
  const hidden = Math.max(0, tasks.length - limit);
  return {
    visible: tasks.slice(0, limit),
    hidden,
    nextStep: Math.min(pageSize, hidden),
  };
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
