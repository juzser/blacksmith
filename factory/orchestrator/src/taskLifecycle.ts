import type { StoredEvent } from './events.js';
import { taskIdsMatch } from './taskId.js';

// Pure, and importing no db module, spec.ts or taskEvents.ts: the projector,
// ingest and `reinstateTask` all fold the same log through these rules, and
// each can import this module statically.

/** Same value as spec.ts's PLAN_AMENDED_EVENT, which this module cannot import. */
const PLAN_VERSION_CREATED = 'plan-version-created';

/** Does `record` name `taskId`, by its envelope id or its payload `task_ids`? */
export function namesTask(record: StoredEvent['record'], taskId: string): boolean {
  if (record.task_id && taskIdsMatch(record.task_id, taskId)) return true;
  const ids = (record.payload as { task_ids?: unknown } | undefined)?.task_ids;
  return Array.isArray(ids) && ids.some((id) => typeof id === 'string' && taskIdsMatch(id, taskId));
}

/** The one-hop old id -> replacement map; see spec.ts's `taskSuccessors` for the rules. */
export function taskSuccessorsOf(
  events: readonly StoredEvent[],
  epicId: string,
): Map<string, string> {
  const successors = new Map<string, string>();
  for (const event of events) {
    if (event.record.event_type !== PLAN_VERSION_CREATED) continue;
    const payload = event.record.payload as Record<string, unknown>;
    if (payload.epic_id !== epicId) continue;
    const entries = payload.successors;
    if (entries !== undefined) {
      if (entries === null || typeof entries !== 'object') continue;
      for (const [oldId, newId] of Object.entries(entries as Record<string, unknown>)) {
        if (typeof newId === 'string') successors.set(oldId, newId);
      }
      continue;
    }
    // Legacy fallback (no `successors` key at all) — see doc comment above.
    const diff = payload.diff;
    if (diff === null || typeof diff !== 'object') continue;
    const supersededIds = (diff as Record<string, unknown>).superseded;
    const addedIds = (diff as Record<string, unknown>).added;
    if (!Array.isArray(supersededIds) || !Array.isArray(addedIds)) continue;
    if (supersededIds.length !== 1 || addedIds.length !== 1) continue;
    const [oldId] = supersededIds;
    const [newId] = addedIds;
    if (typeof oldId === 'string' && typeof newId === 'string' && oldId !== newId) {
      successors.set(oldId, newId);
    }
  }
  return successors;
}

/**
 * Why a reinstatement of `taskId` cannot stand on this log, or null when
 * nothing blocks it. Order is the one `reinstateTask` refuses in: a task with
 * no `wave-merged` never finished; a task a plan amendment maps to a
 * successor was really superseded.
 */
export function reinstatementBlocker(
  events: readonly StoredEvent[],
  taskId: string,
  epicId: string,
): { code: 'never-merged' } | { code: 'has-successor'; successor: string } | null {
  const merged = events.some(
    (e) => e.record.event_type === 'wave-merged' && namesTask(e.record, taskId),
  );
  if (!merged) return { code: 'never-merged' };
  for (const [from, to] of taskSuccessorsOf(events, epicId)) {
    if (taskIdsMatch(from, taskId)) return { code: 'has-successor', successor: to };
  }
  return null;
}

/**
 * The ids whose `task-reinstated` the log honours: a `task-reinstated` that
 * follows a `task-superseded` for the id (one that follows none corrects
 * nothing), with no later supersede, a `wave-merged` naming the id, and no
 * successor for it. The projector, ingest and `reinstateTask` all decide
 * through this and `reinstatementBlocker`, so they cannot disagree.
 */
export function honouredReinstatements(
  events: readonly StoredEvent[],
  epicId: string,
): Set<string> {
  const dead = new Set<string>();
  const reinstated = new Set<string>();
  for (const { record } of events) {
    if (!record.task_id) continue;
    if (record.event_type === 'task-superseded') {
      dead.add(record.task_id);
      reinstated.delete(record.task_id);
    } else if (record.event_type === 'task-reinstated' && dead.delete(record.task_id)) {
      reinstated.add(record.task_id);
    }
  }
  for (const id of [...reinstated]) {
    if (reinstatementBlocker(events, id, epicId) !== null) reinstated.delete(id);
  }
  return reinstated;
}

/**
 * The ids the log reports finished: a `wave-merged` names the id and no
 * `task-superseded` for it follows its last merge, unless the log honours a
 * reinstatement of it (`honouredReinstatements`). Equals "the projector folds
 * the task to `completed`". Ids come back as the log spells them.
 */
export function finishedInLog(events: readonly StoredEvent[], epicId: string): Set<string> {
  const merged = new Set<string>();
  for (const { record } of events) {
    if (record.event_type !== 'wave-merged') continue;
    if (record.task_id) merged.add(record.task_id);
    const ids = (record.payload as { task_ids?: unknown } | undefined)?.task_ids;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') merged.add(id);
  }
  const honoured = [...honouredReinstatements(events, epicId)];
  const finished = new Set<string>();
  for (const id of merged) {
    let supersededSinceMerge = false;
    for (const { record } of events) {
      if (record.event_type === 'wave-merged' && namesTask(record, id)) {
        supersededSinceMerge = false;
      } else if (
        record.event_type === 'task-superseded' &&
        record.task_id &&
        taskIdsMatch(record.task_id, id)
      ) {
        supersededSinceMerge = true;
      }
    }
    if (!supersededSinceMerge || honoured.some((h) => taskIdsMatch(h, id))) finished.add(id);
  }
  return finished;
}
