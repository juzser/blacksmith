import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/events.js';
import { runIntegrationCheck } from '../src/integration.js';
import { type CheckCommand, commandDigest } from '../src/testgate.js';
import { type OverlayEntry, readOverlay, writeOverlay } from '../src/tierOverlay.js';
import { runCli } from './helpers/cliHarness.js';
import { createIntegrationRepo, type IntegrationRepo } from './helpers/integrationRepo.js';

const EPIC = 'epic-1';
const T = (n: number): string => `${EPIC}/task-${n}`;
const BROKEN = { 'broken.txt': 'x\n' };
const PRE: CheckCommand = {
  name: 'pre-a',
  cmd: 'test ! -f use.txt || test -f lib.txt',
  tier: 'pre-merge',
};
const POST: CheckCommand = { name: 'post-a', cmd: 'test ! -f broken.txt', tier: 'post-merge' };
/** The same check with no declared tier: only the overlay can put it in post-merge. */
const POST_UNDECLARED: CheckCommand = { name: 'post-a', cmd: POST.cmd };

interface PostMergeDoc {
  outcome: string;
  resumed: boolean;
  culprits: { task: string }[];
  dependents?: string[];
  setup_failed?: { step: string; commit: string };
  revert_sha?: string;
  promotions?: { task: string; check: string; result: string; reason: string | null }[];
  overlay?: unknown;
}

interface PlanTask {
  task_id: string;
  task_status: string;
}

