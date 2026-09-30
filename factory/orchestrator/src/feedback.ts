import { randomUUID } from 'node:crypto';
import { SmithError } from './errors.js';
import { appendEvent, type EventOpts, readLineageEvents, type StoredEvent } from './events.js';
import type { EventContext } from './findings.js';

/**
 * The writer for operator feedback left mid-run on a task — from the
 * dashboard or from GitHub, per the comment. Modeled on prompts.ts's
 * recordUserPrompt: this module owns the payload shape, the one refusal, and
 * the idempotency check, and makes no routing decision — the resolution
 * (bounce a task back to its coder, or open a follow-up) is a later PR's
 * playbook wiring, not this one's.
 *
 * Two event types:
 *   - `operator-feedback-recorded`: the comment itself, as given.
 *   - `operator-feedback-resolved`: what the operator (or the playbook
 *     dispatching on their behalf) decided to do about it.
 *
 * `feedback_id` is a `fb-`-prefixed uuid (randomUUID, node:crypto — the same
 * generator queue.ts already uses for a fresh id with no natural key of its
 * own), not a content hash: unlike lessons.ts's defaultLessonId, which treats
 * identical statement text as the SAME lesson on purpose, two feedback
 * comments with the same words are two different remarks made at two
 * different times, and must never collide. `external_id` is the codebase's
 * actual idempotency key here — recording the same external_id twice returns
 * the existing feedback and appends nothing, which is what lets a later PR
 * import a GitHub comment thread without double-recording on a retry.
 *
 * `RecordFeedbackInput.feedbackId` lets a caller pin the id instead of
 * generating one. Nothing in cli.ts sets it — the CLI always mints a fresh
 * one — but test/db/fixtures.ts does, because ui/test/e2eFixtureDeterminism.
 * test.ts asserts two builds of the same fixture produce byte-identical
 * event logs, and `randomUUID()` is the one piece of this module's output
 * that a fixed clock (fixtureClock.ts) cannot normalize after the fact.
 */
export class FeedbackError extends SmithError {}

export type FeedbackKind = 'must-fix' | 'nice-to-have';
export type FeedbackSource = 'dashboard' | 'github' | 'cli';
export type FeedbackResolution = 'bounced' | 'follow-up' | 'dismissed';

export interface OperatorFeedback {
  feedbackId: string;
  taskId: string;
  sessionId: string;
  body: string;
  kind: FeedbackKind;
  source: FeedbackSource;
  externalId?: string;
  author?: string;
  recordedAt: string;
  recordedEventId: string;
  resolvedAt?: string;
  resolution?: FeedbackResolution;
  followUpTaskId?: string;
}

export interface RecordFeedbackInput {
  taskId: string;
  body: string;
  kind?: FeedbackKind;
  source?: FeedbackSource;
  externalId?: string;
  author?: string;
  /** Pins the minted id instead of generating one — see the module doc. */
  feedbackId?: string;
}

export interface RecordFeedbackResult {
  feedbackId: string;
  event: StoredEvent;
  /** True when `externalId` matched an existing feedback item: nothing was appended. */
  deduped: boolean;
}

export interface ResolveFeedbackInput {
  feedbackId: string;
  resolution: FeedbackResolution;
  note?: string;
  followUpTaskId?: string;
}

/**
 * Fold every `operator-feedback-recorded`/`operator-feedback-resolved` event
 * in the given events into current state, one row per `feedback_id`.
 *
 * Owned here rather than in db/projector.ts, on findings.ts's pattern (not
 * lessons.ts's): this keeps feedback.ts free of the db layer, so cli.ts's
 * `feedback record`/`feedback resolve` branches can import it statically —
 * exactly like prompts.ts and findings.ts today — with no dynamic import.
 */
export function foldOperatorFeedback(events: readonly StoredEvent[]): OperatorFeedback[] {
  const byId = new Map<string, OperatorFeedback>();
  for (const { event_id, record } of events) {
    if (record.event_type === 'operator-feedback-recorded') {
      const payload = record.payload as {
        feedback_id?: string;
        task_id?: string;
        body?: string;
        kind?: FeedbackKind;
        source?: FeedbackSource;
        external_id?: string;
        author?: string;
      };
      if (!payload.feedback_id || !payload.task_id || typeof payload.body !== 'string') continue;
      byId.set(payload.feedback_id, {
        feedbackId: payload.feedback_id,
        taskId: payload.task_id,
        sessionId: record.session_id,
        body: payload.body,
        kind: payload.kind ?? 'must-fix',
        source: payload.source ?? 'cli',
        externalId: payload.external_id,
        author: payload.author,
        recordedAt: record.ts,
        recordedEventId: event_id,
      });
    } else if (record.event_type === 'operator-feedback-resolved') {
      const payload = record.payload as {
        feedback_id?: string;
        resolution?: FeedbackResolution;
        follow_up_task_id?: string;
      };
      const existing = payload.feedback_id ? byId.get(payload.feedback_id) : undefined;
      if (!existing || !payload.resolution) continue;
      byId.set(existing.feedbackId, {
        ...existing,
        resolvedAt: record.ts,
        resolution: payload.resolution,
        followUpTaskId: payload.follow_up_task_id,
      });
    }
  }
  return [...byId.values()];
}

