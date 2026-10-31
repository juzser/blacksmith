import { foldTasks } from './db/projector.js';
import { SmithError } from './errors.js';
import { appendWithin, type EventOpts, readLineageEvents, type StoredEvent } from './events.js';
import type { EventContext } from './findings.js';
import { epicOfTaskId, qualifyTaskId, taskIdsMatch } from './taskId.js';
import { namesTask } from './taskLifecycle.js';

/** The one event type `recordWaveReverted` writes; it is the only writer. */
export const WAVE_REVERTED_EVENT = 'wave-reverted';

/**
 * Why a revert can stand on the integration branch without reopening its
 * task. The one list: the post-merge resume writes `record-only` with one of
 * these, and `recordWaveReverted` refuses anything else.
 */
export const RECORD_ONLY_REASONS = [
  'superseded',
  'waived',
  'held-by-operator',
  're-merged',
  'not-merged',
  'not-in-live-plan',
  'unknown-task',
  'invalid-trailers',
] as const;

export type RecordOnlyReason = (typeof RECORD_ONLY_REASONS)[number];

export class WaveRevertedError extends SmithError {}

export interface WaveRevertBlockerInput {
  revertSha: string;
  /** Whether `a` is an ancestor of `b` in git; injected so the decision stays pure. */
  isAncestor: (a: string, b: string) => boolean;
  /**
   * The ids of the live plan's records whose `task_status` is not
   * `superseded`, read from the plan file `bs wave next` reads.
   */
  liveTaskIds: readonly string[];
}

const HEX40 = /^[0-9a-f]{40}$/i;

/**
 * Whether a `wave-merged` for `taskId` was written for `epicId`. A bare id
 * matches across epics, so the epic comes from the payload's `epic_id` when
 * it has one, else from a qualified id the event names; an event that names
 * no epic anywhere counts, since an old log's bare id has nothing to compare.
 */
function mergedUnderEpic(record: StoredEvent['record'], taskId: string, epicId: string): boolean {
  const payload = record.payload as { epic_id?: unknown; task_ids?: unknown };
  if (typeof payload.epic_id === 'string') return payload.epic_id === epicId;
  const named = [record.task_id, ...(Array.isArray(payload.task_ids) ? payload.task_ids : [])]
    .filter((id): id is string => typeof id === 'string' && taskIdsMatch(id, taskId))
    .map(epicOfTaskId)
    .filter((epic): epic is string => epic !== null);
  return named.length === 0 || named.includes(epicId);
}

/**
 * The first reason a revert of `taskId`'s merge cannot reopen it, or null.
 * `taskId` is read as a task of `epicId`: a `wave-merged` written for another
 * epic's task of the same bare name does not count.
 *
 * Re-merged is decided by `merge_sha` ancestry, never by event order: a
 * `wave-merged` counts only when its merge commit descends from the revert,
 * and one without a 40-hex `merge_sha` (written before the field existed, or
 * malformed) cannot.
 *
 * `waived` and `held-by-operator` follow the fold's status, and the fold
 * (db/projector.ts `foldTasks`) never moves a task off `completed` once a
 * `wave-merged` names it, so on a real log only `not-merged`, `superseded`,
 * `re-merged` and `not-in-live-plan` are reachable today. The two are kept
 * because the decision belongs to the fold; making them fire needs a
 * projector change, not a second status scan here.
 */
export function waveRevertBlocker(
  events: readonly StoredEvent[],
  taskId: string,
  epicId: string,
  input: WaveRevertBlockerInput,
): RecordOnlyReason | null {
  const own = epicOfTaskId(taskId);
  if (own !== null && own !== epicId) return 'not-merged';
  const qualified = qualifyTaskId(epicId, taskId);
  const merges = events.filter(
    (e) =>
      e.record.event_type === 'wave-merged' &&
      namesTask(e.record, qualified) &&
      mergedUnderEpic(e.record, qualified, epicId),
  );
  if (merges.length === 0) return 'not-merged';
  const status = foldTasks(events).find((row) => taskIdsMatch(row.taskId, qualified))?.taskStatus;
  if (status === 'superseded') return 'superseded';
  if (status === 'waived') return 'waived';
  if (status === 'failed' || status === 'escalated') return 'held-by-operator';
  const reMerged = merges.some((e) => {
    const sha = (e.record.payload as { merge_sha?: unknown }).merge_sha;
    return typeof sha === 'string' && HEX40.test(sha) && input.isAncestor(input.revertSha, sha);
  });
  if (reMerged) return 're-merged';
  if (!input.liveTaskIds.some((id) => taskIdsMatch(id, qualified))) return 'not-in-live-plan';
  return null;
}

interface WaveRevertedCommon {
  epic_id: string;
  integration_branch: string;
  revert_sha: string;
  disposition: 'bounce' | 'record-only';
  task_ids: string[];
  reverted_merge_sha: string | null;
  failing_checks: string[];
  evidence_event_ids: string[];
  log_tail: string;
}

export interface WaveRevertedBounce extends WaveRevertedCommon {
  disposition: 'bounce';
  red_record_event_id: string;
  evidence: 'record' | 'trailers-only';
  resumed: boolean;
}

export interface WaveRevertedRecordOnly extends WaveRevertedCommon {
  disposition: 'record-only';
  reason: RecordOnlyReason;
  evidence: 'record' | 'trailers-only' | 'unreadable';
}

