import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendEvent, type StoredEvent } from '../src/events.js';
import {
  INTEGRATION_CHECK_EVENT,
  type IntegrationCheckRecord,
  runIntegrationCheck,
} from '../src/integration.js';
import { runPostMerge } from '../src/postMerge.js';
import { isBsRevertCommit, type PostMergeInput } from '../src/postMergeBisect.js';
import { trailerValues } from '../src/postMergeResume.js';
import { recordWaveReverted, WAVE_REVERTED_EVENT } from '../src/revert.js';
import type { CheckCommand, CheckResult } from '../src/testgate.js';
import { createIntegrationRepo, type IntegrationRepo } from './helpers/integrationRepo.js';
import { git as runGit } from './helpers/process.js';

type Runner = typeof runIntegrationCheck;

// A switch that makes the post-merge resume reject the way a mid-write failure
// does, carrying the writes it already made as `wrote`.
const resumeFault = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('../src/postMergeResume.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/postMergeResume.js')>();
  return {
    ...actual,
    resumeLandedReverts: (...args: Parameters<typeof actual.resumeLandedReverts>) => {
      if (resumeFault.error !== null) return Promise.reject(resumeFault.error);
      return actual.resumeLandedReverts(...args);
    },
  };
});

describe('post-merge revert landing', () => {
  let repo: IntegrationRepo;
  let counter: string;

  const BROKEN = { 'broken.txt': 'x\n' };
  const POST = (): CheckCommand => ({
    name: 'post-a',
    cmd: `echo x >> ${counter}; test ! -f broken.txt`,
    tier: 'post-merge',
  });
  const PRE: CheckCommand = {
    name: 'pre-a',
    cmd: 'test ! -f use.txt || test -f lib.txt',
    tier: 'pre-merge',
  };
  const T = (n: number) => `epic-1/task-${n}`;

  const append = (event_type: string, payload: Record<string, unknown>, task_id?: string) =>
    appendEvent(
      {
        session_id: repo.sessionId,
        actor: 'system',
        event_type,
        ...(task_id === undefined ? {} : { task_id }),
        plan_version: 1,
        causal_parent: `${repo.sessionId}#0`,
        payload,
      },
      repo.opts(),
    );
  /** Merge a task into the integration branch and log its admission and merge. */
  const mergeTask = async (n: number, files: Record<string, string | null>): Promise<string> => {
    await append('wave-admitted', { epic_id: repo.epicId, task_ids: [T(n)] }, T(n));
    const sha = repo.merge(`task-${n}`, files);
    await append('wave-merged', { epic_id: repo.epicId, task_ids: [T(n)], merge_sha: sha }, T(n));
    return sha;
  };
  /** Three task merges where merge 2 breaks the post-merge check. */
  const threeMerges = async () => ({
    m1: await mergeTask(1, { 'a.txt': 'a\n' }),
    m2: await mergeTask(2, { ...BROKEN, 'lib.txt': 'lib\n' }),
    m3: await mergeTask(3, { 'c.txt': 'c\n' }),
  });

  const planTasks = (ids = [1, 2, 3]) =>
    ids.map((n) => ({ task_id: `task-${n}`, task_status: 'completed', plan_version: 1 }));

  interface Call {
    commit: string;
    tier: string | undefined;
    probeOf: string | undefined;
    refAtStart: string;
  }
  let calls: Call[];
  const messageAt = (commit: string): string => repo.git(['log', '-1', '--format=%B', commit]);
  const isR = (commit: string | undefined): boolean =>
    commit !== undefined && isBsRevertCommit(messageAt(commit));
  /** The default runner, recording every call; `hook` may answer a call itself. */
  const runner =
    (
      hook?: (
        i: Parameters<Runner>[0],
        pass: () => ReturnType<Runner>,
      ) => ReturnType<Runner> | undefined,
    ): Runner =>
    (i, ctx, opts) => {
      calls.push({
        commit: i.commit as string,
        tier: i.tier,
        probeOf: i.probeOf,
        refAtStart: repo.head(),
      });
      const pass = () => runIntegrationCheck(i, ctx, opts);
      return hook?.(i, pass) ?? pass();
    };

  const run = async (
    extra: Partial<PostMergeInput> = {},
    opts: { onScratch?: (p: string) => void } = {},
  ) =>
    runPostMerge(
      {
        epicId: repo.epicId,
        projectDir: repo.projectDir,
        checks: [PRE, POST()],
        tasks: planTasks(),
        edges: [],
        events: await repo.events(),
        final: true,
        runner: runner(),
        ...extra,
      },
      repo.ctx(),
      { ...repo.opts(), ...opts },
    );

  const records = async () =>
    (await repo.events()).filter((e) => e.record.event_type === INTEGRATION_CHECK_EVENT);
  const reverted = async () =>
    (await repo.events()).filter((e) => e.record.event_type === WAVE_REVERTED_EVENT);
  const payloadOf = (e: StoredEvent) => e.record.payload as Record<string, unknown>;

  const failedRecord = (name: string, reason?: string): IntegrationCheckRecord => ({
    epicId: repo.epicId,
    branch: repo.branch,
    headSha: repo.head(),
    pass: false,
    results: [
      { name, pass: false, exitCode: reason === undefined ? 1 : -1, reason } as CheckResult,
    ],
    eventId: `${repo.sessionId}#901`,
    ts: '2026-01-01T00:00:00.000Z',
    ...(reason === undefined ? {} : { notRun: [name] }),
  });

  beforeEach(async () => {
    resumeFault.error = null;
    calls = [];
    repo = await createIntegrationRepo();
    counter = path.join(repo.root, 'counter.txt');
  });
  afterEach(async () => {
    await repo.dispose();
  });

  describe('landing a revert', () => {
    it('reverts merge 2 on the ref, records both tiers at R and writes one wave-reverted', async () => {
      const { m2 } = await threeMerges();
      repo.release();
      const oldHead = repo.head();
      const seen: string[] = [];
      const result = await run({}, { onScratch: (p) => seen.push(p) });

      expect(result.outcome).toBe('reverted');
      expect(result.resumed).toBe(false);
      const newHead = repo.head();
      expect(newHead).not.toBe(oldHead);
      expect(result.revert_sha).toBe(newHead);
      expect(repo.git(['rev-parse', `${newHead}^`])).toBe(oldHead);
      // The tree equals the old head without merge 2's change, and nothing else.
      expect(repo.git(['diff', '--name-status', oldHead, newHead])).toBe(
        'D\tbroken.txt\nD\tlib.txt',
      );
      const trailers = trailerValues(messageAt(newHead));
      expect(trailers.get('Bs-Revert-Of')).toBe(m2);
      expect(trailers.get('Bs-Task')).toBe('task-2');
      expect(trailers.get('Bs-Red-Record')).toMatch(/#\d+$/);
      expect(trailers.get('Bs-Failing-Checks')).toBe('post-a');

      const atR = (await records()).filter((e) => payloadOf(e).head_sha === newHead);
      expect(atR.map((e) => payloadOf(e).tiers)).toEqual([['pre-merge'], ['post-merge']]);
      expect(
        atR.every((e) => payloadOf(e).pass === true && payloadOf(e).probe_of === undefined),
      ).toBe(true);
      // Nothing ran after the ref moved: every call started while the ref was at the old head.
      expect(calls.every((c) => c.refAtStart === oldHead)).toBe(true);
      expect(calls.filter((c) => c.commit === newHead).map((c) => c.tier)).toEqual([
        'pre-merge',
        'post-merge',
      ]);

      expect(seen).toHaveLength(1);
      expect(path.dirname(seen[0] as string)).toBe(repo.scratchRoot);
      expect(path.basename(seen[0] as string)).toMatch(
        new RegExp(`^scratch-${process.pid}-[0-9a-f-]{36}$`),
      );
      expect(existsSync(seen[0] as string)).toBe(false);

      const written = await reverted();
      expect(written).toHaveLength(1);
      const w = payloadOf(written[0] as StoredEvent);
      expect(w.disposition).toBe('bounce');
      expect(w.task_ids).toEqual(['task-2']);
      expect(w.revert_sha).toBe(newHead);
      const probes = (await records()).filter((e) => payloadOf(e).probe_of !== undefined);
      expect(probes.length).toBeGreaterThan(0);
      for (const p of probes) expect(w.evidence_event_ids).toContain(p.event_id);
      expect(w.evidence_event_ids).toContain(result.culprits[0]?.red_record_event_id);
      expect(result.culprits).toEqual([
        {
          task: 'task-2',
          merge_sha: m2,
          failing_checks: ['post-a'],
          red_record_event_id: result.culprits[0]?.red_record_event_id,
          reproduced: true,
        },
      ]);
      expect(result.event_ids).toContain(written[0]?.event_id);
    });

    it('reads revert.already-recorded on its own write as recorded', async () => {
      await threeMerges();
      repo.release();
      const racing = runner(async (i, pass) => {
        if (i.tier === 'post-merge' && isR(i.commit)) {
          // Another batch records R while this one is still testing it.
          await recordWaveReverted(
            {
              epic_id: repo.epicId,
              integration_branch: repo.branch,
              revert_sha: i.commit as string,
              disposition: 'record-only',
              reason: 'superseded',
              task_ids: [],
              reverted_merge_sha: null,
              failing_checks: [],
              evidence_event_ids: [],
              log_tail: '',
              evidence: 'unreadable',
            },
            repo.ctx(),
            repo.opts(),
          );
        }
        return pass();
      });
      const result = await run({ runner: racing });
      expect(result.outcome).toBe('reverted');
      expect(repo.head()).toBe(result.revert_sha);
      expect(await reverted()).toHaveLength(1);
    });

    it('fast-forwards a clean worktree that holds the branch', async () => {
      await threeMerges();
      const result = await run();
      expect(result.outcome).toBe('reverted');
      expect(repo.git(['rev-parse', 'HEAD'], repo.builderDir)).toBe(repo.head());
      expect(repo.git(['status', '--porcelain'], repo.builderDir)).toBe('');
    });

    it('refuses a holder with tracked changes: ref unchanged, no wave-reverted', async () => {
      await threeMerges();
      writeFileSync(path.join(repo.builderDir, 'README.md'), 'dirty\n');
      const oldHead = repo.head();
      const result = await run();
      expect(result.outcome).toBe('integration-dirty');
      expect(repo.head()).toBe(oldHead);
      expect(await reverted()).toHaveLength(0);
      expect(result.culprits).toHaveLength(1);
      expect(readFileSync(path.join(repo.builderDir, 'README.md'), 'utf8')).toBe('dirty\n');
    });
  });

  describe('crash after landing', () => {
    it('resumes the landed revert, then proceeds to the normal flow', async () => {
      const { m2 } = await threeMerges();
      const head = await append('integration-check', {
        epic_id: repo.epicId,
        branch: repo.branch,
        head_sha: repo.head(),
        pass: false,
        results: [{ name: 'post-a', pass: false, exitCode: 1, tail: 'boom' }],
      });
      repo.revert(m2, { redRecord: head.event_id, failingChecks: 'post-a' });
      // R certified by the real writer, as an earlier crashed call would have left it.
      const R = repo.head();
      for (const tier of ['pre-merge', 'post-merge'] as const) {
        await runIntegrationCheck(
          {
            epicId: repo.epicId,
            projectDir: repo.projectDir,
            checks: [PRE, POST()],
            tier,
            workspace: 'scratch',
            commit: R,
          },
          repo.ctx(),
          repo.opts(),
        );
      }
      expect(await reverted()).toHaveLength(0);

      const first = await run();
      expect(first.outcome).toBe('reverted');
      expect(first.resumed).toBe(true);
      expect(first.culprits).toEqual([
        {
          task: 'epic-1/task-2',
          merge_sha: m2,
          failing_checks: ['post-a'],
          red_record_event_id: head.event_id,
          reproduced: true,
        },
      ]);
      expect(await reverted()).toHaveLength(1);
      expect(repo.head()).toBe(R);

      const third = await run();
      expect(third.resumed).toBe(false);
      expect(third.outcome).toBe('no-new-merges');
    });

    it('keeps the culprits of the writes a rejecting resume already made', async () => {
      const wrote = [{ culprit: { task: 'epic-1/task-9' }, task: 'epic-1/task-9' }];
      resumeFault.error = Object.assign(new Error('log fault'), { wrote });
      await expect(run()).rejects.toMatchObject({
        message: 'log fault',
        culprits: [{ task: 'epic-1/task-9' }],
      });
    });
  });

  describe('a revert that does not hold', () => {
    it('is revert-red when the revert breaks a pre-merge check, ref unchanged', async () => {
      await mergeTask(1, { 'a.txt': 'a\n' });
      await mergeTask(2, { ...BROKEN, 'lib.txt': 'lib\n' });
      await mergeTask(3, { 'use.txt': 'uses lib\n' });
      repo.release();
      const oldHead = repo.head();
      const result = await run();
      expect(result.outcome).toBe('revert-red');
      expect(repo.head()).toBe(oldHead);
      expect(result.culprits).toHaveLength(1);
      expect(result.revert_sha).toBeDefined();
      expect(await reverted()).toHaveLength(0);
      // The post-merge tier of R never ran after the pre-merge red.
      expect(calls.filter((c) => c.commit === result.revert_sha).map((c) => c.tier)).toEqual([
        'pre-merge',
      ]);
    });

    it('is revert-conflict when a later merge touches the culprit file, with nothing left behind', async () => {
      await mergeTask(1, { 'a.txt': 'a\n' });
      await mergeTask(2, BROKEN);
      await mergeTask(3, { 'broken.txt': 'changed\n' });
      repo.release();
      const oldHead = repo.head();
      const before = repo.worktreeCount();
      const seen: string[] = [];
      const result = await run({}, { onScratch: (p) => seen.push(p) });
      expect(result.outcome).toBe('revert-conflict');
      expect(repo.head()).toBe(oldHead);
      expect(result.culprits).toHaveLength(1);
      expect(repo.worktreeCount()).toBe(before);
      expect(seen).toHaveLength(1);
      expect(existsSync(seen[0] as string)).toBe(false);
      expect(repo.git(['worktree', 'list', '--porcelain'])).not.toContain('REVERT');
      expect(await reverted()).toHaveLength(0);
    });

    it('is integration-moved when the ref moves while R is tested', async () => {
      await threeMerges();
      repo.release();
      const oldHead = repo.head();
      let mover = '';
      const moving = runner((i, pass) => {
        if (i.tier === 'post-merge' && isR(i.commit)) {
          mover = repo.git([
            'commit-tree',
            `${oldHead}^{tree}`,
            '-p',
            oldHead,
            '-m',
            'someone else',
          ]);
          repo.git(['update-ref', `refs/heads/${repo.branch}`, mover]);
        }
        return pass();
      });
      const result = await run({ runner: moving });
      expect(result.outcome).toBe('integration-moved');
      expect(repo.head()).toBe(mover);
      expect(result.culprits).toHaveLength(1);
      expect(await reverted()).toHaveLength(0);
    });

    it('is lock-timeout when R pre-merge run did not run its heavy check', async () => {
      await threeMerges();
      repo.release();
      const oldHead = repo.head();
      const waiting = runner((i) =>
        isR(i.commit) ? Promise.resolve(failedRecord('pre-a', 'heavy.wait-timeout')) : undefined,
      );
      const result = await run({ runner: waiting });
      expect(result.outcome).toBe('lock-timeout');
      expect(repo.head()).toBe(oldHead);
      expect(result.culprits).toHaveLength(1);
      expect(await reverted()).toHaveLength(0);
    });

    it('is setup-failed with step revert when only R setup fails', async () => {
      await threeMerges();
      repo.release();
      const oldHead = repo.head();
      const result = await run({
        setupCmd: 'git log -1 --format=%B | grep -q "^Bs-Revert-Of:" && exit 1; exit 0',
      });
      expect(result.outcome).toBe('setup-failed');
      expect(result.setup_failed).toEqual({ step: 'revert', commit: result.revert_sha });
      expect(repo.head()).toBe(oldHead);
      expect(result.culprits).toHaveLength(1);
      expect(await reverted()).toHaveLength(0);
    });

    it('keeps culprits empty on a setup failure before a culprit is named', async () => {
      await threeMerges();
      const result = await run({ setupCmd: 'exit 1' });
      expect(result.outcome).toBe('setup-failed');
      expect(result.setup_failed).toEqual({ step: 'head', commit: repo.head() });
      expect(result.culprits).toEqual([]);
      expect(result.dependents).toBeUndefined();
    });

    it('keeps culprits empty on a lock wait in the head run', async () => {
      await threeMerges();
      const result = await run({
        runner: runner(() => Promise.resolve(failedRecord('post-a', 'heavy.wait-timeout'))),
      });
      expect(result.outcome).toBe('lock-timeout');
      expect(result.culprits).toEqual([]);
    });

    it('is green with no culprit when nothing is red', async () => {
      await mergeTask(1, { 'a.txt': 'a\n' });
      const result = await run();
      expect(result.outcome).toBe('green');
      expect(result.culprits).toEqual([]);
      expect(result.revert_sha).toBeUndefined();
    });
  });

  describe('outcomes before anything is built', () => {
    it('reports revert-has-dependents with the culprit and builds nothing', async () => {
      await threeMerges();
      repo.release();
      const oldHead = repo.head();
      const seen: string[] = [];
      const result = await run(
        { edges: [{ task: 'task-3', dependsOn: 'task-2' }] },
        { onScratch: (p) => seen.push(p) },
      );
      expect(result.outcome).toBe('revert-has-dependents');
      expect(result.dependents).toEqual(['task-3']);
      expect(result.culprits).toHaveLength(1);
      expect(result.culprits[0]?.task).toBe('task-2');
      expect(result.culprits[0]?.reproduced).toBe(true);
      expect(seen).toHaveLength(0);
      expect(repo.head()).toBe(oldHead);
    });

    it('names a revert-only red as such, not as predating the batch', async () => {
      await mergeTask(1, { 'a.txt': 'a\n' });
      const m2 = await mergeTask(2, { 'b.txt': 'b\n' });
      await mergeTask(3, { 'd.txt': 'needs b\n' });
      // A landed bs revert of merge 2 leaves merge 3's file without what it needs.
      const R = repo.revert(m2);
      repo.release();
      await recordWaveReverted(
        {
          epic_id: repo.epicId,
          integration_branch: repo.branch,
          revert_sha: R,
          disposition: 'record-only',
          reason: 'superseded',
          task_ids: [],
          reverted_merge_sha: null,
          failing_checks: [],
          evidence_event_ids: [],
          log_tail: '',
          evidence: 'unreadable',
        },
        repo.ctx(),
        repo.opts(),
      );
      const result = await run({
        checks: [PRE, { ...POST(), cmd: 'test ! -f d.txt || test -f b.txt' }],
      });
      expect(result.outcome).toBe('red-at-base');
      expect(result.culprits).toEqual([]);
      expect(result.red_after_revert).toEqual([R]);
      expect(result.reason).toContain(R);
      expect(repo.head()).toBe(R);
    });

    describe('amended away', () => {
      it('does not revert a culprit the plan dropped, and re-adding it reverts', async () => {
        await threeMerges();
        repo.release();
        const oldHead = repo.head();
        const seen: string[] = [];
        await append('plan-version-created', { epic_id: repo.epicId, plan_version: 2 });
        const dropped = await run({ tasks: planTasks([1, 3]) }, { onScratch: (p) => seen.push(p) });
        expect(dropped.outcome).toBe('revert-not-applicable');
        expect(dropped.reason).toBe('not-in-live-plan');
        expect(dropped.culprits.map((c) => c.task)).toEqual(['task-2']);
        expect(seen).toHaveLength(0);
        expect(repo.head()).toBe(oldHead);
        expect(await reverted()).toHaveLength(0);

        // A v3 amendment re-adds task 2: its id is live again and the next call reverts.
        const readded = await run({ tasks: planTasks([1, 2, 3]) });
        expect(readded.outcome).toBe('reverted');
        expect(repo.head()).not.toBe(oldHead);
      });

      it('reverts the same repo without the amendment', async () => {
        await threeMerges();
        repo.release();
        const result = await run();
        expect(result.outcome).toBe('reverted');
      });
    });
  });

  describe('pinned branch', () => {
    it('throws postmerge.not-integration-branch before any worktree, leaving main alone', async () => {
      const lone = path.join(repo.root, 'lone');
      runGit(repo.root, ['init', '-q', '-b', repo.branch, lone]);
      const main = repo.git(['rev-parse', 'main']);
      const before = repo.worktreeCount();
      await expect(run({ projectDir: lone })).rejects.toMatchObject({
        code: 'postmerge.not-integration-branch',
      });
      expect(repo.worktreeCount()).toBe(before);
      expect(repo.git(['rev-parse', 'main'])).toBe(main);
    });
  });

  describe('source', () => {
    it('uses no merge-tree --merge-base', () => {
      const src = readFileSync(path.join(import.meta.dirname, '..', 'src', 'postMerge.ts'), 'utf8');
      expect(src).not.toMatch(/merge-tree[^\n]*--merge-base/);
    });
  });
});
