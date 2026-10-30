import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendEvent, readEvents, type StoredEvent } from '../src/events.js';
import {
  RECORD_ONLY_REASONS,
  recordWaveReverted,
  WAVE_REVERTED_EVENT,
  waveRevertBlocker,
} from '../src/revert.js';

// The projector never folds a task to `waived`, `failed` or `escalated` once a
// `wave-merged` names it (`wave-merged` completes the row unconditionally and
// a terminal row is never overwritten), so those two blockers cannot be
// reached through a real log today. The fold is replaced for the tests that
// pin the mapping from a folded status to its reason; every other test folds
// the real log.
const override = vi.hoisted(() => ({ status: null as string | null }));
vi.mock('../src/db/projector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/projector.js')>();
  return {
    ...actual,
    foldTasks: (...args: Parameters<typeof actual.foldTasks>) => {
      const rows = actual.foldTasks(...args);
      return override.status === null
        ? rows
        : rows.map((r) => ({ ...r, taskStatus: override.status as string }));
    },
  };
});

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
  beforeEach(() => {
    override.status = null;
  });

  it('returns null for a completed merged task in the live plan', () => {
    expect(input([added(), merged(M)])).toBeNull();
  });

  it('returns not-merged when no wave-merged names the task', () => {
    expect(input([added()])).toBe('not-merged');
  });

  it('returns superseded for a task a later task-superseded replaced', () => {
    expect(input([added(), merged(M), superseded()])).toBe('superseded');
  });

  it('returns waived for a task whose folded status is waived', () => {
    override.status = 'waived';
    expect(input([added(), merged(M)])).toBe('waived');
  });

  it.each(['failed', 'escalated'])('returns held-by-operator for a %s task', (status) => {
    override.status = status;
    expect(input([added(), merged(M)])).toBe('held-by-operator');
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
    override.status = null;
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

  it('declares the eight record-only reasons', () => {
    expect([...RECORD_ONLY_REASONS]).toEqual([
      'superseded',
      'waived',
      'held-by-operator',
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
