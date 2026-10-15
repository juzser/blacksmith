import { SmithError } from './errors.js';
import { appendEvent, type EventOpts, readLineageEvents, type StoredEvent } from './events.js';
import type { EventContext } from './findings.js';
import { epicOfTaskId, taskIdsMatch } from './taskId.js';
import { namesTask, reinstatementBlocker } from './taskLifecycle.js';

/**
 * The corrective event `reinstateTask` appends. Not a taxonomy value: it is a
 * repair of the log's own record, like `finding-obligation-repaired`, and the
 * projector (db/projector.ts foldTasks) is what gives it meaning.
 */
export const TASK_REINSTATED_EVENT_TYPE = 'task-reinstated';

export class ReinstateError extends SmithError {}

export interface ReinstateInput {
  reason: string;
}

/**
 * Put a finished task back to `completed` when the log says it was superseded
 * and no plan ever replaced it: the shape an amendment that did not name the
 * task used to leave behind (it dropped the finished record and kept the dead
 * copies, and ingest then wrote `task-superseded` for the id).
 *
 * Appends one `task-reinstated` event naming both events it corrects, so the
 * repair is auditable and the status is derived from the log on any replay.
 * Refuses unless every one of these holds:
 *   - a non-empty reason (an unaudited repair is not a repair);
 *   - the task has a row in this lineage;
 *   - the row is superseded now;
 *   - a `wave-merged` for it is on the log (it never finished otherwise);
 *   - no `plan-version-created` maps it to a successor (a plan really did
 *     supersede it, and the verdict must wait on that successor).
 */
export async function reinstateTask(
  typed: string,
  input: ReinstateInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<StoredEvent> {
  const reason = input.reason.trim();
  if (reason === '') {
    throw new ReinstateError(
      'task.reinstate-reason-required',
      `Reinstating "${typed}" needs a non-empty --reason: an unaudited repair is not a repair.`,
      { taskId: typed },
    );
  }

  // Dynamic: the db layer must stay out of the CLI's static import graph.
  const { foldTasks } = await import('./db/projector.js');
  const events = await readLineageEvents(ctx.sessionId, opts);
  const row = foldTasks(events).find((r) => taskIdsMatch(r.taskId, typed));
  if (!row) {
    throw new ReinstateError(
      'task.reinstate-unknown-task',
      `No task "${typed}" in this session's log.`,
      { taskId: typed },
    );
  }
  const taskId = row.taskId;
  if (row.taskStatus !== 'superseded') {
    throw new ReinstateError(
      'task.reinstate-not-superseded',
      `Task "${taskId}" is "${row.taskStatus}", not "superseded" -- there is nothing to reinstate.`,
      { taskId, taskStatus: row.taskStatus },
    );
  }

  const epicId = row.epicId ?? epicOfTaskId(taskId) ?? '';
  const blocker = reinstatementBlocker(events, taskId, epicId);
  if (blocker?.code === 'never-merged') {
    throw new ReinstateError(
      'task.reinstate-never-merged',
      `Task "${taskId}" has no wave-merged event in the log: it never finished, so it cannot be put back to completed.`,
      { taskId },
    );
  }
  if (blocker?.code === 'has-successor') {
    throw new ReinstateError(
      'task.reinstate-has-successor',
      `Task "${taskId}" was superseded by "${blocker.successor}" in a plan amendment. That supersede is real: the epic verdict waits on "${blocker.successor}" instead.`,
      { taskId, successor: blocker.successor },
    );
  }

  const merged = events.filter(
    (e) => e.record.event_type === 'wave-merged' && namesTask(e.record, taskId),
  );

  const superseded = events.filter(
    (e) => e.record.event_type === 'task-superseded' && namesTask(e.record, taskId),
  );
  const lastMerged = merged[merged.length - 1] as StoredEvent;
  const lastSuperseded = superseded[superseded.length - 1];

  return appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'user',
      event_type: TASK_REINSTATED_EVENT_TYPE,
      task_id: taskId,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        epic_id: epicId,
        reason,
        merged_event_id: lastMerged.event_id,
        superseded_event_id: lastSuperseded?.event_id ?? null,
      },
    },
    opts,
  );
}