describe('bs checks post-merge', () => {
  let repo: IntegrationRepo;
  let scratch: string;
  let planPath: string;
  let checksPath: string;

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'bs-pm-cli-'));
    repo = await createIntegrationRepo({ epicId: EPIC });
    planPath = path.join(scratch, 'specs', EPIC, 'plan.json');
    checksPath = path.join(scratch, 'checks.json');
  });
  afterEach(async () => {
    await repo.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  const writePlan = (ids: number[], edges: [number, number][] = [], extra: PlanTask[] = []) => {
    mkdirSync(path.dirname(planPath), { recursive: true });
    writeFileSync(
      planPath,
      JSON.stringify({
        epic_id: EPIC,
        version: 1,
        status: 'active',
        project: 'project',
        tasks: [
          ...ids.map((n) => ({ task_id: `task-${n}`, task_status: 'completed', claims: [] })),
          ...extra.map((t) => ({ ...t, claims: [] })),
        ],
        edges: edges.map(([task, dep]) => ({
          task: `task-${task}`,
          dependsOn: `task-${dep}`,
          edge_type: 'artifact',
          edge_provenance: 'declared',
        })),
      }),
    );
  };
  const writeChecks = (checks: CheckCommand[]) => writeFileSync(checksPath, JSON.stringify(checks));

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
  const mergeTask = async (n: number, files: Record<string, string | null>): Promise<string> => {
    await append('wave-admitted', { epic_id: EPIC, task_ids: [T(n)] }, T(n));
    const sha = repo.merge(`task-${n}`, files);
    await append('wave-merged', { epic_id: EPIC, task_ids: [T(n)], merge_sha: sha }, T(n));
    return sha;
  };
  const threeMerges = async () => ({
    m1: await mergeTask(1, { 'a.txt': 'a\n' }),
    m2: await mergeTask(2, { ...BROKEN, 'lib.txt': 'lib\n' }),
    m3: await mergeTask(3, { 'c.txt': 'c\n' }),
  });

  const postWith = (env: Record<string, string> | undefined, ...extra: string[]) =>
    runCli(
      [
        'checks',
        'post-merge',
        '--epic',
        EPIC,
        '--project',
        repo.projectDir,
        '--checks',
        checksPath,
        '--plan',
        planPath,
        '--session',
        repo.sessionId,
        '--state-dir',
        repo.stateDir,
        '--plan-version',
        '1',
        '--causal-parent',
        `${repo.sessionId}#0`,
        ...extra,
      ],
      env,
    );
  const post = (...extra: string[]) => postWith(undefined, ...extra);
  const out = (run: ReturnType<typeof runCli>) => JSON.parse(run.stdout) as PostMergeDoc;
  const logLines = (): number =>
    readdirSync(repo.stateDir)
      .filter((n) => n.endsWith('.jsonl'))
      .reduce(
        (n, f) => n + readFileSync(path.join(repo.stateDir, f), 'utf8').split('\n').length,
        0,
      );
  const eventsOfType = async (type: string) =>
    (await repo.events()).filter((e) => e.record.event_type === type);

  /** A bs revert of merge 2 landed with its records on the log and no wave-reverted. */
  const landedRevert = async (redRecord?: string) => {
    const m2 = (await threeMerges()).m2;
    const red = await append('integration-check', {
      epic_id: EPIC,
      branch: repo.branch,
      head_sha: repo.head(),
      pass: false,
      results: [{ name: 'post-a', pass: false, exitCode: 1, tail: 'boom' }],
    });
    repo.revert(m2, { redRecord: redRecord ?? red.event_id, failingChecks: 'post-a' });
    const R = repo.head();
    repo.release();
    for (const tier of ['pre-merge', 'post-merge'] as const) {
      await runIntegrationCheck(
        {
          epicId: EPIC,
          projectDir: repo.projectDir,
          checks: [PRE, POST],
          tier,
          workspace: 'scratch',
          commit: R,
        },
        repo.ctx(),
        repo.opts(),
      );
    }
    return R;
  };

  describe('outcomes and exit codes', () => {
    it('prints reverted and exits 0', async () => {
      writePlan([1, 2, 3]);
      writeChecks([PRE, POST]);
      await threeMerges();
      repo.release();
      const run = post('--final');
      expect(run.status).toBe(0);
      const doc = out(run);
      expect(doc.outcome).toBe('reverted');
      expect(doc.culprits.map((c: { task: string }) => c.task)).toEqual(['task-2']);
      expect(doc.revert_sha).toBe(repo.head());
      expect(doc.overlay).toBeDefined();
      expect(await eventsOfType('wave-reverted')).toHaveLength(1);
    });

    it('prints revert-conflict and exits 1', async () => {
      writePlan([1, 2, 3]);
      writeChecks([PRE, POST]);
      await mergeTask(1, { 'a.txt': 'a\n' });
      await mergeTask(2, BROKEN);
      await mergeTask(3, { 'broken.txt': 'changed\n' });
      repo.release();
      const run = post('--final');
      expect(run.status).toBe(1);
      expect(out(run).outcome).toBe('revert-conflict');
    });

    it('prints revert-has-dependents with the culprit and the dependents, and exits 1', async () => {
      writePlan([1, 2, 3], [[3, 2]]);
      writeChecks([PRE, POST]);
      await threeMerges();
      repo.release();
      const run = post('--final');
      expect(run.status).toBe(1);
      const doc = out(run);
      expect(doc.outcome).toBe('revert-has-dependents');
      expect(doc.culprits.map((c: { task: string }) => c.task)).toEqual(['task-2']);
      expect(doc.dependents).toEqual(['task-3']);
    });

    it('prints batch-not-ready with a task in flight, exits 0 and creates no worktree and no promotions', async () => {
      writePlan([1, 2], [], [{ task_id: 'task-9', task_status: 'todo' }]);
      writeChecks([PRE, POST]);
      await mergeTask(1, { 'a.txt': 'a\n' });
      await mergeTask(2, { 'b.txt': 'b\n' });
      await append('wave-admitted', { epic_id: EPIC, task_ids: [T(9)] }, T(9));
      repo.release();
      const worktrees = repo.worktreeCount();
      const run = post();
      expect(run.status).toBe(0);
      const doc = out(run);
      expect(doc.outcome).toBe('batch-not-ready');
      expect(doc).not.toHaveProperty('promotions');
      expect(repo.worktreeCount()).toBe(worktrees);
    });

    it('prints no-checks-in-tier, exits 0, appends no event and creates no worktree', async () => {
      writePlan([1, 2]);
      writeChecks([PRE]);
      await mergeTask(1, { 'a.txt': 'a\n' });
      repo.release();
      const lines = logLines();
      const worktrees = repo.worktreeCount();
      const run = post('--final');
      expect(run.status).toBe(0);
      expect(out(run).outcome).toBe('no-checks-in-tier');
      expect(logLines()).toBe(lines);
      expect(repo.worktreeCount()).toBe(worktrees);
    });

    it('prints setup-failed with the step and the head commit, and exits 1', async () => {
      writePlan([1, 2, 3]);
      writeChecks([PRE, POST]);
      await threeMerges();
      repo.release();
      const run = post('--final', '--setup-cmd', 'exit 1');
      expect(run.status).toBe(1);
      const doc = out(run);
      expect(doc.outcome).toBe('setup-failed');
      expect(doc.setup_failed).toEqual({ step: 'head', commit: repo.head() });
    });
  });

  describe('resume', () => {
    it('prints revert-recorded and exits 1 once, then proceeds to the normal flow', async () => {
      // The task was superseded before wave-reverted was written.
      writePlan([1, 3], [], [{ task_id: 'task-2', task_status: 'superseded' }]);
      writeChecks([PRE, POST]);
      await landedRevert();
      const first = post('--final');
      expect(first.status).toBe(1);
      expect(out(first).outcome).toBe('revert-recorded');
      const second = post('--final');
      expect(out(second).outcome).not.toBe('revert-recorded');
      expect(out(second).resumed).toBe(false);
    });
  });

  describe('automatic promotion', () => {
    /** post-a is undeclared and demoted to post-merge by an approved decision, as `bs checks apply` leaves it. */
    const demote = async () => {
      const decided = await append('check-tier-decided', {
        proposal_id: 'p-post-a',
        check: 'post-a',
        cmd_sha256: commandDigest(POST.cmd),
        from_tier: 'pre-merge',
        to_tier: 'post-merge',
        decision: 'approve',
        note: null,
      });
      const entry: OverlayEntry = {
        check: 'post-a',
        cmd_sha256: commandDigest(POST.cmd),
        tier: 'post-merge',
        decided_by_event_id: decided.event_id,
        decided_at: '2026-10-30T00:00:00.000Z',
      };
      writeOverlay(repo.projectDir, { entries: [entry], expectedRevision: 0 });
    };
    const overlayTier = (): string | undefined => {
      const o = readOverlay(repo.projectDir);
      return 'entries' in o ? o.entries.find((e) => e.check === 'post-a')?.tier : undefined;
    };
    const promoted = {
      task: 'task-2',
      check: 'post-a',
      result: 'promoted',
      reason: null,
    };

    it('promotes the demoted check on reverted', async () => {
      writePlan([1, 2, 3]);
      writeChecks([PRE, POST_UNDECLARED]);
      await threeMerges();
      repo.release();
      await demote();
      const run = post('--final');
      expect(run.status).toBe(0);
      const doc = out(run);
      expect(doc.outcome).toBe('reverted');
      expect(doc.promotions).toEqual([promoted]);
      expect(overlayTier()).toBe('pre-merge');
      expect(await eventsOfType('check-tier-promoted')).toHaveLength(1);
    });

    it('promotes it on revert-has-dependents too, and leaves the exit code', async () => {
      writePlan([1, 2, 3], [[3, 2]]);
      writeChecks([PRE, POST_UNDECLARED]);
      await threeMerges();
      repo.release();
      await demote();
      const run = post('--final');
      expect(run.status).toBe(1);
      expect(out(run).outcome).toBe('revert-has-dependents');
      expect(out(run).promotions).toEqual([promoted]);
      expect(overlayTier()).toBe('pre-merge');
    });

    it('promotes it on a resumed reverted', async () => {
      writePlan([1, 2, 3]);
      writeChecks([PRE, POST_UNDECLARED]);
      await demote();
      await landedRevert();
      const run = post('--final');
      const doc = out(run);
      expect(doc.outcome).toBe('reverted');
      expect(doc.resumed).toBe(true);
      expect(doc.promotions).toEqual([{ ...promoted, task: 'epic-1/task-2' }]);
      expect(overlayTier()).toBe('pre-merge');
    });

    it('stands on a resumed reverted whose red record is absent and promotes nothing', async () => {
      writePlan([1, 2, 3]);
      writeChecks([PRE, POST_UNDECLARED]);
      await demote();
      await landedRevert(`${repo.sessionId}#9999`);
      const doc = out(post('--final'));
      expect(doc.outcome).toBe('reverted');
      expect(doc.promotions).toEqual([
        {
          task: 'epic-1/task-2',
          check: 'post-a',
          result: 'promotion-skipped',
          reason: 'red-record-unreadable',
        },
      ]);
      expect(overlayTier()).toBe('post-merge');
    });

    /**
     * Two landed, proven reverts of task 2, so the resume writes two wave-reverted events, and a
     * preload that makes the CLI process fail the append of the second one, after the first
     * landed, the way a log fault would. With `promoteFault` it also fails every
     * check-tier-promoted append, so promotion itself throws.
     */
    const rejectingResume = async (promoteFault: boolean) => {
      writePlan([1, 2, 3]);
      writeChecks([PRE, POST_UNDECLARED]);
      await demote();
      const mA = await mergeTask(2, { ...BROKEN, 'lib.txt': 'lib\n' });
      const mB = await mergeTask(2, { 'again.txt': 'again\n' });
      const red = await append('integration-check', {
        epic_id: EPIC,
        branch: repo.branch,
        head_sha: repo.head(),
        pass: false,
        results: [{ name: 'post-a', pass: false, exitCode: 1, tail: 'boom' }],
      });
      const landed = [mA, mB].map((m) =>
        repo.revert(m, { redRecord: red.event_id, failingChecks: 'post-a' }),
      );
      repo.release();
      for (const commit of landed) {
        for (const tier of ['pre-merge', 'post-merge'] as const) {
          await runIntegrationCheck(
            {
              epicId: EPIC,
              projectDir: repo.projectDir,
              checks: [PRE, POST],
              tier,
              workspace: 'scratch',
              commit,
            },
            repo.ctx(),
            repo.opts(),
          );
        }
      }
      const fault = path.join(scratch, 'fault-appends.mjs');
      writeFileSync(
        fault,
        [
          "import { readFileSync } from 'node:fs';",
          "import fsp from 'node:fs/promises';",
          "import { syncBuiltinESMExports } from 'node:module';",
          'const real = fsp.appendFile;',
          'const reverted = \'"event_type":"wave-reverted"\';',
          'const promoted = \'"event_type":"check-tier-promoted"\';',
          'fsp.appendFile = async (file, data, ...rest) => {',
          '  const text = String(data);',
          "  if (text.includes(reverted) && readFileSync(file, 'utf8').includes(reverted))",
          "    throw new Error('log fault');",
          "  if (process.env.FAULT_PROMOTE === '1' && text.includes(promoted))",
          "    throw new Error('promotion fault');",
          '  return real(file, data, ...rest);',
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
      );
      return postWith(
        { NODE_OPTIONS: `--import ${fault}`, FAULT_PROMOTE: promoteFault ? '1' : '0' },
        '--final',
      );
    };

    it('promotes the culprits of the writes a rejecting resume made, then rethrows its error', async () => {
      const run = await rejectingResume(false);
      expect(run.status).toBe(1);
      expect(JSON.parse(run.stdout).error.message).toBe('log fault');
      expect(await eventsOfType('wave-reverted')).toHaveLength(1);
      expect(await eventsOfType('check-tier-promoted')).toHaveLength(1);
      expect(overlayTier()).toBe('pre-merge');
    });

    it('still shows the error of the run when promotion itself throws', async () => {
      const run = await rejectingResume(true);
      expect(run.status).toBe(1);
      expect(JSON.parse(run.stdout).error.message).toBe('log fault');
      expect(await eventsOfType('check-tier-promoted')).toHaveLength(0);
      expect(run.stderr).toMatch(/promotion failed for the post-merge run/);
    });

    it('answers declared-tier-wins for a declared post-merge check', async () => {
      writePlan([1, 2, 3]);
      writeChecks([PRE, POST]);
      await threeMerges();
      repo.release();
      const doc = out(post('--final'));
      expect(doc.outcome).toBe('reverted');
      expect(doc.promotions).toEqual([{ ...promoted, result: 'declared-tier-wins' }]);
    });

    it('skips promotion when git tracks the overlay, outcome and exit code unchanged', async () => {
      writePlan([1, 2, 3]);
      writeChecks([PRE, POST_UNDECLARED]);
      await threeMerges();
      repo.release();
      await demote();
      repo.git(['add', '-f', '.blacksmith/check-tiers.json']);
      repo.git(['commit', '-q', '-m', 'track the overlay']);
      const run = post('--final');
      expect(run.status).toBe(0);
      const doc = out(run);
      expect(doc.outcome).toBe('reverted');
      expect(doc.promotions).toEqual([
        { ...promoted, result: 'promotion-skipped', reason: 'checks.overlay-tracked' },
      ]);
      expect(overlayTier()).toBe('post-merge');
    });
  });

  describe('tiers through integration check and epic verdict', () => {
    const REL: CheckCommand = { name: 'rel-a', cmd: 'test ! -f broken.txt', tier: 'pre-release' };
    const integration = (...extra: string[]) =>
      runCli([
        'integration',
        'check',
        '--epic',
        EPIC,
        '--project',
        repo.projectDir,
        '--checks',
        checksPath,
        '--session',
        repo.sessionId,
        '--state-dir',
        repo.stateDir,
        '--plan-version',
        '1',
        '--causal-parent',
        `${repo.sessionId}#0`,
        ...extra,
      ]);
    /** Two clean merges, the clone on the integration branch (the close-time contract). */
    const assembled = async () => {
      writePlan([1, 2]);
      writeChecks([PRE, POST, REL]);
      await mergeTask(1, { 'a.txt': 'a\n' });
      await mergeTask(2, { 'b.txt': 'b\n' });
      repo.release();
      repo.git(['checkout', '-q', repo.branch]);
    };
    const names = (run: ReturnType<typeof runCli>): string[] =>
      JSON.parse(run.stdout).results.map((r: { name: string }) => r.name);

    it('--tier pre-release writes a record for that tier alone and runs only it', async () => {
      await assembled();
      const run = integration('--tier', 'pre-release');
      expect(run.status).toBe(0);
      expect(names(run)).toEqual(['rel-a']);
      const doc = JSON.parse(run.stdout);
      expect(doc.tiers).toEqual(['pre-release']);
      expect(doc.tiersPresent).toEqual(['pre-merge', 'post-merge', 'pre-release']);
      const records = await eventsOfType('integration-check');
      expect(records.map((e) => (e.record.payload as { tiers: string[] }).tiers)).toEqual([
        ['pre-release'],
      ]);
      expect(doc.results[0]).toHaveProperty('check_sha256');
      expect(doc.results[0]).toHaveProperty('cmd_sha256');
    });

    it('--tier remaining runs no post-merge check once a post-merge record is current', async () => {
      await assembled();
      expect(integration('--tier', 'post-merge').status).toBe(0);
      const run = integration('--tier', 'remaining');
      expect(run.status).toBe(0);
      expect(names(run).sort()).toEqual(['pre-a', 'rel-a']);
    });

    it('without --tier runs every check and the record gains the tier fields', async () => {
      await assembled();
      const run = integration();
      expect(run.status).toBe(0);
      expect(names(run)).toEqual(['pre-a', 'post-a', 'rel-a']);
      const doc = JSON.parse(run.stdout);
      for (const key of ['tiers', 'tiersPresent', 'treeSha', 'notRun', 'environment']) {
        expect(doc).toHaveProperty(key);
      }
      expect(doc).not.toHaveProperty('probeOf');
    });

    it('rejects an unknown --tier', async () => {
      await assembled();
      const run = integration('--tier', 'sometimes');
      expect(run.status).toBe(1);
      expect(run.stdout + run.stderr).toContain('--tier');
    });

    it('epic verdict --checks blocks, naming the tier, when only a post-merge record is current', async () => {
      await assembled();
      expect(integration('--tier', 'post-merge').status).toBe(0);
      const verdict = (...extra: string[]) =>
        runCli([
          'epic',
          'verdict',
          '--epic',
          EPIC,
          '--project',
          repo.projectDir,
          '--session',
          repo.sessionId,
          '--state-dir',
          repo.stateDir,
          '--plan-version',
          '1',
          '--causal-parent',
          `${repo.sessionId}#0`,
          ...extra,
        ]);
      const withChecks = verdict('--checks', checksPath);
      expect(withChecks.status).toBe(1);
      expect(withChecks.stdout).toMatch(/pre-release/);
      expect(withChecks.stdout).toContain('rel-a');
      const close = runCli([
        'epic',
        'close',
        '--epic',
        EPIC,
        '--project',
        repo.projectDir,
        '--checks',
        checksPath,
        '--session',
        repo.sessionId,
        '--state-dir',
        repo.stateDir,
        '--plan-version',
        '1',
        '--causal-parent',
        `${repo.sessionId}#0`,
      ]);
      expect(close.status).toBe(1);
      expect(close.stdout + close.stderr).toContain('rel-a');
      // Without the flag the epic's tiered records refuse the close and ask for it.
      const without = verdict();
      expect(without.status).toBe(1);
      expect(without.stdout).toContain('--checks');
    });
  });
});
