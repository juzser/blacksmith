// Kanban §5.3 status-column folding: reconciles taxonomy.yml's 12-value
// task_status against §10's 5-column board. `failed`/`superseded` are
// terminal/replaced, hidden from the default board (design-spec.md §5.3).
import { agentWaitingThresholdMs } from './constants.js';
import { taskLabel } from './format.js';
import { roleLabel } from './roleLabels.js';
import { foreignStoreId, type StoreRef, storeKey } from './storeKey.js';
import { isTaskOver, type KitTone, taskStatusKitTone } from './taxonomy.js';

export const KANBAN_COLUMNS = ['Todo', 'In progress', 'Reviewing', 'Blocked', 'Completed'] as const;
export type KanbanColumnName = (typeof KANBAN_COLUMNS)[number];

// DS4 S5b fix round 1 — exported (with HIDDEN_BY_DEFAULT below) so
// ui/test/kanban.test.ts can guard this mapping against db/queries.ts's
// statusBucketForTaskStatus() without a second, hand-copied roster. Read
// only; nothing in this module's own behavior changes.
export const COLUMN_FOR_STATUS: Record<string, KanbanColumnName> = {
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

export const HIDDEN_BY_DEFAULT = new Set(['failed', 'superseded']);

/** Board column for a task_status, or null when it's hidden from the default (non-"All") board. */
export function columnForStatus(taskStatus: string, showAll = false): KanbanColumnName | null {
  if (!showAll && HIDDEN_BY_DEFAULT.has(taskStatus)) return null;
  return COLUMN_FOR_STATUS[taskStatus] ?? null;
}

export interface KanbanTaskLike {
  taskId: string;
  taskStatus: string;
  store?: StoreRef;
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

export function titleCase(status: string): string {
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

export interface AgentChipLike {
  taskStatus: string;
  agentRole: string | null;
  agentModelTier: string | null;
  agentActivity: 'working' | 'stalled' | null;
}

/**
 * DS3 pattern 3 — the chip's own four-value vocabulary (spec §2.2's
 * `AgentChip` entry: "working / reviewing / waiting / idle"), distinct from
 * the two booleans above (`live`/`gone`) that the pre-kit `TaskCard`/
 * `IdentityChip` still read: those stay as they are so that still-in-scope
 * old-kit surface does not regress, and `state` is additive.
 */
export type AgentState = 'working' | 'reviewing' | 'waiting' | 'idle';

export interface AgentChip {
  /** Friendly `role · tier` (Task 2: roleLabel()), or the label alone when the dispatch named no tier. */
  label: string;
  /** Raw `role · tier` — the taxonomy string, kept reachable as a title tooltip. */
  title: string;
  /** Somebody is on the task right now: IdentityChip's pulsing dot. */
  live: boolean;
  /** Nobody is on the task any more: the chip names who did the work, muted. */
  gone: boolean;
  /** DS3 pattern 3 — the new kit's `AgentChip` state. */
  state: AgentState;
}

/**
 * DS3 pattern 3 — `working`/`reviewing` split by whether the task's own
 * status already folds into the Kanban "Reviewing" column (`columnForStatus`,
 * same source the board itself uses, so the two never disagree); `waiting`
 * is `agentActivity: 'stalled'` (the kanban() query's own name for "the
 * clock says this agent should have returned"); `idle` is everything else
 * (settled task, or no live row at all).
 */
function agentState(task: AgentChipLike, settled: boolean): AgentState {
  if (settled || task.agentActivity === null) return 'idle';
  if (task.agentActivity === 'stalled') return 'waiting';
  return columnForStatus(task.taskStatus) === 'Reviewing' ? 'reviewing' : 'working';
}

/**
 * What the card's agent chip should do. Cross-provider UI check of
 * 2026-09-14, fix (n): the chip was built from the latest dispatch — who was
 * *sent* — and a completed task kept its last coder there, drawn exactly as
 * on a task being worked. `agentActivity` (kanban(), off the agents rows)
 * says whether anyone is still there; a settled task overrides it, because a
 * live row on a completed task is a registry gap, not work in progress.
 * `stalled` is still somebody — no terminal event, only the clock says it
 * should have returned — so the chip stays, without the pulse. Returns null
 * when the task was never dispatched.
 */
export function agentChip(task: AgentChipLike): AgentChip | null {
  if (!task.agentRole) return null;
  // Nobody can be working on a task that is over, whatever the agents
  // registry says: it is swept at epic close, so a live row can outlast the
  // task it was dispatched for (D-187). The task's own status is the stronger
  // claim, and which statuses those are is taxonomy.ts's answer, not a list
  // kept here — an unclassified status reads as still running, so the chip
  // stays rather than being muted on a guess.
  const settled = isTaskOver(task.taskStatus);
  return {
    label: task.agentModelTier
      ? `${roleLabel(task.agentRole)} · ${task.agentModelTier}`
      : roleLabel(task.agentRole),
    title: `${task.agentRole}${task.agentModelTier ? ` · ${task.agentModelTier}` : ''}`,
    live: task.agentActivity === 'working' && !settled,
    gone: task.agentActivity === null || settled,
    state: agentState(task, settled),
  };
}

/**
 * DS3 pattern 3 — whether a "waiting" chip should add the nudge suffix
 * ("— a nudge may help"), gated by `agentWaitingThresholdMs` (constants.ts):
 * the server's `stalled` flag names the state, this constant names how long
 * is long enough to suggest doing something about it.
 */
export function agentNudgeDue(updatedAt: string, nowIso?: string): boolean {
  const then = new Date(updatedAt).getTime();
  if (Number.isNaN(then)) return false;
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  return now - then >= agentWaitingThresholdMs;
}

/**
 * DS3 pattern 7 — group-by switch. `status` keeps `foldIntoColumns`'s own
 * fixed order and Completed-stays-last behavior; the other three fold into
 * ad-hoc buckets, alphabetical by label with the "None" bucket (a task
 * lacking the grouped property) always last, since there is no fixed order
 * to borrow for them the way there is for status.
 */
export type KanbanGroupBy = 'status' | 'project' | 'epic' | 'role';

export interface GroupableTask extends KanbanTaskLike {
  project: string | null;
  agentRole: string | null;
  epicLabel: string | null;
}

export interface KanbanGroupColumn<T> {
  /** Stable identity for persistence (hidden-columns list) and Vue `:key`. */
  key: string;
  /** What the column header shows. */
  label: string;
  tasks: T[];
}

const NONE_KEY = '\u0000none';
const NONE_LABEL = 'None';

/**
 * DS3 pattern 7 — a task's epic, read off its own id rather than a field the
 * Kanban payload does not carry: `taskId` is `<epic>/<slug>` (the same shape
 * `epicIdOfIntegrationRef` in queries.ts reads for the `<epic>/integration`
 * ref), so the prefix before the first `/` is the epic key. Returns null for
 * a task id with no `/` (no epic).
 */
export function epicKeyForTask(taskId: string): string | null {
  const idx = taskId.indexOf('/');
  return idx > 0 ? taskId.slice(0, idx) : null;
}

/**
 * ds-spec.md §2.2 KanbanBoard row — the column header's status icon tone.
 * Only the `status` grouping has a column key that is itself a real
 * task_status; the other groupings (project/epic/role) have no tone of
 * their own and fall back to `neutral` rather than inventing one.
 */
export function columnTone(groupBy: KanbanGroupBy, key: string): KitTone {
  return groupBy === 'status' ? taskStatusKitTone(key) : 'neutral';
}

// ds-spec.md §3.1 Work/Kanban row — the phone tab row "default[s] to the
// first non-empty column". Pure so the fallback logic is unit-tested here
// rather than only via a source-text scrape of KanbanBoard.vue's template.
export function defaultMobileColumnKey(
  columns: readonly { key: string; total: number }[],
): string | null {
  if (columns.length === 0) return null;
  return columns.find((c) => c.total > 0)?.key ?? columns[0]?.key ?? null;
}

export function groupByKanban<T extends GroupableTask>(
  tasks: readonly T[],
  groupBy: KanbanGroupBy,
  showAll = false,
): Array<KanbanGroupColumn<T>> {
  if (groupBy === 'status') {
    return foldIntoColumns(tasks, showAll).map((c) => ({
      key: c.name,
      label: c.name,
      tasks: c.tasks,
    }));
  }
  const buckets = new Map<string, { label: string; tasks: T[] }>();
  for (const task of tasks) {
    if (!showAll && HIDDEN_BY_DEFAULT.has(task.taskStatus)) continue;
    let key: string;
    let label: string;
    if (groupBy === 'project') {
      key = task.project ?? NONE_KEY;
      label = task.project ?? NONE_LABEL;
    } else if (groupBy === 'epic') {
      const epicKey = epicKeyForTask(task.taskId);
      key = epicKey ?? NONE_KEY;
      label = epicKey ? (task.epicLabel ?? epicKey) : NONE_LABEL;
    } else {
      key = task.agentRole ?? NONE_KEY;
      label = task.agentRole ? roleLabel(task.agentRole) : NONE_LABEL;
    }
    const bucket = buckets.get(key);
    if (bucket) bucket.tasks.push(task);
    else buckets.set(key, { label, tasks: [task] });
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === NONE_KEY) return 1;
      if (b === NONE_KEY) return -1;
      return a.localeCompare(b);
    })
    .map(([key, { label, tasks: bucketTasks }]) => ({ key, label, tasks: bucketTasks }));
}

export interface FollowupTaskLike extends KanbanTaskLike {
  parentTaskId: string | null;
  parentTitle: string | null;
  updatedAt: string;
}

/** What a column draws: a plain card, or one stacked card for a parent's follow-ups. */
export type ColumnItem<T extends FollowupTaskLike> =
  | { kind: 'task'; key: string; task: T }
  | { kind: 'group'; key: string; parentTaskId: string; parentTitle: string | null; members: T[] };

/** Fewer follow-ups than this stay plain cards: a "1 fix" stack only hides one row. */
export const FOLLOWUP_GROUP_MIN = 2;

/**
 * Stack a column's follow-ups by the task they came from. A parent with
 * FOLLOWUP_GROUP_MIN or more follow-ups in this column becomes one group
 * (members newest first), seated where its newest member sits; everything
 * else stays a card, in input order. `key` is `{column}:{parentTaskId}` for a
 * group — the stable id its expanded state is stored under — and the task id
 * for a card.
 */
export function groupFollowups<T extends FollowupTaskLike>(
  tasks: readonly T[],
  columnKey: string,
): Array<ColumnItem<T>> {
  const parentKey = (task: T, parent: string) => storeKey(task, parent);
  const byParent = new Map<string, T[]>();
  for (const task of tasks) {
    if (task.parentTaskId === null) continue;
    const k = parentKey(task, task.parentTaskId);
    const list = byParent.get(k) ?? [];
    list.push(task);
    byParent.set(k, list);
  }
  const groups = new Map<string, T[]>();
  for (const [parent, members] of byParent) {
    if (members.length < FOLLOWUP_GROUP_MIN) continue;
    groups.set(
      parent,
      [...members].sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
      ),
    );
  }
  const items: Array<ColumnItem<T>> = [];
  for (const task of tasks) {
    const members =
      task.parentTaskId === null ? undefined : groups.get(parentKey(task, task.parentTaskId));
    if (task.parentTaskId === null || members === undefined) {
      items.push({ kind: 'task', key: storeKey(task, task.taskId), task });
    } else if (members[0] === task) {
      items.push({
        kind: 'group',
        key: `${columnKey}:${parentKey(task, task.parentTaskId)}`,
        parentTaskId: task.parentTaskId,
        parentTitle: task.parentTitle,
        members,
      });
    }
  }
  return items;
}

