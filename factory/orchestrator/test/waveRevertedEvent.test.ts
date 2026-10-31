import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendEvent,
  listSessionIds,
  readEvents,
  readLineageEvents,
  type StoredEvent,
  startSession,
} from '../src/events.js';
import {
  RECORD_ONLY_REASONS,
  recordWaveReverted,
  WAVE_REVERTED_EVENT,
  waveRevertBlocker,
} from '../src/revert.js';

const EPIC = 'epic-1';
const TASK = 'epic-1/task-1';
const R = 'a'.repeat(40);
const M = 'b'.repeat(40);
const M2 = 'c'.repeat(40);

let seq = 0;
function ev(event_type: string, payload: Record<string, unknown>, task_id?: string): StoredEvent {
  seq += 1;
  return {
    event_id: `s#${seq}`,
    record: {
      session_id: 's',
      actor: 'system',
      event_type,
      ...(task_id === undefined ? {} : { task_id }),
      plan_version: 1,
      causal_parent: null,
      payload,
      ts: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
    },
  };
}
const added = () => ev('task-added', { epic_id: EPIC, task_status: 'todo' }, TASK);
const merged = (mergeSha?: string) =>
  ev('wave-merged', { task_ids: [TASK], ...(mergeSha ? { merge_sha: mergeSha } : {}) }, TASK);
const superseded = () => ev('task-superseded', {}, TASK);

// A tiny commit graph: M -> R (the revert) -> M2 (a re-merge after R).
const PARENTS: Record<string, string[]> = { [M]: [], [R]: [M], [M2]: [R] };
function isAncestor(a: string, b: string): boolean {
  if (a === b) return true;
  return (PARENTS[b] ?? []).some((p) => isAncestor(a, p));
}
const live = [TASK];
const input = (events: StoredEvent[], liveTaskIds: string[] = live) =>
  waveRevertBlocker(events, TASK, EPIC, { revertSha: R, isAncestor, liveTaskIds });

