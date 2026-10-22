/**
 * Which tasks are admitted and unfinished, read from the event log.
 *
 * `plan ingest` rewrites the plan file, and a task already running reads
 * `todo` again afterwards, so a `wave next` computed from the plan alone would
 * offer it a second time. The log still knows: it holds the admission and no
 * ending. This module is that fold, so `computeNextWave` can keep an in-flight
 * task occupied whatever the plan file says (bs-optimize epic criterion 9).
 */
import { SmithError } from './errors.js';
import { eventTaskId, type StoredEvent } from './events.js';
import { epicOfTaskId, taskIdsMatch } from './taskId.js';
import { namesTask } from './taskLifecycle.js';

export class InFlightError extends SmithError {}

/** The epic and the plan version the fold is asked about. */
export interface AdmissionScope {
  epicId: string;
  planVersion: number;
}

/**
 * The task ids of `scope.epicId` that the log admitted and has not ended.
 * Admitted: named by a `wave-admitted`, or by a coder `dispatch_decision`.
 * Ended: a later `wave-merged` or `task-superseded` naming the task, or an
 * `epic-closed` for the epic. A bounce, a re-dispatch and a failed agent run
 * end nothing, so the task stays in flight through them. Events from a plan
 * version newer than `scope.planVersion` are not read. Ids come back as the
 * log spells them. Serves epic criterion 9 (bs-optimize).
 */
export function inFlightTasks(events: readonly StoredEvent[], scope: AdmissionScope): Set<string> {
  const inFlight = new Set<string>();
  const admit = (id: string): void => {
    for (const held of inFlight) if (taskIdsMatch(held, id)) return;
    inFlight.add(id);
  };
  const release = (record: StoredEvent['record']): void => {
    for (const held of [...inFlight]) if (namesTask(record, held)) inFlight.delete(held);
  };
  const inEpic = (id: string, payloadEpic: unknown): boolean =>
    (typeof payloadEpic === 'string' ? payloadEpic : epicOfTaskId(id)) === scope.epicId;

  for (const { record } of events) {
    if (record.plan_version > scope.planVersion) continue;
    const payload = record.payload as Record<string, unknown>;
    switch (record.event_type) {
      case 'wave-admitted': {
        const ids = Array.isArray(payload.task_ids) ? payload.task_ids : [];
        for (const id of ids) {
          if (typeof id === 'string' && inEpic(id, payload.epic_id)) admit(id);
        }
        break;
      }
      case 'dispatch_decision': {
        const id = eventTaskId(record);
        if (payload.agent_role === 'coder' && id && inEpic(id, payload.epic_id)) admit(id);
        break;
      }
      case 'wave-merged':
      case 'task-superseded':
        release(record);
        break;
      case 'epic-closed':
        if (payload.epic_id === scope.epicId) inFlight.clear();
        break;
    }
  }
  return inFlight;
}

/**
 * Refuse a task the log says is already running, so `wave check` cannot admit
 * it twice. Raises `wave.in-flight` naming the task (bs-optimize epic
 * criterion 9).
 */
export function assertNotInFlight(taskId: string, inFlight: ReadonlySet<string>): void {
  for (const held of inFlight) {
    if (taskIdsMatch(held, taskId)) {
      throw new InFlightError(
        'wave.in-flight',
        `wave.in-flight: "${taskId}" is admitted and not finished; it cannot join another wave.`,
        { taskId },
      );
    }
  }
}