export type WaveRevertedInput = WaveRevertedBounce | WaveRevertedRecordOnly;

export interface RecordWaveRevertedOpts extends EventOpts {
  /** Required for `bounce`: the preflight's git ancestry test. */
  isAncestor?: WaveRevertBlockerInput['isAncestor'];
  /** Required for `bounce`: the live plan's non-superseded ids. */
  liveTaskIds?: readonly string[];
}

/**
 * Append the one `wave-reverted` event for a revert, after validating all of
 * it. A `record-only` call with a listed reason and a fresh `revert_sha` is
 * always accepted, so a resume can always end; a `bounce` also needs the
 * culprit to pass `waveRevertBlocker`.
 */
export async function recordWaveReverted(
  input: WaveRevertedInput,
  ctx: EventContext,
  opts: RecordWaveRevertedOpts = {},
): Promise<StoredEvent> {
  const { isAncestor, liveTaskIds, ...eventOpts } = opts;
  if (typeof input.revert_sha !== 'string' || !HEX40.test(input.revert_sha)) {
    throw new WaveRevertedError(
      'revert.invalid-sha',
      `revert_sha must be a full 40-hex commit id, got "${input.revert_sha}".`,
    );
  }
  if (typeof input.integration_branch !== 'string' || input.integration_branch === '') {
    throw new WaveRevertedError(
      'revert.integration-branch-required',
      'integration_branch is required.',
    );
  }
  if (input.disposition !== 'bounce' && input.disposition !== 'record-only') {
    throw new WaveRevertedError(
      'revert.invalid-disposition',
      `disposition must be "bounce" or "record-only", got "${String((input as { disposition?: unknown }).disposition)}".`,
    );
  }

  const events = await readLineageEvents(ctx.sessionId, eventOpts);
  const revertSha = input.revert_sha.toLowerCase();
  const refuseIfRecorded = (log: readonly StoredEvent[]): void => {
    const prior = log.find(
      (e) =>
        e.record.event_type === WAVE_REVERTED_EVENT &&
        String((e.record.payload as { revert_sha?: unknown }).revert_sha).toLowerCase() ===
          revertSha,
    );
    if (prior !== undefined) {
      throw new WaveRevertedError(
        'revert.already-recorded',
        `Revert ${input.revert_sha} already has a wave-reverted event (${prior.event_id}).`,
        { event_id: prior.event_id },
      );
    }
  };
  refuseIfRecorded(events);

  let taskId: string | undefined;
  if (input.disposition === 'record-only') {
    if (!(RECORD_ONLY_REASONS as readonly string[]).includes(input.reason)) {
      throw new WaveRevertedError(
        'revert.invalid-reason',
        `reason "${input.reason}" is not one of: ${RECORD_ONLY_REASONS.join(', ')}.`,
      );
    }
  } else {
    if (!Array.isArray(input.task_ids) || input.task_ids.length !== 1) {
      throw new WaveRevertedError(
        'revert.one-task-required',
        'A bounce names exactly one task id.',
        {
          task_ids: input.task_ids,
        },
      );
    }
    taskId = input.task_ids[0] as string;
    if (isAncestor === undefined || liveTaskIds === undefined) {
      throw new WaveRevertedError(
        'revert.preflight-required',
        'A bounce needs the isAncestor and liveTaskIds its preflight reads.',
      );
    }
    const reason = waveRevertBlocker(events, taskId, input.epic_id, {
      revertSha,
      isAncestor,
      liveTaskIds,
    });
    if (reason !== null) {
      throw new WaveRevertedError(
        'revert.blocked',
        `Task "${taskId}" cannot be reopened by this revert: ${reason}.`,
        {
          reason,
          taskId,
        },
      );
    }
    if (!Array.isArray(input.failing_checks) || input.failing_checks.length === 0) {
      throw new WaveRevertedError(
        'revert.failing-checks-required',
        'A bounce needs at least one failing check.',
      );
    }
    if (!Array.isArray(input.evidence_event_ids) || input.evidence_event_ids.length === 0) {
      throw new WaveRevertedError(
        'revert.evidence-required',
        'A bounce needs at least one evidence event id.',
      );
    }
  }

  const payload = {
    ...input,
    revert_sha: revertSha,
    ...(typeof input.reverted_merge_sha === 'string' && HEX40.test(input.reverted_merge_sha)
      ? { reverted_merge_sha: input.reverted_merge_sha.toLowerCase() }
      : {}),
  };
  // The check above spans the whole lineage and cannot be made atomic from
  // here: the lock `appendWithin` takes is per session log, and there is no
  // helper that holds every lineage session's lock at once. Repeating the
  // check inside that lock closes the race between callers that write the
  // same session's log (a resume and a bounce on one wave session); two
  // callers on different lineage sessions can still both pass.
  const [stored] = await appendWithin(
    ctx.sessionId,
    (own) => {
      refuseIfRecorded(own);
      return [
        {
          session_id: ctx.sessionId,
          actor: ctx.actor ?? 'system',
          event_type: WAVE_REVERTED_EVENT,
          ...(taskId === undefined ? {} : { task_id: taskId }),
          plan_version: ctx.planVersion,
          causal_parent: ctx.causalParent,
          payload,
        },
      ];
    },
    eventOpts,
  );
  return stored as StoredEvent;
}