/**
 * The follow-up group that holds `taskId`, with the member's position in the
 * group (newest first), or null for a plain card or an unknown id. The board
 * opens that group, and the group its hidden rows, when a peek targets a fix.
 */
export function findGroupMember<T extends FollowupTaskLike>(
  items: ReadonlyArray<ColumnItem<T>>,
  taskId: string | null,
  storeId?: string,
): { key: string; index: number } | null {
  if (taskId === null) return null;
  for (const item of items) {
    if (item.kind !== 'group') continue;
    const index = item.members.findIndex(
      (m) => m.taskId === taskId && foreignStoreId(m) === storeId,
    );
    if (index !== -1) return { key: item.key, index };
  }
  return null;
}

export interface KanbanCardChip {
  text: string;
  /** `null` is a descriptive (non-evaluative) pill: no status colour, per design-spec.md §3's rule. */
  tone: KitTone | null;
}

export interface CardChipTask {
  taskStatus: string;
  project: string | null;
  tags: { case: string | null; severity: string | null };
}

const SEVERITY_KIT_TONE: Record<string, KitTone> = {
  'S1-stop-the-line': 'danger',
  'S2-major': 'danger',
  'S3-minor': 'warning',
};

/**
 * DS3 pattern 6, row 4 — "chips shown only when they add information beyond
 * what the column/grouping already states" (ds-spec.md §4.2). Status is
 * suppressed when the board is already grouped by status (the column name
 * says it); project is suppressed when grouped by project; `S4-nit` is the
 * severity default and is never shown. Capped at 2, with the rest folded
 * into `overflow` for a trailing "+N".
 */
