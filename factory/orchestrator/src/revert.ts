import { foldTasks } from './db/projector.js';
import { SmithError } from './errors.js';
import { appendEvent, type EventOpts, readLineageEvents, type StoredEvent } from './events.js';
import type { EventContext } from './findings.js';
import { taskIdsMatch } from './taskId.js';
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

/**
 * The first reason a revert of `taskId`'s merge cannot reopen it, or null.
 *
 * Re-merged is decided by `merge_sha` ancestry, never by event order: a
 * `wave-merged` counts only when its merge commit descends from the revert,
 * and one without `merge_sha` (written before the field existed) cannot.
 */
export function waveRevertBlocker(
  events: readonly StoredEvent[],
  taskId: string,
  _epicId: string,
  input: WaveRevertBlockerInput,
): RecordOnlyReason | null {
  const merges = events.filter(
    (e) => e.record.event_type === 'wave-merged' && namesTask(e.record, taskId),
  );
  if (merges.length === 0) return 'not-merged';
  const status = foldTasks(events).find((row) => taskIdsMatch(row.taskId, taskId))?.taskStatus;
  if (status === 'superseded') return 'superseded';
  if (status === 'waived') return 'waived';
  if (status === 'failed' || status === 'escalated') return 'held-by-operator';
  const reMerged = merges.some((e) => {
    const sha = (e.record.payload as { merge_sha?: unknown }).merge_sha;
    return typeof sha === 'string' && input.isAncestor(input.revertSha, sha);
  });
  if (reMerged) return 're-merged';
  if (!input.liveTaskIds.some((id) => taskIdsMatch(id, taskId))) return 'not-in-live-plan';
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

const HEX40 = /^[0-9a-f]{40}$/i;

function refuse(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new WaveRevertedError(`revert.${code}`, message, details);
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
    refuse('invalid-sha', `revert_sha must be a full 40-hex commit id, got "${input.revert_sha}".`);
  }
  if (typeof input.integration_branch !== 'string' || input.integration_branch === '') {
    refuse('integration-branch-required', 'integration_branch is required.');
  }
  if (input.disposition !== 'bounce' && input.disposition !== 'record-only') {
    refuse(
      'invalid-disposition',
      `disposition must be "bounce" or "record-only", got "${String((input as { disposition?: unknown }).disposition)}".`,
    );
  }

  const events = await readLineageEvents(ctx.sessionId, eventOpts);
  const revertSha = input.revert_sha.toLowerCase();
  const prior = events.find(
    (e) =>
      e.record.event_type === WAVE_REVERTED_EVENT &&
      String((e.record.payload as { revert_sha?: unknown }).revert_sha).toLowerCase() === revertSha,
  );
  if (prior !== undefined) {
    refuse(
      'already-recorded',
      `Revert ${input.revert_sha} already has a wave-reverted event (${prior.event_id}).`,
      {
        event_id: prior.event_id,
      },
    );
  }

  let taskId: string | undefined;
  if (input.disposition === 'record-only') {
    if (!(RECORD_ONLY_REASONS as readonly string[]).includes(input.reason)) {
      refuse(
        'invalid-reason',
        `reason "${input.reason}" is not one of: ${RECORD_ONLY_REASONS.join(', ')}.`,
      );
    }
  } else {
    if (!Array.isArray(input.task_ids) || input.task_ids.length !== 1) {
      refuse('one-task-required', 'A bounce names exactly one task id.', {
        task_ids: input.task_ids,
      });
    }
    taskId = input.task_ids[0] as string;
    if (isAncestor === undefined || liveTaskIds === undefined) {
      refuse(
        'preflight-required',
        'A bounce needs the isAncestor and liveTaskIds its preflight reads.',
      );
    }
    const reason = waveRevertBlocker(events, taskId, input.epic_id, {
      revertSha,
      isAncestor,
      liveTaskIds,
    });
    if (reason !== null) {
      refuse('blocked', `Task "${taskId}" cannot be reopened by this revert: ${reason}.`, {
        reason,
        taskId,
      });
    }
    if (!Array.isArray(input.failing_checks) || input.failing_checks.length === 0) {
      refuse('failing-checks-required', 'A bounce needs at least one failing check.');
    }
    if (!Array.isArray(input.evidence_event_ids) || input.evidence_event_ids.length === 0) {
      refuse('evidence-required', 'A bounce needs at least one evidence event id.');
    }
  }

  return appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: WAVE_REVERTED_EVENT,
      ...(taskId === undefined ? {} : { task_id: taskId }),
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: { ...input },
    },
    eventOpts,
  );
}
