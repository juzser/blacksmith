import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, taskStatusFixtures } from './helpers/cliHarness.js';
import { createIntegrationRepo, type IntegrationRepo } from './helpers/integrationRepo.js';

const EPIC = 'epic-1';
const q = (id: string): string => `${EPIC}/${id}`;

const task = (id: string, claim: string) => ({
  task_id: q(id),
  epic_id: EPIC,
  plan_version: 1,
  objective: 'Do the thing.',
  output_schema_ref: 'result.schema.json',
  acceptance_criteria: ['it works'],
  claims: [claim],
  budget: { tokens: 1000, diff_lines: 100 },
  contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
  case: 'feature',
  origin: 'user',
  task_status: 'todo',
});

// A and B merged; C depends on A; D is independent.
const PLAN = {
  epic_id: EPIC,
  version: 1,
  status: 'active',
  project: 'project',
  tasks: [
    task('task-a', 'src/a/*.ts'),
    task('task-b', 'src/b/*.ts'),
    task('task-c', 'src/c/*.ts'),
    task('task-d', 'src/d/*.ts'),
  ],
  edges: [
    {
      task: q('task-c'),
      dependsOn: q('task-a'),
      edge_type: 'artifact',
      edge_provenance: 'declared',
    },
  ],
};

describe('bs checks post-merge --held and bs wave check --checks', () => {
  let repo: IntegrationRepo;
  let scratch: string;
  let planPath: string;
  let checksPath: string;
  let emptyChecksPath: string;
  const fx = taskStatusFixtures(() => scratch);

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'bs-held-'));
    repo = await createIntegrationRepo({ epicId: EPIC });
    planPath = path.join(scratch, 'specs', EPIC, 'plan.json');
    mkdirSync(path.dirname(planPath), { recursive: true });
    writeFileSync(planPath, JSON.stringify(PLAN));
    checksPath = path.join(scratch, 'checks.json');
    writeFileSync(
      checksPath,
      JSON.stringify([{ name: 'post-a', cmd: 'test ! -f broken.txt', tier: 'post-merge' }]),
    );
    emptyChecksPath = path.join(scratch, 'checks-pre.json');
    writeFileSync(emptyChecksPath, JSON.stringify([{ name: 'unit', cmd: 'true' }]));
    // Seed S: the real plan ingest, then one wave-merged per merged task.
    fx.ingest(planPath, repo.sessionId, repo.stateDir);
    for (const id of ['task-a', 'task-b']) {
      const sha = repo.merge(id, { [`${id}.txt`]: `${id}\n` });
      fx.append(repo.sessionId, repo.stateDir, {
        event_type: 'wave-merged',
        task_id: q(id),
        payload: { epic_id: EPIC, task_ids: [q(id)], merge_sha: sha },
      });
    }
    repo.release();
  });

  afterEach(async () => {
    await repo.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  const envelope = (s = repo.sessionId) => [
    '--session',
    s,
    '--state-dir',
    repo.stateDir,
    '--plan-version',
    '1',
    '--causal-parent',
    `${repo.sessionId}#0`,
  ];
  const held = (extra: string[] = [], s = repo.sessionId) =>
    runCli([
      'checks',
      'post-merge',
      '--held',
      '--epic',
      EPIC,
      '--project',
      repo.projectDir,
      '--checks',
      checksPath,
      '--plan',
      planPath,
      '--session',
      s,
      '--state-dir',
      repo.stateDir,
      ...extra,
    ]);
  const waveCheck = (
    id: string,
    extra: string[] = ['--checks', checksPath, '--project', repo.projectDir],
  ) => runCli(['wave', 'check', planPath, q(id), '--dry', ...envelope(), ...extra]);
  /** Every line of every session log, so any appended event changes it. */
  const lineCount = (): number =>
    readdirSync(repo.stateDir)
      .filter((n) => n.endsWith('.jsonl'))
      .reduce(
        (n, f) => n + readFileSync(path.join(repo.stateDir, f), 'utf8').split('\n').length,
        0,
      );

  it('lists C waiting on A and nothing else, and writes nothing', () => {
    const worktrees = repo.worktreeCount();
    const lines = lineCount();
    const run = held();
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.held).toHaveLength(1);
    expect(out.held[0].task).toBe(q('task-c'));
    expect(out.held[0].waits_on).toEqual(['task-a']);
    expect(out.uncertified_merges.map((m: { task: string }) => m.task)).toEqual([
      'task-a',
      'task-b',
    ]);
    expect(repo.worktreeCount()).toBe(worktrees);
    expect(lineCount()).toBe(lines);
    expect(readdirSync(repo.stateDir).filter((n) => n.endsWith('.lock'))).toEqual([]);
  });

  it('refuses C with wave.held-by-post-merge and writes no event', () => {
    const lines = lineCount();
    const run = waveCheck('task-c');
    expect(run.status).toBe(1);
    const text = run.stdout + run.stderr;
    expect(text).toContain('wave.held-by-post-merge');
    expect(text).toContain('task-c');
    expect(text).toContain('task-a');
    expect(lineCount()).toBe(lines);
  });

  it('admits an independent task while the batch has not run', () => {
    const run = waveCheck('task-d');
    expect(run.status).toBe(0);
  });

  it('admits C once the post-merge batch is green, also when a continuing session wrote it', () => {
    const post = (s: string) =>
      runCli([
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
        ...envelope(s),
      ]);
    const green = post(repo.sessionId);
    expect(green.status).toBe(0);
    expect(JSON.parse(green.stdout).outcome).toBe('green');
    expect(JSON.parse(held().stdout).held).toEqual([]);
    expect(waveCheck('task-c').status).toBe(0);

    // A second batch's record, written under a session that continues S.
    const second = `${repo.sessionId}-next`;
    expect(
      runCli([
        'session',
        'start',
        second,
        '--continues',
        `${repo.sessionId}#0`,
        '--state-dir',
        repo.stateDir,
      ]).status,
    ).toBe(0);
    const out = JSON.parse(held([], second).stdout);
    expect(out.held).toEqual([]);
    expect(
      runCli([
        'wave',
        'check',
        planPath,
        q('task-c'),
        '--dry',
        '--checks',
        checksPath,
        '--project',
        repo.projectDir,
        '--session',
        second,
        '--state-dir',
        repo.stateDir,
        '--plan-version',
        '1',
        '--causal-parent',
        `${second}#0`,
      ]).status,
    ).toBe(0);
  });

  it('needs --session for --held and for wave check --checks, and reads nothing without it', () => {
    const noSession = runCli([
      'checks',
      'post-merge',
      '--held',
      '--epic',
      EPIC,
      '--project',
      repo.projectDir,
      '--checks',
      checksPath,
      '--plan',
      planPath,
      '--state-dir',
      repo.stateDir,
    ]);
    expect(noSession.status).toBe(1);
    expect(noSession.stdout + noSession.stderr).toContain('--session');
    const wave = runCli([
      'wave',
      'check',
      planPath,
      q('task-d'),
      '--dry',
      '--checks',
      checksPath,
      '--project',
      repo.projectDir,
    ]);
    expect(wave.status).toBe(1);
    expect(wave.stdout + wave.stderr).toContain('--session');
  });

  it('holds nothing on a project with no post-merge entry', () => {
    const out = JSON.parse(held(['--checks', emptyChecksPath]).stdout);
    expect(out.held).toEqual([]);
  });

  describe('a fresh epic whose integration branch does not exist yet', () => {
    const dropBranch = () => {
      execFileSync('git', ['branch', '-D', repo.branch], { cwd: repo.projectDir });
    };

    it('holds nothing with a post-merge entry: --held exits 0 with no merges', () => {
      dropBranch();
      const run = held();
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ held: [], uncertified_merges: [] });
    });

    it('holds nothing with a post-merge entry: wave check admits', () => {
      dropBranch();
      expect(waveCheck('task-c').status).toBe(0);
    });

    it('reads no git state without a post-merge entry', () => {
      dropBranch();
      const run = held(['--checks', emptyChecksPath]);
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ held: [], uncertified_merges: [] });
      expect(
        waveCheck('task-c', ['--checks', emptyChecksPath, '--project', repo.projectDir]).status,
      ).toBe(0);
    });

    it('reads no git state without a post-merge entry, not even a repository', () => {
      const run = held(['--checks', emptyChecksPath, '--project', scratch]);
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ held: [], uncertified_merges: [] });
    });

    it('does not swallow other errors: a non-integration project is still refused', () => {
      const run = held(['--epic', 'no-such-shape/../x']);
      expect(run.status).toBe(1);
    });
  });

  describe('wave check --session without --checks', () => {
    const tiered = async (tiersPresent: string[], extra: Record<string, unknown> = {}) => {
      const { sessionId, eventsDir, planPath: p } = await fx.session();
      fx.ingest(p, sessionId, eventsDir);
      fx.append(sessionId, eventsDir, {
        event_type: 'integration-check',
        payload: {
          epic_id: EPIC,
          branch: `bs/${EPIC}/integration`,
          head_sha: 'a'.repeat(40),
          pass: true,
          results: [],
          tiers_present: tiersPresent,
          ...extra,
        },
      });
      return runCli([
        'wave',
        'check',
        p,
        q('task-1'),
        '--dry',
        '--session',
        sessionId,
        '--state-dir',
        eventsDir,
        '--plan-version',
        '1',
        '--causal-parent',
        `${sessionId}#0`,
      ]);
    };

    it('is refused with wave.checks-required once a post-merge record exists', async () => {
      const run = await tiered(['pre-merge', 'post-merge']);
      expect(run.status).toBe(1);
      expect(run.stdout + run.stderr).toContain('wave.checks-required');
    });

    it('is refused on a pre-release-only record and on a probe', async () => {
      const release = await tiered(['pre-merge', 'pre-release']);
      expect(release.stdout + release.stderr).toContain('wave.checks-required');
      const probe = await tiered(['pre-merge'], { probe_of: 'x#1' });
      expect(probe.stdout + probe.stderr).toContain('wave.checks-required');
    });

    it('behaves as on the base for pre-merge-only records', async () => {
      const run = await tiered(['pre-merge']);
      expect(run.status).toBe(0);
    });
  });
});