export function cardChips(
  task: CardChipTask,
  groupBy: KanbanGroupBy,
): { chips: KanbanCardChip[]; overflow: number } {
  const candidates: KanbanCardChip[] = [];
  if (groupBy !== 'status') {
    candidates.push({ text: titleCase(task.taskStatus), tone: taskStatusKitTone(task.taskStatus) });
  }
  if (task.tags.case) candidates.push({ text: titleCase(task.tags.case), tone: null });
  if (task.tags.severity && task.tags.severity !== 'S4-nit') {
    candidates.push({
      text: task.tags.severity,
      tone: SEVERITY_KIT_TONE[task.tags.severity] ?? 'warning',
    });
  }
  if (groupBy !== 'project' && task.project) {
    candidates.push({ text: task.project, tone: null });
  }
  return { chips: candidates.slice(0, 2), overflow: Math.max(0, candidates.length - 2) };
}

/** The bits of a KanbanDependency that dependencyChainText() actually reads. */
export interface DependencyLike {
  taskId: string;
  title: string | null;
  status: string | null;
}

/**
 * TaskCard's footer dependency line (DS3 pattern 6, §4.2's "dependency
 * chain in words"). Only the first dependency is named, with a "+N more"
 * tail for the rest — the footer is a one-line summary, not a full list.
 *
 * Audit finding 6: a dependency whose status already reads "done" (the
 * taxonomy's completed/waived tone, per isDoneStatus()) is nothing the task
 * is still waiting on, so it is filtered out before picking which one to
 * name and before counting the "+N more" tail. "Waits for: nothing" now
 * also covers the case where every dependency is already done.
 *
 * Operator fix 2026-10-05: the server sets `title` to the dependency task's
 * full `objective` (db/queries.ts ~:3096), which can run to a multi-sentence
 * paragraph. taskLabel() shortens it the same way the card's own title is
 * shortened, rather than this footer line printing that paragraph whole.
 */
