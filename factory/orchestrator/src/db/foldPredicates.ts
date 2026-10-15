import type { EventRecord } from '../events.js';
import { FINDING_OBLIGATION_REPAIRED_EVENT_TYPE } from '../findings.js';
import { PLAN_AMENDED_EVENT } from '../spec.js';

// Which event records each global fold reads. Pure: a predicate looks at the
// record it is given and nothing else. A predicate errs towards running its
// fold, so a record whose shape is in doubt is accepted. The lists below are
// kept honest by the source guard in test/db/foldPredicates.test.ts, which
// derives each fold's compared event types from the fold's code.

// foldTasks' switch, plus the plan amendments its successor lookup reads.
const TASK_TYPES: ReadonlySet<string> = new Set([
  'task-added',
  'wave-admitted',
  'wave-merged',
  'dispatch_decision',
  'task-result-recorded',
  'judge-reported',
  'gate-outcome',
  'error-logged',
  'task-superseded',
  'task-reinstated',
  PLAN_AMENDED_EVENT,
]);

const FINDING_TYPES: ReadonlySet<string> = new Set([
  'finding-raised',
  'finding-transitioned',
  FINDING_OBLIGATION_REPAIRED_EVENT_TYPE,
]);

const LESSON_TYPES: ReadonlySet<string> = new Set([
  'lesson-candidate-raised',
  'lesson-status-changed',
  'lesson-edited',
  'severity-decisions',
]);

const FEEDBACK_TYPES: ReadonlySet<string> = new Set([
  'operator-feedback-recorded',
  'operator-feedback-resolved',
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const present = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  value !== '' &&
  !(Array.isArray(value) && value.length === 0);

/** An unparseable payload, or any field that names a task or an epic. */
function namesTaskOrEpic(record: EventRecord): boolean {
  if (present(record.task_id)) return true;
  const payload: unknown = record.payload;
  if (!isObject(payload)) return true;
  return present(payload.task_id) || present(payload.task_ids) || present(payload.epic_id);
}

/** Does `projectTasks` need to fold this record? */
export function tasksFoldReads(record: EventRecord): boolean {
  return TASK_TYPES.has(record.event_type) || namesTaskOrEpic(record);
}

/** A finding's project comes from the task rows, so this takes the tasks fold's records too. */
export function findingsFoldReads(record: EventRecord): boolean {
  return FINDING_TYPES.has(record.event_type) || tasksFoldReads(record);
}

/** Does `projectLessons` need to fold this record? */
export function lessonsFoldReads(record: EventRecord): boolean {
  return LESSON_TYPES.has(record.event_type) || !isObject(record.payload);
}

/** Does `projectOperatorFeedback` need to fold this record? */
export function feedbackFoldReads(record: EventRecord): boolean {
  return FEEDBACK_TYPES.has(record.event_type) || !isObject(record.payload);
}