describe('waveRevertBlocker', () => {
  it('returns null for a completed merged task in the live plan', () => {
    expect(input([added(), merged(M)])).toBeNull();
  });

  it('returns not-merged when no wave-merged names the task', () => {
    expect(input([added()])).toBe('not-merged');
  });

  it('returns superseded for a task a later task-superseded replaced', () => {
    expect(input([added(), merged(M), superseded()])).toBe('superseded');
  });

  it('returns not-in-live-plan when an amendment dropped the finished task', () => {
    expect(input([added(), merged(M)], ['epic-1/other'])).toBe('not-in-live-plan');
    expect(input([added(), merged(M)], [])).toBe('not-in-live-plan');
  });

  it('matches a bare live id to a qualified task id', () => {
    expect(input([added(), merged(M)], ['task-1'])).toBeNull();
  });

  it('still returns superseded for a superseded task absent from the live plan', () => {
    expect(input([added(), merged(M), superseded()], [])).toBe('superseded');
  });

  describe('epic ownership', () => {
    const bare = (mergeSha: string, epicId?: string) =>
      ev(
        'wave-merged',
        { task_ids: ['task-1'], merge_sha: mergeSha, ...(epicId ? { epic_id: epicId } : {}) },
        'task-1',
      );
    const other = (events: StoredEvent[], taskId: string, epicId: string, live: string[]) =>
      waveRevertBlocker(events, taskId, epicId, {
        revertSha: R,
        isAncestor,
        liveTaskIds: live,
      });

    it("does not let another epic's merge of the same bare id count", () => {
      expect(other([added(), merged(M)], 'task-1', 'epic-2', ['task-1'])).toBe('not-merged');
    });

    it('returns not-merged for a task id qualified under a different epic', () => {
      expect(other([added(), merged(M)], 'epic-1/task-1', 'epic-2', ['epic-1/task-1'])).toBe(
        'not-merged',
      );
    });

    it('reads the epic of a bare wave-merged from its payload', () => {
      expect(other([bare(M, 'epic-1')], 'task-1', 'epic-2', ['task-1'])).toBe('not-merged');
      expect(other([bare(M, 'epic-1')], 'task-1', 'epic-1', ['task-1'])).toBeNull();
    });

    it('counts a bare wave-merged that names no epic anywhere', () => {
      expect(other([bare(M)], 'task-1', 'epic-1', ['task-1'])).toBeNull();
    });

    it("does not read another epic's re-merge as this task's", () => {
      const foreign = ev(
        'wave-merged',
        { task_ids: ['epic-2/task-1'], merge_sha: M2 },
        'epic-2/task-1',
      );
      expect(other([added(), merged(M), foreign], 'epic-1/task-1', 'epic-1', live)).toBeNull();
    });
  });

  describe('a malformed merge_sha', () => {
    it.each(['', 'abc', 'z'.repeat(40), 'c'.repeat(41)])(
      'never counts and never reaches isAncestor: %j',
      (bad) => {
        const calls: string[] = [];
        const probe = (a: string, b: string) => {
          calls.push(b);
          return isAncestor(a, b);
        };
        const events = [
          added(),
          merged(M),
          ev('wave-merged', { task_ids: [TASK], merge_sha: bad }, TASK),
        ];
        const out = waveRevertBlocker(events, TASK, EPIC, {
          revertSha: R,
          isAncestor: probe,
          liveTaskIds: live,
        });
        expect(out).toBeNull();
        expect(calls).toEqual([M]);
      },
    );
  });

  describe('re-merged by merge_sha ancestry', () => {
    it('the original merge (M, an ancestor of R) is not a re-merge', () => {
      expect(input([added(), merged(M)])).toBeNull();
    });

    it('a later merge whose commit descends from R is a re-merge', () => {
      expect(input([added(), merged(M), merged(M2)])).toBe('re-merged');
    });

    it('a re-merge is found whatever the event order', () => {
      expect(input([added(), merged(M2), merged(M)])).toBe('re-merged');
    });

    it('a wave-merged with no merge_sha never counts', () => {
      expect(input([added(), merged(M), merged()])).toBeNull();
    });
  });
});