function waitingDependencies(dependencies: DependencyLike[]): DependencyLike[] {
  return dependencies.filter((d) => !d.status || !isDoneStatus(d.status));
}

/**
 * Whether any dependency is still open (or has no status yet). The card
 * footer drops its "Waits for" line when this is false: with nothing to
 * wait on there is nothing to say (operator fix 2026-10-05).
 */
export function hasWaitingDependency(dependencies: DependencyLike[]): boolean {
  return waitingDependencies(dependencies).length > 0;
}

export function dependencyChainText(dependencies: DependencyLike[]): string {
  const waiting = waitingDependencies(dependencies);
  const first = waiting[0];
  if (!first) return 'Waits for: nothing';
  const label = taskLabel(first.taskId, first.title ?? undefined);
  // Plain words, not the raw task_status slug: "in-progress" -> "in progress".
  const status = first.status ? ` (${first.status.replace(/[-_]/g, ' ')})` : '';
  const rest = waiting.length - 1;
  const extra = rest > 0 ? ` +${rest} more` : '';
  return `Waits for: ${label}${status}${extra}`;
}

/**
 * Whether a task_status reads as "done" (the kit Tag's `done` tone:
 * completed/waived). KanbanBoard uses this to collapse finished tasks
 * behind a "show" toggle inside every column, regardless of which grouping
 * is active — §4.2's "Completed stays collapsed by default" generalised
 * past the status grouping's literal "Completed" column name.
 */
export function isDoneStatus(status: string): boolean {
  return taskStatusKitTone(status) === 'done';
}

/** The bits of a KanbanTask attemptLabel() actually reads. */
export interface AttemptLabelTask {
  attemptCount: number;
}

/**
 * S3 review fix — TaskCard's row 5 used to render
 * `Attempt {{ task.judgeRound ?? task.attemptCount }}`, conflating two
 * distinct counters (api.ts: attemptCount is the dispatch_decision count,
 * judgeRound is the highest judge round). ds-spec.md §4.2's own worked
 * example ("Attempt 2") reads as the dispatch attempt count, so the card
 * shows only that — null on a task's first attempt, matching row 5's
 * fallback to the "updated X ago" relative time instead.
 */
export function attemptLabel(task: AttemptLabelTask): string | null {
  return task.attemptCount > 1 ? `Attempt ${task.attemptCount}` : null;
}

/**
 * Longest prefix of `full` that still fits once "…" is appended, or null when
 * the whole title fits. `fits(text)` renders `text` and reports whether it fits
 * the allowed lines; it is called O(log n) times. A cut prefers the last space
 * within `wordCutSlack` characters of the longest fit, so words stay whole.
 */
export function fitTitleText(
  full: string,
  fits: (text: string) => boolean,
  wordCutSlack: number,
): string | null {
  if (fits(full)) return null;
  const cut = (n: number) => `${full.slice(0, n).trimEnd()}…`;
  let lo = 0;
  let hi = full.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(cut(mid))) lo = mid;
    else hi = mid - 1;
  }
  const space = full.lastIndexOf(' ', lo);
  return cut(space > 0 && lo - space <= wordCutSlack ? space : lo);
}
