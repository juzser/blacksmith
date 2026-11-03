import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/events.js';
import {
  INTEGRATION_CHECK_EVENT,
  type IntegrationCheckRecord,
  runIntegrationCheck,
} from '../src/integration.js';
import {
  assertIntegrationBranch,
  findPostMergeCulprit,
  heldByPostMerge,
  isBsRevertCommit,
  landedBsReverts,
  POST_MERGE_BATCH,
  type PostMergeInput,
  postMergeBase,
} from '../src/postMergeBisect.js';
import { type CheckCommand, type CheckResult, checkDigest, SLEEP_GAP_MS } from '../src/testgate.js';
import {
  createIntegrationRepo,
  type IntegrationRepo,
  type RevertTrailers,
} from './helpers/integrationRepo.js';
import { git as runGit } from './helpers/process.js';

type Runner = typeof runIntegrationCheck;

describe('post-merge batch', () => {
  let repo: IntegrationRepo;
  let counter: string;
  let flaky: string;

  const BROKEN = { 'broken.txt': 'x\n' };
  const postCheck = (extra: Partial<CheckCommand> = {}): CheckCommand => ({
    name: 'post-a',
    cmd: `echo x >> ${counter}; test ! -f broken.txt`,
    tier: 'post-merge',
    ...extra,
  });
  const runs = (): number =>
    existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0;

  const planTasks = (n: number, status = 'completed') =>
    Array.from({ length: n }, (_, i) => ({
      task_id: `task-${i + 1}`,
      task_status: status,
      plan_version: 1,
    }));
  const inFlight = (taskId: string): StoredEvent =>
    ({
      event_id: `${repo.sessionId}#900`,
      record: {
        event_type: 'wave-admitted',
        plan_version: 1,
        payload: { epic_id: repo.epicId, task_ids: [taskId] },
      },
    }) as unknown as StoredEvent;

  const lineage = (event_type: string, payload: Record<string, unknown>, n: number): StoredEvent =>
    ({
      event_id: `${repo.sessionId}#${910 + n}`,
      record: {
        event_type,
        plan_version: 1,
        ts: `2026-01-01T00:00:0${n}.000Z`,
        session_id: repo.sessionId,
        payload,
      },
    }) as unknown as StoredEvent;
  const admitted = (taskId: string) =>
    lineage('wave-admitted', { epic_id: repo.epicId, task_ids: [taskId] }, 1);
  const escalated = (taskId: string) =>
    lineage(
      'error-logged',
      { task_ref: taskId, error: 'coordination.deadlock', severity: 'S1-blocker' },
      2,
    );
  const mergedEvent = (taskId: string) =>
    lineage('wave-merged', { epic_id: repo.epicId, task_ids: [taskId] }, 3);

  const input = async (extra: Partial<PostMergeInput> = {}): Promise<PostMergeInput> => ({
    epicId: repo.epicId,
    projectDir: repo.projectDir,
    checks: [postCheck()],
    tasks: planTasks(3),
    edges: [],
    events: await repo.events(),
    ...extra,
  });

  const snapshot = () => ({
    ref: repo.git(['rev-parse', repo.branch]),
    main: repo.git(['rev-parse', 'main']),
    head: repo.git(['symbolic-ref', 'HEAD']),
    status: repo.git(['status', '--porcelain']),
    index: createHash('sha256')
      .update(readFileSync(path.join(repo.projectDir, '.git', 'index')))
      .digest('hex'),
  });

  /** One call, with the integration ref and the clone compared before and after. */
  const call = async (extra: Partial<PostMergeInput> = {}) => {
    const before = snapshot();
    const result = await findPostMergeCulprit(await input(extra), repo.ctx(), repo.opts());
    expect(snapshot()).toEqual(before);
    return result;
  };

  const recordsInLog = async () =>
    (await repo.events()).filter((e) => e.record.event_type === INTEGRATION_CHECK_EVENT);
  const payloadOf = (e: StoredEvent) => e.record.payload as Record<string, unknown>;

  /** A passing post-merge record at `commit`, written by task-5's writer. */
  const certify = (commit: string, checks: CheckCommand[] = [postCheck()]) =>
    runIntegrationCheck(
      { epicId: repo.epicId, projectDir: repo.projectDir, checks, workspace: 'scratch', commit },
      repo.ctx(),
      repo.opts(),
    );

  const fakeRecord = (
    results: Partial<CheckResult>[],
    extra: Partial<IntegrationCheckRecord> = {},
  ): IntegrationCheckRecord => ({
    epicId: repo.epicId,
    branch: repo.branch,
    headSha: repo.head(),
    pass: results.every((r) => r.pass === true),
    results: results as CheckResult[],
    eventId: `${repo.sessionId}#901`,
    ts: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
  const failed = (name: string, extra: Partial<CheckResult> = {}): Partial<CheckResult> => ({
    name,
    pass: false,
    exitCode: 1,
    ...extra,
  });
  const notRun = (name: string) =>
    failed(name, { exitCode: -1, reason: 'heavy.wait-timeout', lock_wait_ms: 1 });
  const slept = (name: string) => ({
    name,
    window: 'command' as const,
    wall_ms: 1,
    monotonic_ms: 1,
    clock_gap_ms: SLEEP_GAP_MS,
    load_1m_start: 0,
    load_1m_end: 0,
    cpus: 1,
  });

  beforeEach(async () => {
    repo = await createIntegrationRepo();
    counter = path.join(repo.root, 'counter.txt');
    flaky = path.join(repo.root, 'flaky.txt');
  });
  afterEach(async () => {
    await repo.dispose();
  });

  /** Three task merges where merge 2 breaks the post-merge check. */
  const threeMerges = () => ({
    m1: repo.merge('task-1', { 'a.txt': 'a\n' }),
    m2: repo.merge('task-2', BROKEN),
    m3: repo.merge('task-3', { 'c.txt': 'c\n' }),
  });

  describe('culprit', () => {
    it('names merge 2 and writes every probe with probe_of naming the head run', async () => {
      const { m2 } = threeMerges();
      const result = await call();
      expect(result.outcome).toBe('culprit-found');
      const records = await recordsInLog();
      expect(result.culprit).toEqual({
        task: 'task-2',
        merge_sha: m2,
        failing_checks: ['post-a'],
        red_record_event_id: records[0]?.event_id,
      });
      expect(result.merges.map((m) => m.task)).toEqual(['task-1', 'task-2', 'task-3']);
      expect(result.recordIds).toEqual(records.map((r) => r.event_id));
      expect(payloadOf(records[0] as StoredEvent).probe_of).toBeUndefined();
      // head, reproduce, the unobserved base, then merge 1 and merge 2.
      expect(records).toHaveLength(5);
      for (const probe of records.slice(1)) {
        expect(payloadOf(probe).probe_of).toBe(records[0]?.event_id);
      }
      expect((await repo.events()).some((e) => e.record.event_type === 'wave-reverted')).toBe(
        false,
      );
    });

    it('blames no task when the failure does not reproduce at the head', async () => {
      threeMerges();
      const cmd = `n=$(cat ${flaky} 2>/dev/null || echo 0); echo $((n+1)) > ${flaky}; test $n -ge 1`;
      const result = await call({ checks: [postCheck({ cmd })] });
      // Without the re-run the same fixture would go on to bisect and name merge 3.
      expect(result.outcome).toBe('not-reproduced');
      expect(result.culprit).toBeUndefined();
      expect(await recordsInLog()).toHaveLength(2);
    });

    it('blames no task when the base is not observed green and is red', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      repo.merge('task-2', { 'b.txt': 'b\n' });
      const result = await call({
        checks: [postCheck({ name: 'new-check', cmd: 'test -f never-exists.txt' })],
      });
      expect(result.outcome).toBe('red-at-base');
      expect(result.culprit).toBeUndefined();
      expect(result.baseObserved).toBe(false);
      expect(result.redAfterRevert).toBeUndefined();
    });

    it('does not probe the base when a record certifies it', async () => {
      const { m1, m2 } = threeMerges();
      await certify(repo.forkPoint());
      const result = await call();
      expect(result.outcome).toBe('culprit-found');
      expect(result.baseObserved).toBe(true);
      // The fork point record, the head, the re-run, then probes of merge 1 and merge 2: no base probe.
      const probed = (await recordsInLog()).map((r) => payloadOf(r).head_sha);
      expect(probed).toEqual([repo.forkPoint(), repo.head(), repo.head(), m1, m2]);
    });

    it('reports revert-has-dependents with the same culprit when a later merge depends on it', async () => {
      threeMerges();
      const plain = await call();
      expect(plain.outcome).toBe('culprit-found');
      const withEdge = await call({ edges: [{ task: 'task-3', dependsOn: 'task-2' }] });
      expect(withEdge.outcome).toBe('revert-has-dependents');
      expect(withEdge.dependents).toEqual(['task-3']);
      const own = (r: typeof plain) => ({ ...r.culprit, red_record_event_id: r.recordIds[0] });
      expect(withEdge.culprit).toEqual(own(withEdge));
      expect(plain.culprit).toEqual(own(plain));
      expect({ ...withEdge.culprit, red_record_event_id: '' }).toEqual({
        ...plain.culprit,
        red_record_event_id: '',
      });
      expect(withEdge.culprit?.task).toBe('task-2');
    });

    it('does not list an earlier merge as a dependent', async () => {
      threeMerges();
      const result = await call({ edges: [{ task: 'task-1', dependsOn: 'task-2' }] });
      expect(result.outcome).toBe('culprit-found');
    });

    it('calls a hand commit in the batch foreign, and a bs revert commit not', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      const m2 = repo.merge('task-2', { 'b.txt': 'b\n' });
      const revert = repo.revert(m2);
      repo.merge('task-3', BROKEN);
      const ok = await call();
      expect(ok.outcome).toBe('culprit-found');
      expect(ok.culprit?.task).toBe('task-3');

      const hand = repo.handCommit({ 'h.txt': 'h\n' }, 'hand fix');
      const result = await call();
      expect(result.outcome).toBe('batch-has-foreign-commit');
      expect(result.foreign).toEqual([hand]);
      expect(result.foreign).not.toContain(revert);
      expect(result.culprit).toBeUndefined();
    });

    it('blames no task, and names no foreign commit, when only a landed bs revert turns the head red', async () => {
      const needs: CheckCommand = {
        name: 'post-needs',
        cmd: 'test -f needed.txt',
        tier: 'post-merge',
      };
      const m0 = repo.merge('task-0', { 'needed.txt': 'n\n' });
      await certify(m0, [needs]);
      repo.merge('task-1', { 'a.txt': 'a\n' });
      repo.merge('task-2', { 'b.txt': 'b\n' });
      const revert = repo.revert(m0);
      const result = await call({ checks: [needs] });
      expect(result.outcome).toBe('red-at-base');
      expect(result.culprit).toBeUndefined();
      expect(result.foreign).toBeUndefined();
      expect(result.head).toBe(revert);
      expect(result.redAfterRevert).toEqual([revert]);
    });
  });

  describe('lock and environment', () => {
    it('returns lock-timeout, with no probe, when the head run did not run its heavy check', async () => {
      threeMerges();
      const calls: Parameters<Runner>[0][] = [];
      const runner: Runner = async (i) => {
        calls.push(i);
        return fakeRecord([notRun('post-a')]);
      };
      const result = await call({ runner });
      expect(result.outcome).toBe('lock-timeout');
      expect(result.culprit).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ workspace: 'scratch', commit: repo.head() });
    });

    it('returns lock-timeout when only a bisect probe did not run', async () => {
      const { m1 } = threeMerges();
      const runner: Runner = (i, ctx, opts) =>
        i.commit === m1
          ? Promise.resolve(fakeRecord([notRun('post-a')]))
          : runIntegrationCheck(i, ctx, opts);
      const result = await call({ runner });
      expect(result.outcome).toBe('lock-timeout');
      expect(result.culprit).toBeUndefined();
    });

    it('returns lock-timeout when the re-run at the head did not run', async () => {
      threeMerges();
      let n = 0;
      const runner: Runner = (i, ctx, opts) =>
        ++n === 2
          ? Promise.resolve(fakeRecord([notRun('post-a')], { probeOf: i.probeOf as string }))
          : runIntegrationCheck(i, ctx, opts);
      expect((await call({ runner })).outcome).toBe('lock-timeout');
    });

    it('returns lock-timeout when the base probe did not run', async () => {
      threeMerges();
      const runner: Runner = (i, ctx, opts) =>
        i.commit === repo.forkPoint()
          ? Promise.resolve(fakeRecord([notRun('post-a')]))
          : runIntegrationCheck(i, ctx, opts);
      expect((await call({ runner })).outcome).toBe('lock-timeout');
    });

    it('returns env-failure when the only failed result slept', async () => {
      threeMerges();
      let n = 0;
      const runner: Runner = async () => {
        n += 1;
        return fakeRecord([failed('post-a')], {
          environment: [slept('post-a')],
          errorClass: 'execution.env-failure',
          environmentEvidence: [slept('post-a')],
        });
      };
      const result = await call({ runner });
      expect(result.outcome).toBe('env-failure');
      expect(result.culprit).toBeUndefined();
      expect(n).toBe(1);
    });

    it('decides env-failure per result, never by the record-level errorClass', async () => {
      threeMerges();
      const seen: Parameters<Runner>[0][] = [];
      const checks = [postCheck({ name: 'post-a' }), postCheck({ name: 'post-b' })];
      const runner: Runner = async (i) => {
        seen.push(i);
        if (i.probeOf !== undefined) return fakeRecord([{ name: 'post-a', pass: true }]);
        return fakeRecord([failed('post-a'), failed('post-b')], {
          environment: [slept('post-a'), { ...slept('post-b'), clock_gap_ms: 0 }],
          errorClass: 'execution.env-failure',
          environmentEvidence: [slept('post-a')],
        });
      };
      const result = await call({ checks, runner });
      expect(result.outcome).toBe('not-reproduced');
      expect(seen).toHaveLength(2);
      expect(seen[1]).toMatchObject({ probeOf: `${repo.sessionId}#901`, commit: repo.head() });
      expect(seen[1]?.checks.map((c) => c.name)).toEqual(['post-a', 'post-b']);
    });
  });

  describe('trigger', () => {
    it('is not ready with two merges and a task in flight', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      repo.merge('task-2', { 'b.txt': 'b\n' });
      const before = repo.worktreeCount();
      const result = await call({
        tasks: [
          ...planTasks(2),
          { task_id: 'task-9', task_status: 'in-progress', plan_version: 1 },
        ],
        events: [inFlight('task-9')],
      });
      expect(result.outcome).toBe('batch-not-ready');
      expect(repo.worktreeCount()).toBe(before);
      expect(runs()).toBe(0);
      expect(await recordsInLog()).toHaveLength(0);
    });

    it('runs when a todo task depends on an uncertified merge', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      repo.merge('task-2', { 'b.txt': 'b\n' });
      const result = await call({
        tasks: [
          ...planTasks(2),
          { task_id: 'task-9', task_status: 'in-progress', plan_version: 1 },
          { task_id: 'task-5', task_status: 'todo', plan_version: 1 },
        ],
        edges: [{ task: 'task-5', dependsOn: 'task-1' }],
        events: [inFlight('task-9')],
      });
      expect(result.outcome).toBe('green');
      expect(runs()).toBe(1);
    });

    it('runs when the only task in flight is held open by an operator', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      repo.merge('task-2', { 'b.txt': 'b\n' });
      const result = await call({
        tasks: [
          ...planTasks(2),
          { task_id: 'task-9', task_status: 'in-progress', plan_version: 1 },
        ],
        events: [admitted('task-9'), escalated('task-9')],
      });
      expect(result.outcome).toBe('green');
    });

    it('reads the folded status, not the plan record: an admitted task is not idle', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      repo.merge('task-2', { 'b.txt': 'b\n' });
      const result = await call({
        tasks: [...planTasks(2), { task_id: 'task-9', task_status: 'escalated', plan_version: 1 }],
        events: [admitted('task-9')],
      });
      expect(result.outcome).toBe('batch-not-ready');
    });

    it('does not hold a merged task whose plan record still says todo', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      repo.merge('task-5', { 'b.txt': 'b\n' });
      const result = await call({
        tasks: [
          { task_id: 'task-1', task_status: 'completed', plan_version: 1 },
          { task_id: 'task-5', task_status: 'todo', plan_version: 1 },
          { task_id: 'task-9', task_status: 'in-progress', plan_version: 1 },
        ],
        edges: [{ task: 'task-5', dependsOn: 'task-1' }],
        events: [admitted('task-9'), mergedEvent('task-5')],
      });
      expect(result.outcome).toBe('batch-not-ready');
    });

    it('runs at the batch size even with a task in flight', async () => {
      for (let i = 1; i <= POST_MERGE_BATCH; i++) repo.merge(`task-${i}`, { [`f${i}.txt`]: 'x' });
      const tasks = [
        ...planTasks(POST_MERGE_BATCH),
        { task_id: 'task-9', task_status: 'in-progress', plan_version: 1 },
      ];
      expect((await call({ tasks, events: [inFlight('task-9')] })).outcome).toBe('green');
    });

    it('stays not ready one merge below the batch size', async () => {
      for (let i = 1; i < POST_MERGE_BATCH; i++) repo.merge(`task-${i}`, { [`f${i}.txt`]: 'x' });
      const tasks = [
        ...planTasks(POST_MERGE_BATCH - 1),
        { task_id: 'task-9', task_status: 'in-progress', plan_version: 1 },
      ];
      expect((await call({ tasks, events: [inFlight('task-9')] })).outcome).toBe('batch-not-ready');
    });

    it('runs with --final and a task in flight, and never returns batch-not-ready', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      const result = await call({
        final: true,
        tasks: [
          ...planTasks(1),
          { task_id: 'task-9', task_status: 'in-progress', plan_version: 1 },
        ],
        events: [inFlight('task-9')],
      });
      expect(result.outcome).toBe('green');
    });

    it('returns no-new-merges for --final at a head already certified, and runs nothing', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      await certify(repo.head());
      const before = runs();
      const result = await call({ final: true });
      expect(result.outcome).toBe('no-new-merges');
      expect(runs()).toBe(before);
      expect(await recordsInLog()).toHaveLength(1);
    });

    it('keeps the dependency arm and the hold on one function', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      const held = heldByPostMerge({
        tasks: [{ task_id: 'task-5', task_status: 'todo' }],
        edges: [{ task: 'task-5', dependsOn: 'task-1' }],
        statusOf: () => 'todo',
        uncertifiedMerges: (await postMergeBase(await input())).merges,
        hasPostMergeChecks: true,
      });
      expect([...held.keys()]).toEqual(['task-5']);
    });
  });

  describe('base', () => {
    it('is the latest ancestor certified for every post-merge check', async () => {
      const { m1, m2, m3 } = threeMerges();
      await certify(m1);
      const base = await postMergeBase(await input());
      expect(base).toMatchObject({ base: m1, observed: true, head: m3 });
      expect(base.merges).toEqual([
        { task: 'task-2', merge_sha: m2 },
        { task: 'task-3', merge_sha: m3 },
      ]);
    });

    it('is the fork point, unobserved, when nothing is certified', async () => {
      threeMerges();
      const base = await postMergeBase(await input());
      expect(base).toMatchObject({ base: repo.forkPoint(), observed: false });
      expect(base.merges).toHaveLength(3);
    });

    it('does not accept a pass for another command as certification', async () => {
      const { m1 } = threeMerges();
      await certify(m1, [postCheck({ cmd: 'true' })]);
      expect((await postMergeBase(await input())).base).toBe(repo.forkPoint());
    });

    it('runs after a post-merge command is edited, and not after a tier move', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      await certify(repo.head());
      expect((await call()).outcome).toBe('no-new-merges');
      expect(checkDigest(postCheck())).not.toBe(checkDigest(postCheck({ cmd: 'true' })));
      const edited = await call({ checks: [postCheck({ cmd: `echo x >> ${counter}; true` })] });
      expect(edited.outcome).toBe('green');

      const pre: CheckCommand = { name: 'pre-b', cmd: 'true' };
      await certify(repo.head(), [postCheck(), pre]);
      const moved = await call({ checks: [postCheck(), { ...pre, tier: 'post-merge' }] });
      expect(moved.outcome).toBe('no-new-merges');
    });

    it('is not the base when the head failed its check', async () => {
      const { m1 } = threeMerges();
      await certify(m1);
      await certify(repo.head());
      const base = await postMergeBase(await input());
      expect(base.base).toBe(m1);
    });
  });

  describe('landedBsReverts', () => {
    it('finds a revert that is the base and one older than it, and ignores hand commits', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      const m2 = repo.merge('task-2', { 'b.txt': 'b\n' });
      const older = repo.revert(m2);
      repo.handCommit({ 'h.txt': 'h\n' }, 'mentions Bs-Revert-Of: in prose only');
      const m3 = repo.merge('task-3', { 'c.txt': 'c\n' });
      const newer = repo.revert(m3);
      await certify(newer);
      const base = await postMergeBase(await input());
      expect(base.base).toBe(newer);
      const found = landedBsReverts(repo.projectDir, repo.epicId);
      expect(found.map((r) => r.sha)).toEqual([older, newer]);
    });

    it('returns a revert whose other trailers are malformed', async () => {
      const m1 = repo.merge('task-1', { 'a.txt': 'a\n' });
      const bad = repo.revert(m1, { task: null, redRecord: 'not an id', failingChecks: '' });
      const found = landedBsReverts(repo.projectDir, repo.epicId);
      expect(found.map((r) => r.sha)).toEqual([bad]);
    });

    it('refuses a branch that is not the integration branch', async () => {
      expect(() => landedBsReverts(repo.projectDir, 'a/b')).toThrow(
        expect.objectContaining({ code: 'postmerge.not-integration-branch' }),
      );
    });

    it('recognises the trailer only in the final paragraph', () => {
      expect(isBsRevertCommit('Revert x\n\nBs-Revert-Of: abc\nBs-Task: t')).toBe(true);
      expect(isBsRevertCommit('Revert x\n\nBs-Task: t')).toBe(false);
      expect(isBsRevertCommit('Bs-Revert-Of: abc\n\nnothing else')).toBe(false);
      expect(isBsRevertCommit('Revert x\n\nBs-Revert-Of: \n')).toBe(true);
    });
  });

  describe('builder trailers', () => {
    const message = (sha: string) => repo.git(['log', '-1', '--format=%B', sha]);

    it('writes four valid trailers by default', () => {
      const m = repo.merge('task-1', { 'a.txt': 'a\n' });
      const text = message(repo.revert(m));
      expect(text).toContain(`Bs-Revert-Of: ${m}`);
      expect(text).toContain('Bs-Task: task-1');
      expect(text).toMatch(/^Bs-Red-Record: \S+#\d+$/m);
      expect(text).toMatch(/^Bs-Failing-Checks: \S+$/m);
    });

    it('writes exactly the one trailer a call overrides or omits', () => {
      const whole = (merge: string, task: string, trailers: Record<string, string | null> = {}) => {
        const values: Record<string, string | null> = {
          'Bs-Revert-Of': merge,
          'Bs-Task': task,
          'Bs-Red-Record': `${repo.sessionId}#0`,
          'Bs-Failing-Checks': 'post-check',
          ...trailers,
        };
        const lines = Object.entries(values).flatMap(([k, v]) =>
          v === null ? [] : [`${k}: ${v}`],
        );
        return [`Revert "Merge ${task} into ${repo.branch}"`, '', ...lines].join('\n');
      };
      const trimmed = (sha: string) => message(sha).trimEnd();
      const cases: [string, Record<string, string | null>, RevertTrailers][] = [
        ['Bs-Revert-Of', { 'Bs-Revert-Of': 'xyz' }, { revertOf: 'xyz' }],
        ['Bs-Task', { 'Bs-Task': 'task-ghost' }, { task: 'task-ghost' }],
        ['Bs-Red-Record', { 'Bs-Red-Record': 'nope' }, { redRecord: 'nope' }],
        ['Bs-Failing-Checks', { 'Bs-Failing-Checks': '' }, { failingChecks: '' }],
        ['Bs-Revert-Of', { 'Bs-Revert-Of': null }, { revertOf: null }],
        ['Bs-Task', { 'Bs-Task': null }, { task: null }],
        ['Bs-Red-Record', { 'Bs-Red-Record': null }, { redRecord: null }],
        ['Bs-Failing-Checks', { 'Bs-Failing-Checks': null }, { failingChecks: null }],
      ];
      cases.forEach(([, expected, given], i) => {
        const task = `task-${i + 1}`;
        const m = repo.merge(task, { [`f${i}.txt`]: 'x' });
        expect(trimmed(repo.revert(m, given))).toBe(whole(m, task, expected).trimEnd());
      });
    });
  });

  describe('other outcomes', () => {
    it('returns no-checks-in-tier and creates nothing', async () => {
      threeMerges();
      const before = repo.worktreeCount();
      const result = await call({ checks: [{ name: 'only-pre', cmd: 'true' }] });
      expect(result.outcome).toBe('no-checks-in-tier');
      expect(repo.worktreeCount()).toBe(before);
      expect(await recordsInLog()).toHaveLength(0);
    });

    it('returns setup-failed from the default runner at the head, with no record', async () => {
      threeMerges();
      const result = await call({ setupCmd: 'exit 1' });
      expect(result.outcome).toBe('setup-failed');
      expect(result.step).toBe('head');
      expect(result.commit).toBe(repo.head());
      expect(result.culprit).toBeUndefined();
      expect(await recordsInLog()).toHaveLength(0);
    });

    it('returns green for a passing head and certifies it', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      const result = await call();
      expect(result.outcome).toBe('green');
      expect(result.recordIds).toHaveLength(1);
      expect((await call()).outcome).toBe('no-new-merges');
    });
  });

  describe('assertIntegrationBranch', () => {
    it('returns the derived branch for an epic with the integration shape', () => {
      expect(assertIntegrationBranch(repo.projectDir, repo.epicId).branch).toBe(repo.branch);
    });

    it('refuses an epic whose branch lacks the /integration shape', async () => {
      const before = repo.worktreeCount();
      expect(() => assertIntegrationBranch(repo.projectDir, 'a/b')).toThrow(
        expect.objectContaining({ code: 'postmerge.not-integration-branch' }),
      );
      await expect(call({ epicId: 'a/b' })).rejects.toMatchObject({
        code: 'postmerge.not-integration-branch',
      });
      expect(repo.worktreeCount()).toBe(before);
    });

    it('resolves master as the default with the integration branch checked out, no remote', () => {
      const lone = path.join(repo.root, 'no-remote');
      runGit(repo.root, ['init', '-q', '-b', 'master', lone]);
      runGit(lone, [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ]);
      runGit(lone, ['checkout', '-q', '-b', repo.branch]);
      expect(assertIntegrationBranch(lone, repo.epicId)).toEqual({
        branch: repo.branch,
        defaultBranch: 'master',
      });
    });

    it('refuses when the derived branch is the default branch', async () => {
      const lone = path.join(repo.root, 'lone');
      runGit(repo.root, ['init', '-q', '-b', repo.branch, lone]);
      runGit(lone, [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ]);
      // The only way a remote-less project names a factory branch its default.
      runGit(lone, ['config', 'init.defaultBranch', repo.branch]);
      expect(() => assertIntegrationBranch(lone, repo.epicId)).toThrow(
        expect.objectContaining({ code: 'postmerge.not-integration-branch' }),
      );
    });
  });

  describe('heldByPostMerge', () => {
    const tasksCD = [
      { task_id: 'task-c', task_status: 'todo' },
      { task_id: 'task-d', task_status: 'todo' },
    ];
    const edges = [{ task: 'task-c', dependsOn: 'task-a' }];
    const status = (tasks: { task_id: string; task_status: string }[]) => (id: string) =>
      tasks.find((t) => t.task_id === id)?.task_status ?? 'todo';

    it('lists exactly the not-admitted dependents of an uncertified merge', async () => {
      const a = repo.merge('task-a', { 'a.txt': 'a\n' });
      repo.merge('task-b', { 'b.txt': 'b\n' });
      const merges = (await postMergeBase(await input())).merges;
      const held = heldByPostMerge({
        tasks: tasksCD,
        edges,
        statusOf: status(tasksCD),
        uncertifiedMerges: merges,
        hasPostMergeChecks: true,
      });
      expect([...held.entries()]).toEqual([['task-c', ['task-a']]]);
      expect(merges[0]).toEqual({ task: 'task-a', merge_sha: a });
    });

    it('lists nothing once the head is certified', async () => {
      repo.merge('task-a', { 'a.txt': 'a\n' });
      repo.merge('task-b', { 'b.txt': 'b\n' });
      await certify(repo.head());
      const merges = (await postMergeBase(await input())).merges;
      expect(merges).toEqual([]);
      const held = heldByPostMerge({
        tasks: tasksCD,
        edges,
        statusOf: status(tasksCD),
        uncertifiedMerges: merges,
        hasPostMergeChecks: true,
      });
      expect(held.size).toBe(0);
    });

    it('lists nothing when the checks hold no post-merge entry', async () => {
      repo.merge('task-a', { 'a.txt': 'a\n' });
      const merges = (await postMergeBase(await input())).merges;
      const held = heldByPostMerge({
        tasks: tasksCD,
        edges,
        statusOf: status(tasksCD),
        uncertifiedMerges: merges,
        hasPostMergeChecks: false,
      });
      expect(held.size).toBe(0);
    });

    it('never lists an admitted dependent', async () => {
      repo.merge('task-a', { 'a.txt': 'a\n' });
      const merges = (await postMergeBase(await input())).merges;
      const admitted = [{ task_id: 'task-c', task_status: 'in-progress' }, tasksCD[1] as never];
      const held = heldByPostMerge({
        tasks: admitted,
        edges,
        statusOf: status(admitted),
        uncertifiedMerges: merges,
        hasPostMergeChecks: true,
      });
      expect(held.size).toBe(0);
    });

    it('matches a qualified task id to a bare one', () => {
      const held = heldByPostMerge({
        tasks: [{ task_id: 'epic-1/task-c', task_status: 'ready' }],
        edges: [{ task: 'epic-1/task-c', dependsOn: 'epic-1/task-a' }],
        statusOf: () => 'ready',
        uncertifiedMerges: [{ task: 'task-a', merge_sha: 'f'.repeat(40) }],
        hasPostMergeChecks: true,
      });
      expect([...held.entries()]).toEqual([['epic-1/task-c', ['task-a']]]);
    });
  });

  describe('a probe whose setup fails', () => {
    const setupLog = () => path.join(repo.root, 'setup.log');
    const logged = (): string[] =>
      existsSync(setupLog()) ? readFileSync(setupLog(), 'utf8').split('\n').filter(Boolean) : [];
    const noRevert = async () =>
      expect((await repo.events()).some((e) => e.record.event_type === 'wave-reverted')).toBe(
        false,
      );
    const everyProbeNamesTheHead = async (recordIds: string[]) => {
      const [head, ...probeIds] = recordIds;
      const probes = (await recordsInLog()).filter((r) => probeIds.includes(r.event_id));
      expect(probes).toHaveLength(probeIds.length);
      for (const p of probes) expect(payloadOf(p).probe_of).toBe(head);
    };

    it('ends the call at step bisect with the failing prefix', async () => {
      const { m1 } = threeMerges();
      await certify(repo.forkPoint());
      const setupCmd = `git rev-parse HEAD >> ${setupLog()}; test -f c.txt`;
      const result = await call({ setupCmd });
      expect(result.outcome).toBe('setup-failed');
      expect(result.step).toBe('bisect');
      expect(result.commit).toBe(m1);
      expect(result.culprit).toBeUndefined();
      const records = await recordsInLog();
      // The fork point certification, then the red head record, then the reproduce probe.
      expect(result.recordIds).toContain(records[1]?.event_id);
      expect(logged()).toEqual([repo.head(), repo.head(), m1]);
      await everyProbeNamesTheHead(result.recordIds);
      await noRevert();
    });

    it('ends the call at step reproduce with the head commit', async () => {
      threeMerges();
      await certify(repo.forkPoint());
      const second = path.join(repo.root, 'second.txt');
      const setupCmd = `git rev-parse HEAD >> ${setupLog()}; n=$(cat ${second} 2>/dev/null || echo 0); echo $((n+1)) > ${second}; test $n -lt 1`;
      const result = await call({ setupCmd });
      expect(result).toMatchObject({ outcome: 'setup-failed', step: 'reproduce' });
      expect(result.commit).toBe(repo.head());
      expect(logged()).toEqual([repo.head(), repo.head()]);
      expect(result.recordIds).toHaveLength(1);
      await everyProbeNamesTheHead(result.recordIds);
      await noRevert();
    });

    it('ends the call at step base with the fork point', async () => {
      threeMerges();
      const setupCmd = `git rev-parse HEAD >> ${setupLog()}; test -f a.txt`;
      const result = await call({ setupCmd });
      expect(result).toMatchObject({ outcome: 'setup-failed', step: 'base' });
      expect(result.commit).toBe(repo.forkPoint());
      expect(logged()).toEqual([repo.head(), repo.head(), repo.forkPoint()]);
      expect(result.recordIds).toHaveLength(2);
      await everyProbeNamesTheHead(result.recordIds);
      await noRevert();
    });

    it('lets an error that is not a setup failure propagate', async () => {
      threeMerges();
      const runner: Runner = async () => {
        throw new Error('boom');
      };
      await expect(call({ runner })).rejects.toThrow('boom');
    });
  });
});
