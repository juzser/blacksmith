import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { foldTasks } from '../src/db/projector.js';
import { appendEvent, type StoredEvent } from '../src/events.js';
import { GitCommandError } from '../src/git.js';
import { runIntegrationCheck } from '../src/integration.js';
import { isBsRevertCommit } from '../src/postMergeBisect.js';
import {
  type ResumeInput,
  type ResumeResult,
  resumeLandedReverts,
  trailerValues,
} from '../src/postMergeResume.js';
import { RECORD_ONLY_REASONS, WAVE_REVERTED_EVENT } from '../src/revert.js';
import type { CheckCommand } from '../src/testgate.js';
import {
  createIntegrationRepo,
  type IntegrationRepo,
  type RevertTrailers,
} from './helpers/integrationRepo.js';

// The projector never folds a task to `waived`, `failed` or `escalated` once a
// `wave-merged` names it (finding d3d30c6d), so the two fixtures for those
// blocker reasons replace the fold, as task-2's own tests do. Every other
// fixture folds the real log.
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

// A switch to make one git subcommand fail the way an infrastructure fault does
// (an unwritable object store, a lock): exit 128 with no claim about the data.
// `passes` lets that many matching calls through before the fault starts.
const gitFault = vi.hoisted(() => ({ subcommand: null as string | null, passes: 0 }));
vi.mock('../src/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/git.js')>();
  return {
    ...actual,
    runGit: (cwd: string, args: string[]) => {
      if (gitFault.subcommand !== null && args.includes(gitFault.subcommand)) {
        if (gitFault.passes > 0) {
          gitFault.passes -= 1;
          return actual.runGit(cwd, args);
        }
        throw new actual.GitCommandError(cwd, args, 128, 'fatal: unable to write object');
      }
      return actual.runGit(cwd, args);
    },
    writeMergeTree: (cwd: string, base: string, head: string) => {
      if (gitFault.subcommand === 'merge-tree') {
        throw new actual.GitCommandError(cwd, ['merge-tree'], 128, 'fatal: unable to write object');
      }
      return actual.writeMergeTree(cwd, base, head);
    },
  };
});

const PRE: CheckCommand = { name: 'pre-a', cmd: 'true' };
const POST: CheckCommand = { name: 'post-a', cmd: 'true', tier: 'post-merge' };
const T1 = 'epic-1/task-1';
const T2 = 'epic-1/task-2';

