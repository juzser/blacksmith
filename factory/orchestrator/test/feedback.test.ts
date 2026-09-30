import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, rebuild } from '../src/db/projector.js';
import * as schema from '../src/db/schema.js';
import { appendEvent, readEvents } from '../src/events.js';
import {
  FeedbackError,
  foldOperatorFeedback,
  recordFeedback,
  resolveFeedback,
} from '../src/feedback.js';
import type { EventContext } from '../src/findings.js';

describe('recordFeedback / resolveFeedback', () => {
  let stateDir: string;
  const sessionId = 'sess-feedback';
  const taskId = 'epic-1/task-1';
  let ctx: EventContext;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-feedback-'));
    const root = await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
    ctx = { sessionId, planVersion: 1, causalParent: root.event_id };
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  async function feedbackEvents() {
    const events = await readEvents(sessionId, { stateDir });
    return events.filter((e) => e.record.event_type.startsWith('operator-feedback-'));
  }

  it('writes an operator-feedback-recorded event with the given body and task', async () => {
    const result = await recordFeedback({ taskId, body: 'Please fix the flaky test.' }, ctx, {
      stateDir,
    });

    expect(result.deduped).toBe(false);
    expect(result.event.record.event_type).toBe('operator-feedback-recorded');
    expect(result.event.record.payload).toMatchObject({
      feedback_id: result.feedbackId,
      task_id: taskId,
      body: 'Please fix the flaky test.',
      kind: 'must-fix',
      source: 'cli',
    });
    expect((await feedbackEvents()).length).toBe(1);
  });

  it('accepts a pinned feedbackId, for fixture builders that need two runs to agree', async () => {
    const result = await recordFeedback(
      { taskId, body: 'Please fix the flaky test.', feedbackId: 'fb-fixed-1' },
      ctx,
      { stateDir },
    );

    expect(result.feedbackId).toBe('fb-fixed-1');
    expect(result.event.record.payload).toMatchObject({ feedback_id: 'fb-fixed-1' });
  });

  it('defaults kind to must-fix and source to cli', async () => {
    const result = await recordFeedback({ taskId, body: 'Consider renaming this.' }, ctx, {
      stateDir,
    });
    expect(result.event.record.payload).toMatchObject({ kind: 'must-fix', source: 'cli' });
  });

  it('accepts an explicit kind and source', async () => {
    const result = await recordFeedback(
      {
        taskId,
        body: 'Nice idea for later.',
        kind: 'nice-to-have',
        source: 'dashboard',
        author: 'sonnh',
      },
      ctx,
      { stateDir },
    );
    expect(result.event.record.payload).toMatchObject({
      kind: 'nice-to-have',
      source: 'dashboard',
      author: 'sonnh',
    });
  });

  it("defaults the actor to 'user', the repo's operator actor", async () => {
    const result = await recordFeedback({ taskId, body: 'Ship it differently.' }, ctx, {
      stateDir,
    });
    expect(result.event.record.actor).toBe('user');
  });

  it('lets the caller name a different operator actor', async () => {
    const result = await recordFeedback(
      { taskId, body: 'Ship it differently.' },
      { ...ctx, actor: 'operator' },
      { stateDir },
    );
    expect(result.event.record.actor).toBe('operator');
  });

  it('refuses whitespace-only body, writing nothing', async () => {
    await expect(
      recordFeedback({ taskId, body: '   \n\t ' }, ctx, { stateDir }),
    ).rejects.toMatchObject({ code: 'feedback.empty-body' });
    expect((await feedbackEvents()).length).toBe(0);
  });

  it('is idempotent on external_id: a second record with the same external_id appends nothing', async () => {
    const first = await recordFeedback(
      { taskId, body: 'From a GitHub comment.', source: 'github', externalId: 'gh-comment:1' },
      ctx,
      { stateDir },
    );
    expect(first.deduped).toBe(false);

    const second = await recordFeedback(
      {
        taskId,
        body: 'From a GitHub comment (retry).',
        source: 'github',
        externalId: 'gh-comment:1',
      },
      { ...ctx, causalParent: first.event.event_id },
      { stateDir },
    );

    expect(second.deduped).toBe(true);
    expect(second.feedbackId).toBe(first.feedbackId);
    expect((await feedbackEvents()).length).toBe(1);
  });

  it('a different external_id is recorded as a new feedback item', async () => {
    const first = await recordFeedback(
      { taskId, body: 'One comment.', source: 'github', externalId: 'gh-comment:1' },
      ctx,
      { stateDir },
    );
    const second = await recordFeedback(
      { taskId, body: 'Another comment.', source: 'github', externalId: 'gh-comment:2' },
      { ...ctx, causalParent: first.event.event_id },
      { stateDir },
    );
    expect(second.deduped).toBe(false);
    expect(second.feedbackId).not.toBe(first.feedbackId);
    expect((await feedbackEvents()).length).toBe(2);
  });

  it('resolves a recorded feedback item as bounced', async () => {
    const recorded = await recordFeedback({ taskId, body: 'Fix this.' }, ctx, { stateDir });
    const resolved = await resolveFeedback(
      { feedbackId: recorded.feedbackId, resolution: 'bounced', note: 'sent back to coder' },
      { ...ctx, causalParent: recorded.event.event_id },
      { stateDir },
    );

    expect(resolved.record.event_type).toBe('operator-feedback-resolved');
    expect(resolved.record.payload).toMatchObject({
      feedback_id: recorded.feedbackId,
      task_id: taskId,
      resolution: 'bounced',
      note: 'sent back to coder',
    });
  });

  it('resolves a recorded feedback item as follow-up, carrying the new task id', async () => {
    const recorded = await recordFeedback({ taskId, body: 'Fix this.' }, ctx, { stateDir });
    const resolved = await resolveFeedback(
      {
        feedbackId: recorded.feedbackId,
        resolution: 'follow-up',
        followUpTaskId: 'epic-1/task-2',
      },
      { ...ctx, causalParent: recorded.event.event_id },
      { stateDir },
    );
    expect(resolved.record.payload).toMatchObject({
      resolution: 'follow-up',
      follow_up_task_id: 'epic-1/task-2',
    });
  });

  it('rejects resolving an unknown feedback id', async () => {
    await expect(
      resolveFeedback({ feedbackId: 'fb-does-not-exist', resolution: 'dismissed' }, ctx, {
        stateDir,
      }),
    ).rejects.toMatchObject({ code: 'feedback.unknown-feedback' });
  });

  it('rejects resolving a feedback id that is already resolved', async () => {
    const recorded = await recordFeedback({ taskId, body: 'Fix this.' }, ctx, { stateDir });
    const resolvedCtx = { ...ctx, causalParent: recorded.event.event_id };
    const first = await resolveFeedback(
      { feedbackId: recorded.feedbackId, resolution: 'dismissed' },
      resolvedCtx,
      { stateDir },
    );

    await expect(
      resolveFeedback(
        { feedbackId: recorded.feedbackId, resolution: 'bounced' },
        { ...ctx, causalParent: first.event_id },
        { stateDir },
      ),
    ).rejects.toBeInstanceOf(FeedbackError);
    await expect(
      resolveFeedback(
        { feedbackId: recorded.feedbackId, resolution: 'bounced' },
        { ...ctx, causalParent: first.event_id },
        { stateDir },
      ),
    ).rejects.toMatchObject({ code: 'feedback.already-resolved' });
  });

  it('folds recorded and resolved feedback into current state', async () => {
    const recorded = await recordFeedback({ taskId, body: 'Fix this.' }, ctx, { stateDir });
    await resolveFeedback(
      { feedbackId: recorded.feedbackId, resolution: 'bounced' },
      { ...ctx, causalParent: recorded.event.event_id },
      { stateDir },
    );

    const events = await readEvents(sessionId, { stateDir });
    const rows = foldOperatorFeedback(events);
    expect(rows).toMatchObject([
      { feedbackId: recorded.feedbackId, taskId, resolution: 'bounced' },
    ]);
  });

  it('lands in the operator_feedback table on a full rebuild (global fold, like lessons/findings)', async () => {
    const recorded = await recordFeedback({ taskId, body: 'Fix this.' }, ctx, { stateDir });

    const dbDir = await mkdtemp(path.join(tmpdir(), 'smith-feedback-db-'));
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.operatorFeedback).all();
    handle.sqlite.close();
    await rm(dbDir, { recursive: true, force: true });

    expect(rows).toMatchObject([
      {
        id: recorded.feedbackId,
        taskId,
        sessionId,
        body: 'Fix this.',
        kind: 'must-fix',
        source: 'cli',
      },
    ]);
  });
});