/**
 * Every unresolved feedback item across the session's LINEAGE (D-119: an epic
 * spanning sessions must not present an empty board to its second session),
 * optionally narrowed to one task.
 */
export async function listPendingFeedback(
  sessionId: string,
  filter: { taskId?: string } = {},
  opts: EventOpts = {},
): Promise<OperatorFeedback[]> {
  const events = await readLineageEvents(sessionId, opts);
  return foldOperatorFeedback(events).filter(
    (row) => row.resolution === undefined && (!filter.taskId || row.taskId === filter.taskId),
  );
}

/**
 * Append one `operator-feedback-recorded`, or return the existing feedback
 * item unchanged when `externalId` already names one.
 *
 * `actor` defaults to `'user'` — the same operator-actor default prompts.ts
 * and waivers.ts use — since a comment left on the dashboard or synced from
 * GitHub is the operator's own word, whichever surface it arrived through.
 */
export async function recordFeedback(
  input: RecordFeedbackInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<RecordFeedbackResult> {
  if (input.body.trim() === '') {
    throw new FeedbackError(
      'feedback.empty-body',
      'Operator feedback needs a body: nothing but whitespace was given, so no event was written.',
      { task_id: input.taskId },
    );
  }

  if (input.externalId !== undefined) {
    const priorEvents = await readLineageEvents(ctx.sessionId, opts);
    const existingEvent = priorEvents.find(
      (e) =>
        e.record.event_type === 'operator-feedback-recorded' &&
        (e.record.payload as { external_id?: string }).external_id === input.externalId,
    );
    if (existingEvent) {
      const payload = existingEvent.record.payload as { feedback_id: string };
      return { feedbackId: payload.feedback_id, event: existingEvent, deduped: true };
    }
  }

  const feedbackId = input.feedbackId ?? `fb-${randomUUID()}`;
  const kind = input.kind ?? 'must-fix';
  const source = input.source ?? 'cli';
  const event = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'user',
      event_type: 'operator-feedback-recorded',
      task_id: input.taskId,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        feedback_id: feedbackId,
        task_id: input.taskId,
        body: input.body,
        kind,
        source,
        ...(input.externalId !== undefined ? { external_id: input.externalId } : {}),
        ...(input.author !== undefined ? { author: input.author } : {}),
      },
    },
    opts,
  );

  return { feedbackId, event, deduped: false };
}

/**
 * Append one `operator-feedback-resolved`. Refuses a `feedbackId` the
 * lineage has never recorded, or one that already carries a resolution —
 * resolving twice would silently prefer whichever wrote last, and the
 * second write is always a mistake: either a stale retry or the operator
 * looking at an out-of-date pending list.
 */
export async function resolveFeedback(
  input: ResolveFeedbackInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<StoredEvent> {
  const events = await readLineageEvents(ctx.sessionId, opts);
  const existing = foldOperatorFeedback(events).find((row) => row.feedbackId === input.feedbackId);

  if (!existing) {
    throw new FeedbackError(
      'feedback.unknown-feedback',
      `No operator feedback '${input.feedbackId}' in session '${ctx.sessionId}''s lineage. Check the id, or record it first with 'smith feedback record'.`,
      { feedback_id: input.feedbackId, session_id: ctx.sessionId },
    );
  }
  if (existing.resolution !== undefined) {
    throw new FeedbackError(
      'feedback.already-resolved',
      `Operator feedback '${input.feedbackId}' was already resolved as '${existing.resolution}'. Resolving it again would silently prefer whichever write lands last.`,
      { feedback_id: input.feedbackId, resolution: existing.resolution },
    );
  }

  return appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'user',
      event_type: 'operator-feedback-resolved',
      task_id: existing.taskId,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        feedback_id: input.feedbackId,
        task_id: existing.taskId,
        resolution: input.resolution,
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.followUpTaskId !== undefined ? { follow_up_task_id: input.followUpTaskId } : {}),
      },
    },
    opts,
  );
}
