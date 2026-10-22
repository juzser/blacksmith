// Recurrence of logged error classes (bs-optimize epic D2). Pure over the
// events and `now` it is handed: the one store read is lessonEvents.ts.
import { type EventRecord, eventTaskId, type StoredEvent } from './events.js';
import { epicOfTaskId } from './taskId.js';

/** Distinct tasks a class must be logged on, store-wide, to count as recurring. */
export const RECUR_MIN_TASKS = 3;
/** How far back an `error-logged` event still counts, in days. */
export const RECUR_WINDOW_DAYS = 30;
/** `error-logged` events of a class in the dispatch's own epic that make it a repeat. */
export const EPIC_REPEAT_MIN = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Distinct tasks one class was logged on, store-wide and per epic. */
export interface ClassCount {
  tasks: number;
  epics: ReadonlyMap<string, number>;
}

export interface RecurrenceWindow {
  now: Date;
  windowDays: number;
}

/**
 * The task an `error-logged` event is about: the envelope or payload
 * `task_id`, else the error payload's own `task_ref` (the rule
 * agents-registry.ts's fold uses), or null when it names none.
 */
function taskOf(record: EventRecord): string | null {
  const ref = (record.payload as Record<string, unknown>).task_ref;
  return eventTaskId(record) ?? (typeof ref === 'string' && ref.length > 0 ? ref : null);
}

/**
 * Serves epic criterion 3: folds `error-logged` events inside the window into
 * per-class counts of distinct tasks. An event with no task identity counts
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
    if (record.event_type !== 'error-logged') continue;
    const ts = Date.parse(record.ts);
    if (!(ts >= cutoff)) continue;
    const payload = record.payload as Record<string, unknown>;
    const cls = payload.error;
    const task = taskOf(record);
    if (typeof cls !== 'string' || cls.length === 0 || task === null) continue;
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
