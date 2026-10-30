// Recurrence of error classes (bs-optimize epic D2): an `error-logged` event
// and a blocked gate `gate-outcome` both count. Pure over the events and `now`
// it is handed: the one store read is lessonEvents.ts.

import type { GateBlockedReason } from './errorIssues.js';
import { type EventRecord, eventTaskId, type StoredEvent } from './events.js';
import { epicOfTaskId } from './taskId.js';

/** Distinct tasks a class must be logged on, store-wide, to count as recurring. */
export const RECUR_MIN_TASKS = 3;
/** How far back an event of a class still counts, in days. */
export const RECUR_WINDOW_DAYS = 30;
/** Counted events of a class in the dispatch's own epic that make it a repeat. */
export const EPIC_REPEAT_MIN = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Distinct tasks one class counted on, store-wide and per epic. */
export interface ClassCount {
  tasks: number;
  epics: ReadonlyMap<string, number>;
}

export interface RecurrenceWindow {
  now: Date;
  windowDays: number;
}

/**
 * The lesson error class a blocked gate counts under, by its `reason`. A
 * `Record` over every reason, so a new gate reason fails to compile until it
 * is mapped. null counts toward no class: the wave-runner's own sequencing
 * (`judges-outstanding`, `uiux-spec-missing`, `uiux-visual-missing`,
 * `screenshots-stale`), a rubric verdict whose failed criteria can be of any
 * class (`grader-fail`), a reporter or include-glob gap (`coverage-evidence`),
 * and `findings`, each of which carries its own category.
 */
export const GATE_BLOCK_ERROR_CLASSES: Readonly<Record<GateBlockedReason, string | null>> = {
  'schema-invalid': 'contract.schema-violation',
  'artifacts-missing': 'contract.schema-violation',
  'screenshots-missing': 'contract.schema-violation',
  'grader-invalid': 'contract.schema-violation',
  'not-committed': 'contract.uncommitted-work',
  'deps-missing': 'execution.env-failure',
  'tests-failed': 'execution.test-failure',
  'judges-outstanding': null,
  'uiux-spec-missing': null,
  'uiux-visual-missing': null,
  'screenshots-stale': null,
  'grader-fail': null,
  'coverage-evidence': null,
  findings: null,
};

/** Whether an event can count: an `error-logged`, or a blocked `gate-outcome`. */
export function isRecurrenceEvent(record: EventRecord): boolean {
  if (record.event_type === 'error-logged') return true;
  return (
    record.event_type === 'gate-outcome' &&
    (record.payload as Record<string, unknown>).outcome === 'blocked'
  );
}

/**
 * The one rule for which events count and under what class. An `error-logged`
 * event counts under `payload.error`. A `gate-outcome` whose `payload.outcome`
 * is `blocked` counts under `payload.error_class` when that is a non-empty
 * string (a slept run's stamp wins), else under its reason's class in
 * `GATE_BLOCK_ERROR_CLASSES`; a reason the map lacks or maps to null counts
 * nowhere. Every other event counts nowhere. Window and task are the caller's.
 */
export function recurrenceClassOf(record: EventRecord): string | null {
  if (!isRecurrenceEvent(record)) return null;
  const payload = record.payload as Record<string, unknown>;
  if (record.event_type === 'error-logged') {
    return typeof payload.error === 'string' && payload.error.length > 0 ? payload.error : null;
  }
  if (typeof payload.error_class === 'string' && payload.error_class.length > 0) {
    return payload.error_class;
  }
  const reason = payload.reason;
  if (typeof reason !== 'string' || !Object.hasOwn(GATE_BLOCK_ERROR_CLASSES, reason)) return null;
  return GATE_BLOCK_ERROR_CLASSES[reason as GateBlockedReason];
}

/**
 * The task a counted event is about: the envelope or payload
 * `task_id`, else the error payload's own `task_ref` (the rule
 * agents-registry.ts's fold uses), or null when it names none.
 */
function taskOf(record: EventRecord): string | null {
  const ref = (record.payload as Record<string, unknown>).task_ref;
  return eventTaskId(record) ?? (typeof ref === 'string' && ref.length > 0 ? ref : null);
}

/**
 * Serves epic criterion 3: folds the events `recurrenceClassOf` counts, inside
 * the window, into per-class counts of distinct tasks. An event with no task identity counts
 * toward nothing; one with a task but no epic counts store-wide only; the
 * epic is `payload.epic_id`, else the epic of the task id.
 */
export function errorClassCounts(
  events: readonly StoredEvent[],
  { now, windowDays }: RecurrenceWindow,
): Map<string, ClassCount> {
  const cutoff = now.getTime() - windowDays * DAY_MS;
  const tasksByClass = new Map<string, Set<string>>();
  const tasksByClassEpic = new Map<string, Map<string, Set<string>>>();
  for (const { record } of events) {
    const cls = recurrenceClassOf(record);
    if (cls === null) continue;
    const ts = Date.parse(record.ts);
    if (!(ts >= cutoff)) continue;
    const payload = record.payload as Record<string, unknown>;
    const task = taskOf(record);
    if (task === null) continue;
    const addTo = (tasks: Set<string> | undefined) => (tasks ?? new Set<string>()).add(task);
    tasksByClass.set(cls, addTo(tasksByClass.get(cls)));
    const epic =
      typeof payload.epic_id === 'string' && payload.epic_id.length > 0
        ? payload.epic_id
        : epicOfTaskId(task);
    if (epic === null) continue;
    const epics = tasksByClassEpic.get(cls) ?? new Map<string, Set<string>>();
    epics.set(epic, addTo(epics.get(epic)));
    tasksByClassEpic.set(cls, epics);
  }
  const counts = new Map<string, ClassCount>();
  for (const [cls, tasks] of tasksByClass) {
    const epics = new Map<string, number>();
    for (const [epic, epicTasks] of tasksByClassEpic.get(cls) ?? [])
      epics.set(epic, epicTasks.size);
    counts.set(cls, { tasks: tasks.size, epics });
  }
  return counts;
}