describe('post-merge resume', () => {
  let repo: IntegrationRepo;

  beforeEach(async () => {
    override.status = null;
    gitFault.subcommand = null;
    gitFault.passes = 0;
    repo = await createIntegrationRepo();
  });
  afterEach(async () => {
    override.status = null;
    gitFault.subcommand = null;
    gitFault.passes = 0;
    await repo.dispose();
  });

  const append = async (
    event_type: string,
    payload: Record<string, unknown>,
    task_id?: string,
  ): Promise<StoredEvent> =>
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
  const admit = (task: string) =>
    append('wave-admitted', { epic_id: repo.epicId, task_ids: [task] }, task);
  const recordMerge = (task: string, mergeSha?: string) =>
    append(
      'wave-merged',
      {
        epic_id: repo.epicId,
        task_ids: [task],
        ...(mergeSha === undefined ? {} : { merge_sha: mergeSha }),
      },
      task,
    );
  /** The red post-merge record a revert's `Bs-Red-Record` names. */
  const redRecord = async (): Promise<string> =>
    (
      await append('integration-check', {
        epic_id: repo.epicId,
        branch: repo.branch,
        head_sha: repo.head(),
        pass: false,
        results: [{ name: 'post-a', pass: false, exitCode: 1, tail: 'boom: post-a failed' }],
      })
    ).event_id;

  const certify = (commit: string, checks: CheckCommand[] = [PRE, POST], probeOf?: string) =>
    runIntegrationCheck(
      {
        epicId: repo.epicId,
        projectDir: repo.projectDir,
        checks,
        workspace: 'scratch',
        commit,
        ...(probeOf === undefined ? {} : { probeOf }),
      },
      repo.ctx(),
      repo.opts(),
    );

  interface Landed {
    merge: string;
    revert: string;
    red: string;
  }
  /**
   * A task merged and logged, then reverted by a genuine bs revert commit,
   * with the pre-merge and post-merge records task-12 writes at it unless
   * `records` says otherwise.
   */
  const landed = async (
    task = 'task-1',
    opts: {
      trailers?: RevertTrailers;
      records?: 'both' | 'none';
      admitted?: boolean;
      merged?: boolean;
      file?: string;
    } = {},
  ): Promise<Landed> => {
    const qualified = `${repo.epicId}/${task}`;
    if (opts.admitted !== false) await admit(qualified);
    const merge = repo.merge(task, { [opts.file ?? `${task}.txt`]: `${task}\n` });
    if (opts.merged !== false) await recordMerge(qualified, merge);
    const red = await redRecord();
    const revert = repo.revert(merge, {
      redRecord: red,
      failingChecks: 'post-a',
      ...opts.trailers,
    });
    if (opts.records !== 'none') await certify(revert);
    return { merge, revert, red };
  };

  const input = async (extra: Partial<ResumeInput> = {}): Promise<ResumeInput> => ({
    projectDir: repo.projectDir,
    epicId: repo.epicId,
    integration: { branch: repo.branch },
    events: await repo.events(),
    liveTaskIds: [T1, T2],
    ...extra,
  });

  /**
   * Everything a resume must leave alone: the integration ref, main, every ref,
   * the clone's HEAD, its status, the tree its index writes and the tree of its
   * worktree. The worktree tree is hashed through a throwaway copy of the
   * index, so taking the snapshot touches nothing.
   */
  const snapshot = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'resume-snap-'));
    try {
      const tmpIndex = path.join(dir, 'index');
      copyFileSync(path.join(repo.projectDir, '.git', 'index'), tmpIndex);
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      const inTmp = (...args: string[]) =>
        execFileSync('git', args, { cwd: repo.projectDir, env, encoding: 'utf8' }).trim();
      inTmp('add', '--all');
      return {
        ref: repo.git(['rev-parse', repo.branch]),
        main: repo.git(['rev-parse', 'main']),
        refs: repo.git(['for-each-ref']),
        head: repo.git(['symbolic-ref', 'HEAD']),
        headSha: repo.git(['rev-parse', 'HEAD']),
        status: repo.git(['status', '--porcelain=v2', '--branch']),
        indexTree: repo.git(['write-tree']),
        worktreeTree: inTmp('write-tree'),
        index: createHash('sha256')
          .update(readFileSync(path.join(repo.projectDir, '.git', 'index')))
          .digest('hex'),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /** One call, with the integration ref and the clone compared before and after. */
  const resume = async (extra: Partial<ResumeInput> = {}): Promise<ResumeResult> => {
    const before = snapshot();
    const result = await resumeLandedReverts(await input(extra), repo.ctx(), repo.opts());
    expect(snapshot()).toEqual(before);
    return result;
  };

  const reverted = async () =>
    (await repo.events()).filter((e) => e.record.event_type === WAVE_REVERTED_EVENT);
  const payloadOf = (e: StoredEvent) => e.record.payload as Record<string, unknown>;
  const statusOf = async (task = T1) =>
    foldTasks(await repo.events()).find((r) => r.taskId === task)?.taskStatus;

  /** Run the resume and assert it wrote exactly one record-only event with `reason`. */
  const expectRecordOnly = async (reason: string, extra: Partial<ResumeInput> = {}) => {
    const before = await statusOf();
    const result = await resume(extra);
    expect(result.outcome).toBe('revert-recorded');
    expect(result.wrote).toHaveLength(1);
    expect(result.wrote[0]).toMatchObject({ disposition: 'record-only', reason });
    const events = await reverted();
    expect(events).toHaveLength(1);
    expect(payloadOf(events[0] as StoredEvent)).toMatchObject({
      disposition: 'record-only',
      reason,
    });
    expect(await statusOf()).toBe(before);
    return { result, event: payloadOf(events[0] as StoredEvent) };
  };

  describe('bounce', () => {
    it('writes one bounce for a completed task and reopens it', async () => {
      await landed('task-1');
      await landed('task-2');
      expect(await statusOf()).toBe('completed');
      const result = await resume();
      expect(result.outcome).toBe('reverted');
      expect(result.resumed).toBe(true);
      expect(result.wrote.map((w) => [w.task, w.disposition])).toEqual([
        [T1, 'bounce'],
        [T2, 'bounce'],
      ]);
      expect(await reverted()).toHaveLength(2);
      expect(await statusOf()).toBe('todo');
      expect(await statusOf(T2)).toBe('todo');
    });

    it('takes the log tail and evidence from the readable red record', async () => {
      const l = await landed('task-1');
      await resume();
      const [event] = await reverted();
      expect(payloadOf(event as StoredEvent)).toMatchObject({
        epic_id: repo.epicId,
        integration_branch: repo.branch,
        revert_sha: l.revert,
        reverted_merge_sha: l.merge,
        disposition: 'bounce',
        task_ids: [T1],
        failing_checks: ['post-a'],
        evidence_event_ids: [l.red],
        red_record_event_id: l.red,
        evidence: 'record',
        resumed: true,
      });
      expect(String(payloadOf(event as StoredEvent).log_tail)).toContain('boom: post-a failed');
    });

    it('writes a bounce, never re-merged, though the original merge carries the reverted sha', async () => {
      const l = await landed('task-1');
      const events = await repo.events();
      const original = events.find((e) => e.record.event_type === 'wave-merged');
      expect(payloadOf(original as StoredEvent).merge_sha).toBe(l.merge);
      const result = await resume();
      expect(result.wrote[0]?.disposition).toBe('bounce');
      expect(result.wrote[0]?.reason).toBeUndefined();
    });

    it('accepts a tested revert whose records are two separate runs, one per tier', async () => {
      const l = await landed('task-1', { records: 'none' });
      await certify(l.revert, [PRE]);
      await certify(l.revert, [POST]);
      expect((await resume()).wrote[0]?.disposition).toBe('bounce');
    });

    it('finds a revert that is the latest certified commit and one older than the base', async () => {
      const first = await landed('task-1');
      const second = await landed('task-2');
      const result = await resume();
      expect(result.wrote.map((w) => w.revert_sha)).toEqual([first.revert, second.revert]);
    });
  });

  describe('record-only exits', () => {
    it('superseded after the revert', async () => {
      await landed('task-1');
      await append('task-superseded', {}, T1);
      await expectRecordOnly('superseded');
    });

    it('waived', async () => {
      await landed('task-1');
      override.status = 'waived';
      await expectRecordOnly('waived');
    });

    it.each(['escalated', 'failed'])('held-by-operator for a %s task', async (status) => {
      await landed('task-1');
      override.status = status;
      await expectRecordOnly('held-by-operator');
    });

    it('re-merged: a later wave-merged whose merge_sha has the revert as an ancestor', async () => {
      await landed('task-1');
      const again = repo.merge('task-1-again', { 'again.txt': 'again\n' });
      await recordMerge(T1, again);
      const { result } = await expectRecordOnly('re-merged');
      expect(result.wrote[0]?.culprit).toBeDefined();
    });

    it('unknown-task: a Bs-Task the lineage never saw', async () => {
      await admit(T1);
      const merge = repo.merge('task-1', { 'a.txt': 'a\n' });
      await recordMerge(T1, merge);
      const red = await redRecord();
      const revert = repo.revert(merge, { redRecord: red, task: 'epic-1/task-ghost' });
      await certify(revert);
      const { result } = await expectRecordOnly('unknown-task');
      expect(result.wrote[0]?.culprit).toBeUndefined();
    });

    it('not-merged: a known task with no wave-merged', async () => {
      await landed('task-1', { merged: false });
      const { result } = await expectRecordOnly('not-merged');
      expect(result.wrote[0]?.culprit).toBeUndefined();
    });

    it('not-merged: a task known only by its task-added event', async () => {
      await append('task-added', { epic_id: repo.epicId }, T1);
      const merge = repo.merge('task-1', { 'a.txt': 'a\n' });
      const red = await redRecord();
      await certify(repo.revert(merge, { redRecord: red, failingChecks: 'post-a' }));
      const { result } = await expectRecordOnly('not-merged');
      expect(result.wrote[0]?.task).toBe(T1);
    });

    it('unknown-task: the name is known only to a different epic', async () => {
      await append('wave-admitted', { epic_id: 'epic-other', task_ids: [T1] }, T1);
      const merge = repo.merge('task-1', { 'a.txt': 'a\n' });
      const red = await redRecord();
      await certify(repo.revert(merge, { redRecord: red, failingChecks: 'post-a' }));
      await expectRecordOnly('unknown-task');
    });

    it('not-in-live-plan: merged and completed, but the plan dropped it', async () => {
      await landed('task-1');
      const { result } = await expectRecordOnly('not-in-live-plan', { liveTaskIds: [T2] });
      expect(result.wrote[0]?.culprit).toBeDefined();
    });

    it.each<[string, RevertTrailers]>([
      ['a Bs-Revert-Of that is not 40-hex', { revertOf: 'not-a-sha' }],
      ['a Bs-Revert-Of that names no merge on the branch', { revertOf: 'f'.repeat(40) }],
      ['a Bs-Task of another epic', { task: 'other-epic/task-1' }],
      ['a missing Bs-Task', { task: null }],
      ['a Bs-Red-Record that is not an event id', { redRecord: 'not an id' }],
      ['an empty Bs-Failing-Checks', { failingChecks: '' }],
      ['a Bs-Failing-Checks of separators only', { failingChecks: ' , ,' }],
    ])('invalid-trailers: %s', async (_name, trailers) => {
      await landed('task-1', { trailers });
      const { result, event } = await expectRecordOnly('invalid-trailers');
      expect(result.wrote[0]?.culprit).toBeUndefined();
      expect(event.evidence).toBe('unreadable');
    });

    it('invalid-trailers: a Bs-Revert-Of that is a plain commit, not a merge', async () => {
      await admit(T1);
      const plain = repo.handCommit({ 'plain.txt': 'p\n' }, 'plain commit');
      await certify(plain);
      const red = await redRecord();
      const revert = repo.revert(repo.merge('task-1', { 'a.txt': 'a\n' }), {
        revertOf: plain,
        redRecord: red,
      });
      await certify(revert);
      await expectRecordOnly('invalid-trailers');
    });

    it('uses only reasons from the one list', async () => {
      await landed('task-1', { trailers: { revertOf: 'not-a-sha' } });
      await resume();
      const [event] = await reverted();
      expect(RECORD_ONLY_REASONS as readonly string[]).toContain(
        payloadOf(event as StoredEvent).reason,
      );
    });
  });

  describe('a commit that only claims to be a tested revert (finding 589acdbe)', () => {
    const trailerMessage = (l: { merge: string; red: string }) =>
      [
        'Revert "Merge task-1 into integration"',
        '',
        `Bs-Revert-Of: ${l.merge}`,
        'Bs-Task: task-1',
        `Bs-Red-Record: ${l.red}`,
        'Bs-Failing-Checks: post-a',
      ].join('\n');

    it('a hand-made commit with valid trailers and a different tree is record-only', async () => {
      await admit(T1);
      const merge = repo.merge('task-1', { 'a.txt': 'a\n' });
      await recordMerge(T1, merge);
      const red = await redRecord();
      // Same trailers, but the diff does not undo the merge, and it even
      // carries passing pre-merge and post-merge records.
      const fake = repo.handCommit({ 'unrelated.txt': 'x\n' }, trailerMessage({ merge, red }));
      await certify(fake);
      const { result } = await expectRecordOnly('invalid-trailers');
      expect(result.wrote[0]?.revert_sha).toBe(fake);
      expect(await statusOf()).toBe('completed');
    });

    it('a commit with the right tree and no passing records is record-only', async () => {
      await landed('task-1', { records: 'none' });
      await expectRecordOnly('invalid-trailers');
      expect(await statusOf()).toBe('completed');
    });

    it('a failing record at the revert does not count', async () => {
      const l = await landed('task-1', { records: 'none' });
      await certify(l.revert, [PRE, { ...POST, cmd: 'false' }]);
      await expectRecordOnly('invalid-trailers');
    });

    it('records for only one of the two tiers do not count', async () => {
      const l = await landed('task-1', { records: 'none' });
      await certify(l.revert, [POST]);
      await expectRecordOnly('invalid-trailers');
    });

    it('records for the pre-merge tier alone do not count', async () => {
      const l = await landed('task-1', { records: 'none' });
      await certify(l.revert, [PRE]);
      await expectRecordOnly('invalid-trailers');
    });

    it.each([
      ['its own pass flag is false', false, true],
      ['one of its results failed', true, false],
    ])(
      'a record where %s does not count, whatever the rest says',
      async (_name, pass, resultPass) => {
        const l = await landed('task-1', { records: 'none' });
        for (const tier of ['pre-merge', 'post-merge']) {
          await append('integration-check', {
            epic_id: repo.epicId,
            branch: repo.branch,
            head_sha: l.revert,
            pass,
            tiers: [tier],
            results: [{ name: `${tier}-check`, pass: resultPass, exitCode: 0, tail: '' }],
          });
        }
        await expectRecordOnly('invalid-trailers');
      },
    );

    it('a Bs-Revert-Of merge that is not on the first-parent history is not a tested revert', async () => {
      await admit(T1);
      const builder = path.join(repo.root, 'builder');
      const g = (...args: string[]) => repo.git(args, builder);
      const write = (file: string) => {
        writeFileSync(path.join(builder, file), `${file}\n`);
        g('add', '--all');
        g('commit', '-q', '-m', file);
      };
      g('checkout', '-q', '-b', 'side', repo.forkPoint());
      write('side-a.txt');
      g('checkout', '-q', '-b', 'side2', repo.forkPoint());
      write('side-b.txt');
      g('checkout', '-q', 'side');
      g('merge', '--no-ff', '-q', 'side2', '-m', 'merge inside the side branch');
      const sideMerge = g('rev-parse', 'HEAD');
      g('checkout', '-q', repo.branch);
      g('merge', '--no-ff', '-q', 'side', '-m', `Merge task-1 into ${repo.branch}`);
      await recordMerge(T1, g('rev-parse', 'HEAD'));
      // The tree is exactly what reverting the side merge makes of its parent.
      const revert = repo.revert(sideMerge, {
        task: 'task-1',
        redRecord: await redRecord(),
        failingChecks: 'post-a',
      });
      await certify(revert);
      await expectRecordOnly('invalid-trailers');
    });

    it('a probe record never counts as a pass', async () => {
      const l = await landed('task-1', { records: 'none' });
      await certify(l.revert, [PRE, POST], 'some-record');
      await expectRecordOnly('invalid-trailers');
    });

    it('records at another commit do not count', async () => {
      const l = await landed('task-1', { records: 'none' });
      await certify(l.merge);
      await expectRecordOnly('invalid-trailers');
    });

    it('a genuine revert of a merge that a later merge sits on top of is a bounce', async () => {
      await admit(T1);
      const merge = repo.merge('task-1', { 'a.txt': 'a\n' });
      await recordMerge(T1, merge);
      repo.merge('task-2', { 'b.txt': 'b\n', 'a2.txt': 'a2\n' });
      const red = await redRecord();
      const revert = repo.revert(merge, { redRecord: red, failingChecks: 'post-a' });
      await certify(revert);
      expect((await resume()).wrote[0]?.disposition).toBe('bounce');
    });

    it('the genuine tested revert is a bounce', async () => {
      await landed('task-1');
      const result = await resume();
      expect(result.outcome).toBe('reverted');
      expect(result.wrote[0]?.disposition).toBe('bounce');
    });
  });

  describe('unreadable evidence', () => {
    it('bounces with trailers-only evidence when the red record is absent', async () => {
      const l = await landed('task-1', { trailers: { redRecord: `${repo.sessionId}#999` } });
      const result = await resume();
      expect(result.outcome).toBe('reverted');
      const [event] = await reverted();
      expect(payloadOf(event as StoredEvent)).toMatchObject({
        disposition: 'bounce',
        evidence: 'trailers-only',
        failing_checks: ['post-a'],
        red_record_event_id: `${repo.sessionId}#999`,
        evidence_event_ids: [`${repo.sessionId}#999`],
        reverted_merge_sha: l.merge,
      });
      expect(result.wrote[0]?.culprit).toMatchObject({
        task: T1,
        merge_sha: l.merge,
        failing_checks: ['post-a'],
        red_record_event_id: `${repo.sessionId}#999`,
        reproduced: true,
      });
    });

    it('records a superseded task as unreadable with empty lists, and is not refused', async () => {
      await landed('task-1', { trailers: { redRecord: `${repo.sessionId}#999` } });
      await append('task-superseded', {}, T1);
      const { event } = await expectRecordOnly('superseded');
      expect(event).toMatchObject({
        evidence: 'unreadable',
        failing_checks: [],
        evidence_event_ids: [],
        log_tail: '',
      });
    });

    it('treats a record that is not an integration-check as unreadable', async () => {
      // The builder's default Bs-Red-Record is the session-start event.
      await landed('task-1', { trailers: { redRecord: `${repo.sessionId}#0` } });
      await resume();
      const [event] = await reverted();
      expect(payloadOf(event as StoredEvent).evidence).toBe('trailers-only');
    });
  });

  describe('no repetition', () => {
    it('returns nothing-to-resume on an empty branch', async () => {
      repo.merge('task-1', { 'a.txt': 'a\n' });
      const result = await resume();
      expect(result).toEqual({ outcome: 'nothing-to-resume', resumed: false, wrote: [] });
      expect(await reverted()).toHaveLength(0);
    });

    it.each([
      ['a bounce', {}],
      ['a record-only write', { liveTaskIds: [] as string[] }],
    ])('after %s, a second call writes nothing', async (_name, extra) => {
      await landed('task-1');
      const first = await resume(extra);
      expect(first.wrote).toHaveLength(1);
      const second = await resume(extra);
      expect(second).toEqual({ outcome: 'nothing-to-resume', resumed: false, wrote: [] });
      expect(await reverted()).toHaveLength(1);
    });

    it('skips a revert a wave-reverted already names, and finishes the rest', async () => {
      const first = await landed('task-1');
      await landed('task-2');
      await append(
        WAVE_REVERTED_EVENT,
        {
          epic_id: repo.epicId,
          integration_branch: repo.branch,
          revert_sha: first.revert,
          disposition: 'record-only',
          reason: 'superseded',
          task_ids: [T1],
          reverted_merge_sha: first.merge,
          failing_checks: [],
          evidence_event_ids: [],
          log_tail: '',
          evidence: 'unreadable',
        },
        T1,
      );
      const result = await resume();
      expect(result.wrote.map((w) => w.task)).toEqual([T2]);
    });
  });

  describe('outcome', () => {
    it('is revert-recorded when any write was record-only', async () => {
      await landed('task-1');
      await landed('task-2');
      const result = await resume({ liveTaskIds: [T2] });
      expect(result.outcome).toBe('revert-recorded');
      expect(result.resumed).toBe(true);
      expect(result.wrote.map((w) => w.disposition)).toEqual(['record-only', 'bounce']);
    });
  });

  describe('culprit', () => {
    it('is rebuilt from the trailers for a bounce and for a superseded record', async () => {
      const a = await landed('task-1', { trailers: { failingChecks: 'post-a,pre-a' } });
      const b = await landed('task-2');
      await append('task-superseded', {}, T2);
      const result = await resume();
      expect(result.wrote[0]?.culprit).toEqual({
        task: T1,
        merge_sha: a.merge,
        failing_checks: ['post-a', 'pre-a'],
        red_record_event_id: a.red,
        reproduced: true,
      });
      expect(result.wrote[1]).toMatchObject({ reason: 'superseded' });
      expect(result.wrote[1]?.culprit).toEqual({
        task: T2,
        merge_sha: b.merge,
        failing_checks: ['post-a'],
        red_record_event_id: b.red,
        reproduced: true,
      });
    });

    it('qualifies a bare Bs-Task', async () => {
      await landed('task-1', { trailers: { task: 'task-1' } });
      const result = await resume();
      expect(result.wrote[0]?.task).toBe(T1);
      expect(result.wrote[0]?.culprit?.task).toBe(T1);
    });
  });

  describe('an unexpected git failure is not a verdict', () => {
    it.each(['commit-tree', 'rev-list'])(
      'a failing %s records nothing and the next run retries',
      async (subcommand) => {
        await landed('task-1');
        gitFault.subcommand = subcommand;
        const before = snapshot();
        await expect(
          resumeLandedReverts(await input(), repo.ctx(), repo.opts()),
        ).rejects.toBeInstanceOf(GitCommandError);
        expect(await reverted()).toHaveLength(0);
        expect(snapshot()).toEqual(before);
        gitFault.subcommand = null;
        const again = await resume();
        expect(again.outcome).toBe('reverted');
        expect(again.wrote[0]?.disposition).toBe('bounce');
        expect(await reverted()).toHaveLength(1);
      },
    );

    it('a failing merge-tree exit other than a conflict is not a verdict either', async () => {
      await landed('task-1');
      gitFault.subcommand = 'merge-tree';
      await expect(resumeLandedReverts(await input(), repo.ctx(), repo.opts())).rejects.toThrow(
        /unable to write object/,
      );
      expect(await reverted()).toHaveLength(0);
    });

    it('a failing merge-base --is-ancestor is not "not an ancestor" (finding d4d2a973)', async () => {
      await landed('task-1');
      const again = repo.merge('task-1-again', { 'again.txt': 'again\n' });
      await recordMerge(T1, again);
      gitFault.subcommand = '--is-ancestor';
      const before = snapshot();
      await expect(
        resumeLandedReverts(await input(), repo.ctx(), repo.opts()),
      ).rejects.toBeInstanceOf(GitCommandError);
      expect(await reverted()).toHaveLength(0);
      expect(snapshot()).toEqual(before);
      gitFault.subcommand = null;
      await expectRecordOnly('re-merged');
    });

    it('a fault on a later revert writes nothing for the earlier one (finding 1b666dbe)', async () => {
      const a = await landed('task-1');
      const b = await landed('task-2');
      // The first revert's proof passes, the second one's commit-tree faults.
      gitFault.subcommand = 'commit-tree';
      gitFault.passes = 1;
      await expect(
        resumeLandedReverts(await input(), repo.ctx(), repo.opts()),
      ).rejects.toBeInstanceOf(GitCommandError);
      expect(await reverted()).toHaveLength(0);
      gitFault.subcommand = null;
      const next = await resume();
      expect(next.wrote.map((w) => [w.task, w.disposition, w.culprit?.merge_sha])).toEqual([
        [T1, 'bounce', a.merge],
        [T2, 'bounce', b.merge],
      ]);
    });

    it('a fault while writing a later revert hands back the earlier write with its culprit', async () => {
      const a = await landed('task-1');
      const b = await landed('task-2');
      // One ancestry call per bounce to decide it, one more inside each write:
      // the fourth call, the second write's own preflight, faults.
      gitFault.subcommand = '--is-ancestor';
      gitFault.passes = 3;
      const err = await resumeLandedReverts(await input(), repo.ctx(), repo.opts()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(GitCommandError);
      expect((err as { wrote?: unknown }).wrote).toEqual([
        {
          task: T1,
          revert_sha: a.revert,
          disposition: 'bounce',
          culprit: {
            task: T1,
            merge_sha: a.merge,
            failing_checks: ['post-a'],
            red_record_event_id: a.red,
            reproduced: true,
          },
        },
      ]);
      expect((await reverted()).map((e) => payloadOf(e).revert_sha)).toEqual([a.revert]);
      gitFault.subcommand = null;
      const next = await resume();
      expect(next.wrote.map((w) => [w.task, w.culprit?.merge_sha])).toEqual([[T2, b.merge]]);
    });

    it('a claimed revert whose revert-merge conflicts is record-only, not a failure', async () => {
      // A later commit rewrites the merge's file, so reverting the merge over
      // the claimed revert's parent conflicts (merge-tree exit 1).
      await admit(T1);
      const merge = repo.merge('task-1', { 'a.txt': 'a\n' });
      await recordMerge(T1, merge);
      repo.merge('task-2', { 'a.txt': 'changed later\n' });
      const red = await redRecord();
      const fake = repo.handCommit(
        { 'x.txt': 'x\n' },
        [
          'Revert "Merge task-1"',
          '',
          `Bs-Revert-Of: ${merge}`,
          'Bs-Task: task-1',
          `Bs-Red-Record: ${red}`,
          'Bs-Failing-Checks: post-a',
        ].join('\n'),
      );
      await certify(fake);
      await expectRecordOnly('invalid-trailers');
    });
  });

  describe('the branch the scan reads is the branch that is written', () => {
    it('refuses an integration branch that is not the one scanned', async () => {
      await landed('task-1');
      await expect(
        resume({ integration: { branch: 'bs/epic-1/elsewhere' } }),
      ).rejects.toMatchObject({ code: 'postmerge.not-integration-branch' });
      expect(await reverted()).toHaveLength(0);
    });

    it('writes the scanned branch into every event', async () => {
      await landed('task-1');
      await resume();
      const [event] = await reverted();
      expect(payloadOf(event as StoredEvent).integration_branch).toBe(repo.branch);
    });
  });

  describe('trailer parsing mirrors isBsRevertCommit', () => {
    it.each([
      ['a single paragraph', 'Bs-Revert-Of: abc'],
      ['a trailer in a non-final paragraph', 'Bs-Revert-Of: abc\n\nsubject line'],
      ['an indented trailer', 'subject\n\n Bs-Revert-Of: abc'],
      ['a final-paragraph trailer', 'subject\n\nBs-Revert-Of: abc\nBs-Task: t'],
      ['trailing blank lines', 'subject\n\nBs-Revert-Of: abc\n\n\n'],
      ['a different key sharing the prefix', 'subject\n\nBs-Revert-Of-X: abc'],
    ])('agrees on %s', (_name, message) => {
      expect(trailerValues(message).has('Bs-Revert-Of')).toBe(isBsRevertCommit(message));
    });
  });

  it('refuses a branch that is not an integration branch', async () => {
    await expect(resume({ projectDir: repo.projectDir, epicId: 'a/b' })).rejects.toMatchObject({
      code: 'postmerge.not-integration-branch',
    });
  });
});