describe('recordWaveReverted', () => {
  let stateDir: string;
  const sessionId = 'sess-wave-reverted';
  const opts = () => ({ stateDir });
  let ctx: { sessionId: string; planVersion: number; causalParent: string | null };

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-wave-reverted-'));
    let parent: string | null = null;
    const append = async (
      event_type: string,
      payload: Record<string, unknown>,
      task_id?: string,
    ) => {
      const stored = await appendEvent(
        {
          session_id: sessionId,
          actor: 'system',
          event_type,
          ...(task_id === undefined ? {} : { task_id }),
          plan_version: 1,
          causal_parent: parent,
          payload,
        },
        opts(),
      );
      parent = stored.event_id;
      return stored;
    };
    const root = await append('session-start', {});
    await append('task-added', { epic_id: EPIC, task_status: 'todo' }, TASK);
    const last = await append('wave-merged', { task_ids: [TASK], merge_sha: M }, TASK);
    ctx = { sessionId, planVersion: 1, causalParent: last.event_id };
    void root;
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const base = { epic_id: EPIC, integration_branch: 'bs/epic-1/integration', revert_sha: R };
  const recordOnly = (over: Record<string, unknown> = {}) =>
    ({
      ...base,
      disposition: 'record-only',
      reason: 'superseded',
      task_ids: [TASK],
      reverted_merge_sha: M,
      failing_checks: ['unit'],
      evidence_event_ids: ['s#1'],
      log_tail: 'x',
      evidence: 'record',
      ...over,
    }) as never;
  const bounce = (over: Record<string, unknown> = {}) =>
    ({
      ...base,
      disposition: 'bounce',
      task_ids: [TASK],
      reverted_merge_sha: M,
      failing_checks: ['unit'],
      red_record_event_id: 's#1',
      evidence_event_ids: ['s#1'],
      log_tail: 'boom',
      evidence: 'record',
      resumed: false,
      ...over,
    }) as never;
  const callOpts = () => ({ ...opts(), isAncestor, liveTaskIds: live });
  const count = async () => (await readEvents(sessionId, opts())).length;

  async function refused(call: () => Promise<unknown>, code: string): Promise<void> {
    const before = await count();
    await expect(call()).rejects.toMatchObject({ code });
    expect(await count()).toBe(before);
  }

  it('declares the six record-only reasons', () => {
    expect([...RECORD_ONLY_REASONS]).toEqual([
      'superseded',
      're-merged',
      'not-merged',
      'not-in-live-plan',
      'unknown-task',
      'invalid-trailers',
    ]);
  });

  it('writes a bounce for a completed merged live task', async () => {
    const stored = await recordWaveReverted(bounce(), ctx, callOpts());
    expect(stored.record.event_type).toBe(WAVE_REVERTED_EVENT);
    expect(stored.record.task_id).toBe(TASK);
    expect(stored.record.payload).toMatchObject({
      disposition: 'bounce',
      revert_sha: R,
      task_ids: [TASK],
      failing_checks: ['unit'],
    });
  });

  it.each([...RECORD_ONLY_REASONS])('accepts a record-only call with reason %s', async (reason) => {
    const stored = await recordWaveReverted(
      recordOnly({ reason, revert_sha: R.replace(/a/g, reason.length % 2 ? 'd' : 'e') }),
      ctx,
      opts(),
    );
    expect(stored.record.payload).toMatchObject({ disposition: 'record-only', reason });
  });

  it('accepts the emptiest record-only call', async () => {
    const stored = await recordWaveReverted(
      recordOnly({
        reason: 'unknown-task',
        task_ids: [],
        reverted_merge_sha: null,
        failing_checks: [],
        evidence_event_ids: [],
        log_tail: '',
        evidence: 'unreadable',
      }),
      ctx,
      opts(),
    );
    expect(stored.record.payload).toMatchObject({ task_ids: [], reverted_merge_sha: null });
  });

  it('refuses a second record for the same revert_sha, leaving the log unchanged', async () => {
    await recordWaveReverted(recordOnly(), ctx, opts());
    await refused(() => recordWaveReverted(recordOnly(), ctx, opts()), 'revert.already-recorded');
    await refused(() => recordWaveReverted(bounce(), ctx, callOpts()), 'revert.already-recorded');
  });

  it('treats an upper-case revert_sha as the same revert, leaving the log unchanged', async () => {
    await recordWaveReverted(recordOnly({ revert_sha: 'ab'.repeat(20) }), ctx, opts());
    await refused(
      () => recordWaveReverted(recordOnly({ revert_sha: 'AB'.repeat(20) }), ctx, opts()),
      'revert.already-recorded',
    );
  });

  it('stores revert_sha and reverted_merge_sha lower-cased', async () => {
    const stored = await recordWaveReverted(
      recordOnly({ revert_sha: 'AB'.repeat(20), reverted_merge_sha: 'CD'.repeat(20) }),
      ctx,
      opts(),
    );
    expect(stored.record.payload).toMatchObject({
      revert_sha: 'ab'.repeat(20),
      reverted_merge_sha: 'cd'.repeat(20),
    });
  });

  it('keeps a null reverted_merge_sha and a non-hex one as given', async () => {
    const stored = await recordWaveReverted(
      recordOnly({ revert_sha: 'ab'.repeat(20), reverted_merge_sha: null }),
      ctx,
      opts(),
    );
    expect(stored.record.payload).toMatchObject({ reverted_merge_sha: null });
  });

  it('lets exactly one of two concurrent calls for one revert_sha through', async () => {
    const before = await count();
    const settled = await Promise.allSettled([
      recordWaveReverted(recordOnly(), ctx, opts()),
      recordWaveReverted(recordOnly({ revert_sha: R.toUpperCase() }), ctx, opts()),
    ]);
    expect(settled.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'revert.already-recorded' });
    expect(await count()).toBe(before + 1);
  });

  it('never lets a blocker refuse a record-only call', async () => {
    const stored = await recordWaveReverted(
      recordOnly({ reason: 'not-merged', task_ids: ['epic-1/never-merged'] }),
      ctx,
      opts(),
    );
    expect(stored.record.payload).toMatchObject({ reason: 'not-merged' });
  });

  it('refuses a record-only reason outside the list', async () => {
    await refused(
      () => recordWaveReverted(recordOnly({ reason: 'because' }), ctx, opts()),
      'revert.invalid-reason',
    );
  });

  it('refuses a 7-hex revert_sha', async () => {
    await refused(
      () => recordWaveReverted(recordOnly({ revert_sha: 'abc1234' }), ctx, opts()),
      'revert.invalid-sha',
    );
  });

  it('refuses a missing integration_branch and a missing disposition', async () => {
    await refused(
      () => recordWaveReverted(recordOnly({ integration_branch: '' }), ctx, opts()),
      'revert.integration-branch-required',
    );
    await refused(
      () => recordWaveReverted(recordOnly({ disposition: undefined }), ctx, opts()),
      'revert.invalid-disposition',
    );
  });

  describe('a bounce', () => {
    it('is refused for a blocker, each reason naming itself', async () => {
      await refused(
        () => recordWaveReverted(bounce(), ctx, { ...callOpts(), liveTaskIds: [] }),
        'revert.blocked',
      );
      await expect(
        recordWaveReverted(bounce(), ctx, { ...callOpts(), liveTaskIds: [] }),
      ).rejects.toMatchObject({ details: { reason: 'not-in-live-plan' } });
      await refused(
        () => recordWaveReverted(bounce({ task_ids: ['epic-1/task-9'] }), ctx, callOpts()),
        'revert.blocked',
      );
    });

    it('is refused for a task that was re-merged after the revert', async () => {
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'system',
          event_type: 'wave-merged',
          task_id: TASK,
          plan_version: 1,
          causal_parent: ctx.causalParent,
          payload: { task_ids: [TASK], merge_sha: M2 },
        },
        opts(),
      );
      await refused(() => recordWaveReverted(bounce(), ctx, callOpts()), 'revert.blocked');
    });

    it('is refused for a missing or empty epic_id, and record-only does not need one', async () => {
      await refused(
        () => recordWaveReverted(bounce({ epic_id: undefined }), ctx, callOpts()),
        'revert.epic-required',
      );
      await refused(
        () => recordWaveReverted(bounce({ epic_id: '' }), ctx, callOpts()),
        'revert.epic-required',
      );
      const stored = await recordWaveReverted(recordOnly({ epic_id: undefined }), ctx, opts());
      expect(stored.record.payload).toMatchObject({ disposition: 'record-only' });
    });

    it('is refused for an empty failing_checks', async () => {
      await refused(
        () => recordWaveReverted(bounce({ failing_checks: [] }), ctx, callOpts()),
        'revert.failing-checks-required',
      );
    });

    it('is refused for an empty evidence_event_ids', async () => {
      await refused(
        () => recordWaveReverted(bounce({ evidence_event_ids: [] }), ctx, callOpts()),
        'revert.evidence-required',
      );
    });

    it('is refused for two task ids, and for none', async () => {
      await refused(
        () => recordWaveReverted(bounce({ task_ids: [TASK, 'epic-1/task-2'] }), ctx, callOpts()),
        'revert.one-task-required',
      );
      await refused(
        () => recordWaveReverted(bounce({ task_ids: [] }), ctx, callOpts()),
        'revert.one-task-required',
      );
    });

    it('is refused when the caller passes no isAncestor or liveTaskIds', async () => {
      await refused(() => recordWaveReverted(bounce(), ctx, opts()), 'revert.preflight-required');
    });
  });
});

describe('recordWaveReverted across one session tree', () => {
  let stateDir: string;
  const opts = () => ({ stateDir });
  const ROOT = 'sess-tree-root';
  const W1 = 'sess-tree-w1';
  const W2 = 'sess-tree-w2';
  const ctxOf = (sessionId: string) => ({
    sessionId,
    planVersion: 1,
    causalParent: `${sessionId}#0`,
  });
  const recordOnly = (over: Record<string, unknown> = {}) =>
    ({
      epic_id: EPIC,
      integration_branch: 'bs/epic-1/integration',
      revert_sha: R,
      disposition: 'record-only',
      reason: 'superseded',
      task_ids: [TASK],
      reverted_merge_sha: M,
      failing_checks: [],
      evidence_event_ids: [],
      log_tail: '',
      evidence: 'unreadable',
      ...over,
    }) as never;
  const bounce = () =>
    ({
      epic_id: EPIC,
      integration_branch: 'bs/epic-1/integration',
      revert_sha: R,
      disposition: 'bounce',
      task_ids: [TASK],
      reverted_merge_sha: M,
      failing_checks: ['unit'],
      red_record_event_id: 's#1',
      evidence_event_ids: ['s#1'],
      log_tail: 'boom',
      evidence: 'record',
      resumed: false,
    }) as never;
  const wavesRecorded = async () =>
    (await readLineageEvents(ROOT, opts())).filter(
      (e) => e.record.event_type === WAVE_REVERTED_EVENT,
    );
  const log = (sessionId: string, event_type: string, payload: Record<string, unknown>) =>
    appendEvent(
      {
        session_id: sessionId,
        actor: 'system',
        event_type,
        task_id: TASK,
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload,
      },
      opts(),
    );

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-wave-reverted-tree-'));
    const root = await startSession(ROOT, opts());
    await startSession(W1, { ...opts(), continues: root.event_id });
    await startSession(W2, { ...opts(), continues: root.event_id });
  });
  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('lets exactly one of two sibling sessions record one revert_sha at the same time', async () => {
    const settled = await Promise.allSettled([
      recordWaveReverted(recordOnly(), ctxOf(W1), opts()),
      recordWaveReverted(recordOnly(), ctxOf(W2), opts()),
    ]);
    expect(settled.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'revert.already-recorded' });
    expect(await wavesRecorded()).toHaveLength(1);
  });

  it('keeps its lock file out of the session list', async () => {
    await recordWaveReverted(recordOnly(), ctxOf(W1), opts());
    expect(listSessionIds(stateDir).sort()).toEqual([ROOT, W1, W2].sort());
  });

  it('refuses a sibling session a revert_sha another session of the tree recorded', async () => {
    await recordWaveReverted(recordOnly(), ctxOf(W2), opts());
    const before = (await readEvents(W1, opts())).length;
    await expect(recordWaveReverted(recordOnly(), ctxOf(W1), opts())).rejects.toMatchObject({
      code: 'revert.already-recorded',
    });
    expect((await readEvents(W1, opts())).length).toBe(before);
    expect(await wavesRecorded()).toHaveLength(1);
  });

  it("reads the blocker over the caller's lineage, not the root's tree", async () => {
    await log(W1, 'wave-admitted', { epic_id: EPIC, task_ids: [TASK] });
    await log(W1, 'wave-merged', { epic_id: EPIC, task_ids: [TASK], merge_sha: M });
    await log(W2, 'wave-merged', { epic_id: EPIC, task_ids: [TASK], merge_sha: M2 });
    const stored = await recordWaveReverted(bounce(), ctxOf(W1), {
      ...opts(),
      isAncestor,
      liveTaskIds: live,
    });
    expect(stored.record.event_type).toBe(WAVE_REVERTED_EVENT);
  });
});
