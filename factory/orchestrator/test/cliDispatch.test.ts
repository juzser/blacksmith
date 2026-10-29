import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_PATH, dispatchStore, REPO_ROOT, runCli } from './helpers/cliHarness.js';
import { runOrThrow } from './helpers/process.js';

// Part of the former cli.test.ts, split along its describe blocks so vitest runs
// the parts on separate workers. cli.ts is thin argv->module wiring (excluded from
// the coverage floor, like UI glue per stack.md); it is verified end-to-end here
// as a built binary, the way it actually runs (`smith <ns> <action> ...`).
// Shared harness: helpers/cliHarness.ts.

describe('cli.ts (built binary)', () => {
  let scratchDir: string;

  // dist/ is built once for the whole run by test/globalSetup.ts, not here:
  // guardHook.test.ts execs the same binary, and two parallel vitest workers
  // emitting into one dist/ while a third reads it is a race. Each file of the
  // old single cli.test.ts now owns its scratch directory, so none depends on
  // another having run first.
  beforeAll(async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), 'smith-cli-'));
  });

  afterAll(async () => {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  // P9-23. crosscheck.yml's `finder_ne_critic` — spec-reviewer never on the
  // planner's model, verifier never on the reviewer's — was prose nothing
  // read, and the log could not have answered it anyway: `dispatch_decision`
  // carried `model_tier`, and opus and fable are both `frontier`. `model` is
  // now a required dispatch dimension, and this verb is the "after the fact"
  // the punch list asks for.
  describe('dispatch check (P9-23)', () => {
    function seed(
      sessionId: string,
      eventsDir: string,
      dispatches: Array<{ role: string; provider: string; tier: string; model: string }>,
    ): void {
      const start = runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        }),
        '--state-dir',
        eventsDir,
      ]);
      expect(start.status).toBe(0);
      let parent = JSON.parse(start.stdout).event_id as string;
      for (const d of dispatches) {
        const appended = runCli([
          'event',
          'append',
          JSON.stringify({
            session_id: sessionId,
            actor: 'planner',
            event_type: 'dispatch_decision',
            task_id: 'epic-23/task-1',
            plan_version: 1,
            causal_parent: parent,
            payload: {
              agent_role: d.role,
              provider: d.provider,
              model_tier: d.tier,
              model: d.model,
            },
          }),
          '--state-dir',
          eventsDir,
        ]);
        expect(appended.status).toBe(0);
        parent = JSON.parse(appended.stdout).event_id as string;
      }
    }

    it('exits 0 when the critic ran on a different model than the finder it followed', () => {
      const sessionId = `cli-dispatch-ok-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'dispatch-ok-events');
      seed(sessionId, eventsDir, [
        { role: 'planner', provider: 'claude', tier: 'frontier', model: 'claude-opus-5' },
        { role: 'spec-reviewer', provider: 'codex', tier: 'frontier', model: 'gpt-5-codex' },
      ]);

      const { stdout, status } = runCli(['dispatch', 'check', sessionId, '--state-dir', eventsDir]);
      expect(status).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.ok).toBe(true);
      expect(report.sessionId).toBe(sessionId);
      const planCheck = report.checks.find((c: { critic: string }) => c.critic === 'spec-reviewer');
      expect(planCheck.status).toBe('ok');
      expect(planCheck.criticModel).toBe('gpt-5-codex');
      expect(planCheck.finderModel).toBe('claude-opus-5');
    });

    it('exits 1 and names both events when the critic ran on the finder’s own model', () => {
      const sessionId = `cli-dispatch-bad-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'dispatch-bad-events');
      // Same tier *and* same model: the tier alone would have called this a
      // pass under every previous version of the log.
      seed(sessionId, eventsDir, [
        { role: 'planner', provider: 'claude', tier: 'frontier', model: 'claude-opus-5' },
        { role: 'spec-reviewer', provider: 'claude', tier: 'frontier', model: 'claude-opus-5' },
      ]);

      const { stdout, status } = runCli(['dispatch', 'check', sessionId, '--state-dir', eventsDir]);
      expect(status).toBe(1);
      const report = JSON.parse(stdout);
      expect(report.ok).toBe(false);
      const violation = report.checks.find((c: { status: string }) => c.status === 'violation');
      expect(violation.finder).toBe('planner');
      expect(violation.critic).toBe('spec-reviewer');
      expect(violation.criticModel).toBe('claude-opus-5');
      expect(violation.detail).toContain('claude-opus-5');
    });

    it('names the missing session id instead of reporting a clean session', () => {
      const { stdout, status } = runCli(['dispatch', 'check']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.message).toContain('bs dispatch check');
    });

    it('errors on an unknown session rather than answering it with an empty report', () => {
      const eventsDir = path.join(scratchDir, 'dispatch-ok-events');
      const { stdout, status } = runCli([
        'dispatch',
        'check',
        'no-such-session-p9-23',
        '--state-dir',
        eventsDir,
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('events.unknown-session');
    });
  });

  it('db rebuild + apply + stats: builds a session, projects it, and answers each stats page', () => {
    const sessionId = `cli-db-smoke-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'db-smoke-events');
    const dbPath = path.join(scratchDir, `${sessionId}.db`);

    const append1 = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      }),
      '--state-dir',
      eventsDir,
    ]);
    expect(append1.status).toBe(0);
    const rootId = JSON.parse(append1.stdout).event_id as string;

    // The plan declares the task before anything is scheduled against it: a
    // dispatch moves a task, it never mints one, so a log that dispatched a
    // task nothing declared projects no row for it (see projector.test.ts).
    const appendAdded = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'planner',
        event_type: 'task-added',
        task_id: 'epic-9/task-1',
        plan_version: 1,
        causal_parent: rootId,
        payload: { task_id: 'epic-9/task-1', epic_id: 'epic-9' },
      }),
      '--state-dir',
      eventsDir,
    ]);
    expect(appendAdded.status).toBe(0);
    const addedId = JSON.parse(appendAdded.stdout).event_id as string;

    const append2 = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'planner',
        event_type: 'dispatch_decision',
        task_id: 'epic-9/task-1',
        plan_version: 1,
        causal_parent: addedId,
        payload: {
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
        },
      }),
      '--state-dir',
      eventsDir,
    ]);
    expect(append2.status).toBe(0);

    const rebuildResult = runCli([
      'db',
      'rebuild',
      '--db',
      dbPath,
      '--session',
      sessionId,
      '--state-dir',
      eventsDir,
    ]);
    expect(rebuildResult.status).toBe(0);
    expect(JSON.parse(rebuildResult.stdout)).toEqual({
      sessionsProcessed: 1,
      eventsApplied: 3,
      skippedFindings: [],
      skippedArtifacts: [],
      unreadableSessions: [],
    });

    const overviewResult = runCli(['stats', 'overview', '--db', dbPath, '--session', sessionId]);
    expect(overviewResult.status).toBe(0);
    const overview = JSON.parse(overviewResult.stdout);
    expect(overview.liveAgentCount).toBe(1);
    expect(overview.liveAgents).toEqual([
      { agentRole: 'coder', provider: 'claude', modelTier: 'mid', count: 1 },
    ]);

    const timelineResult = runCli(['stats', 'timeline', '--db', dbPath, '--session', sessionId]);
    expect(timelineResult.status).toBe(0);
    // All three appended events. The old assertion here was `toHaveLength(1)`:
    // session-start was written as the root of the log and then dropped by
    // timeline()'s eventType filter, so the CLI's own smoke test recorded the
    // log's first event as invisible. Asserting the types rather than the
    // count says which three.
    expect(
      (JSON.parse(timelineResult.stdout) as { eventType: string }[]).map((e) => e.eventType),
    ).toEqual(['session-start', 'task-added', 'dispatch_decision']);

    const kanbanResult = runCli([
      'stats',
      'kanban',
      '--db',
      dbPath,
      '--session',
      sessionId,
      '--epic',
      'epic-9',
    ]);
    expect(kanbanResult.status).toBe(0);
    // The task id carries its epic, so `--epic epic-9` finds this task from
    // the id alone (D-49/P9-10). Before that, a dispatched task showed up in
    // `stats overview` as a live agent and in `stats kanban --epic` as
    // nothing at all.
    const kanban = JSON.parse(kanbanResult.stdout) as Array<{
      taskStatus: string;
      tasks: Array<{ taskId: string }>;
    }>;
    expect(kanban).toHaveLength(1);
    expect(kanban[0]?.taskStatus).toBe('in-progress');
    expect(kanban[0]?.tasks.map((t) => t.taskId)).toEqual(['epic-9/task-1']);

    // The dispatch moved the declared task to "in-progress"; the row carries
    // no case/origin/claims because this `task-added` named none.
    const taskResult = runCli(['stats', 'task', '--db', dbPath, '--task', 'epic-9/task-1']);
    expect(taskResult.status).toBe(0);
    const taskDetailJson = JSON.parse(taskResult.stdout);
    expect(taskDetailJson.task).toMatchObject({
      taskId: 'epic-9/task-1',
      taskStatus: 'in-progress',
    });
    expect(taskDetailJson.attempts).toHaveLength(1);

    const missingTaskResult = runCli(['stats', 'task', '--db', dbPath, '--task', 'no/such-task']);
    expect(missingTaskResult.status).toBe(1);

    const lessonsResult = runCli(['stats', 'lessons', '--db', dbPath, '--session', sessionId]);
    expect(lessonsResult.status).toBe(0);
    // Three buckets, one per bucket the taxonomy's six statuses map to: a
    // status in no bucket is a lesson no reader can reach (D-220).
    // No dream pass has run on this db, so there is no "last checked" time yet.
    expect(JSON.parse(lessonsResult.stdout)).toEqual({
      pending: [],
      approved: [],
      closed: [],
      lastCheckedAt: null,
    });

    const errorsResult = runCli(['stats', 'errors', '--db', dbPath, '--session', sessionId]);
    expect(errorsResult.status).toBe(0);
    expect(JSON.parse(errorsResult.stdout)).toEqual({ byClass: [], byDay: [], classSummary: [] });

    const analyticsResult = runCli(['stats', 'analytics', '--db', dbPath, '--session', sessionId]);
    expect(analyticsResult.status).toBe(0);
    expect(JSON.parse(analyticsResult.stdout)).toEqual({
      throughput: [],
      costByModelTierAndProvider: [],
      sameMistakeRateByDay: [],
      recheckOutcomes: [],
      // Exhaustive on purpose: the Analytics page renders whatever keys this
      // payload carries, so a key added to the query and forgotten here is a
      // card the dashboard never gets (D-255).
      providerAgreement: [],
    });

    // db apply is incremental-refresh-one-session; re-running it after no new
    // events is a no-op that still reports the same event count.
    const applyResult = runCli([
      'db',
      'apply',
      '--db',
      dbPath,
      '--session',
      sessionId,
      '--state-dir',
      eventsDir,
    ]);
    expect(applyResult.status).toBe(0);
    expect(JSON.parse(applyResult.stdout)).toEqual({
      sessionsProcessed: 1,
      eventsApplied: 3,
      skippedFindings: [],
      skippedArtifacts: [],
      unreadableSessions: [],
    });
  });

  /**
   * Both db verbs rebuild the ENTIRE milestones table from a roadmap file
   * (projector.ts's projectMilestones deletes and re-inserts), and
   * dbOptsFromFlags dropped `--roadmap-path` — so `db rebuild --db
   * <other-project>.db` replaced that project's milestones with blacksmith's
   * own factory/specs/roadmap.md. Same defect `ui serve` had on the read path;
   * this is the write path, and here the wrong rows are persisted.
   */
  it('db rebuild --roadmap-path projects that roadmap, never blacksmith own', () => {
    const sessionId = `cli-db-roadmap-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'db-roadmap-events');
    const dbPath = path.join(scratchDir, `${sessionId}.db`);
    const roadmapPath = path.join(scratchDir, `${sessionId}-roadmap.md`);
    // An id no milestone in factory/specs/roadmap.md has, so "the db holds MY
    // roadmap" cannot be satisfied by the fallback.
    writeFileSync(
      roadmapPath,
      '## Phase Z — another project entirely\n- id: phase-z\n- status: planned\n- epics: []\n',
    );

    const append = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      }),
      '--state-dir',
      eventsDir,
    ]);
    expect(append.status).toBe(0);

    const rebuildResult = runCli([
      'db',
      'rebuild',
      '--db',
      dbPath,
      '--session',
      sessionId,
      '--state-dir',
      eventsDir,
      '--roadmap-path',
      roadmapPath,
    ]);
    expect(rebuildResult.status).toBe(0);

    const roadmapResult = runCli(['stats', 'roadmap', '--db', dbPath]);
    expect(roadmapResult.status).toBe(0);
    const milestones = JSON.parse(roadmapResult.stdout) as Array<{ milestoneId: string }>;
    expect(milestones.map((m) => m.milestoneId)).toEqual(['phase-z']);
  });

  it('new: scaffolds a project and registers it in an overridden roadmap.md, never the real one', () => {
    const targetDir = path.join(scratchDir, 'wt', 'cli-new-project');
    const roadmapPath = path.join(scratchDir, 'roadmap.md');
    writeFileSync(roadmapPath, '# Roadmap\n');

    const { stdout, status } = runCli([
      'new',
      'cli-new-project',
      // This suite never installs from the network. --skip-toolchain is the
      // documented offline path, and asserting on its report below is how we
      // know the skip is *reported* rather than passed off as a green.
      '--skip-toolchain',
      '--target-dir',
      targetDir,
      '--roadmap-path',
      roadmapPath,
    ]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.targetDir).toBe(targetDir);
    expect(result.branch).toBe('setup');
    expect(result.toolchain.status).toBe('skipped');
    expect(result.toolchain.reason).toBeTruthy();
    expect(result.toolchain.steps).toEqual([]);
    expect(readFileSync(path.join(targetDir, 'package.json'), 'utf8')).toContain(
      '"cli-new-project"',
    );
    expect(readFileSync(roadmapPath, 'utf8')).toContain('## cli-new-project — bootstrap');
  });

  // A scaffold whose own gates go red is the one case where `smith new` has
  // built a tree the operator must not plan an epic against yet. The report
  // says so and the exit code says so — parsing JSON to find out a command
  // failed is how a red gate gets scripted straight past (D0).
  it('new: a red toolchain step exits 1 and names the gate, leaving the tree to fix', () => {
    const targetDir = path.join(scratchDir, 'wt', 'cli-new-red');
    const roadmapPath = path.join(scratchDir, 'red-roadmap.md');
    writeFileSync(roadmapPath, '# Roadmap\n');
    // A `pnpm` on PATH that fails everything: no network, no install, and the
    // very first toolchain step goes red exactly as a broken scaffold would.
    const binDir = path.join(scratchDir, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'pnpm'), '#!/bin/sh\necho "pnpm exploded" >&2\nexit 1\n');
    chmodSync(path.join(binDir, 'pnpm'), 0o755);

    const { stdout, status } = runCli(
      ['new', 'cli-new-red', '--target-dir', targetDir, '--roadmap-path', roadmapPath],
      { PATH: `${binDir}:${process.env.PATH ?? ''}` },
    );

    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.toolchain.status).toBe('failed');
    expect(result.toolchain.failedStep).toBe('install');
    expect(result.toolchain.steps).toHaveLength(1);
    expect(result.toolchain.steps[0].command).toBe('pnpm install');
    expect(result.toolchain.steps[0].output).toContain('pnpm exploded');
    // The tree survives its own red gate — deleting it would delete the
    // evidence the operator needs to fix it.
    expect(existsSync(path.join(targetDir, 'package.json'))).toBe(true);
  });

  // AC3: the row shape a human-invoked inventory owes an operator, not the
  // daemon's alarm shape. `--project` never gets a directory that is not
  // there, so a declared-and-missing project is marked with `?` -- distinct
  // from `*` (self) and the space that marks a resolved project -- and named
  // with both roots it was looked for under, in both the printed rows and
  // --json's own `missing` field. Exit stays 0: not finding a checkout is an
  // answer, not an error.
  it('projects list: marks a declared project with no checkout, keeps it off the --project line', () => {
    const roadmapPath = path.join(scratchDir, 'projects-list-missing-roadmap.md');
    writeFileSync(
      roadmapPath,
      '# Roadmap\n\n## missing-bootstrap\n- id: missing-bootstrap\n' +
        '- status: completed\n- project: cli-projects-missing-xyz\n' +
        '- epics: []\n- goal: whatever.\n',
    );

    const printed = runCli(['projects', 'list', '--roadmap', roadmapPath]);
    expect(printed.status).toBe(0);
    expect(printed.stdout).toContain('? cli-projects-missing-xyz\t');
    expect(printed.stdout).not.toMatch(/--project [^\n]*cli-projects-missing-xyz/);

    const json = runCli(['projects', 'list', '--roadmap', roadmapPath, '--json']);
    expect(json.status).toBe(0);
    const result = JSON.parse(json.stdout);
    expect(result.missing).toEqual([expect.objectContaining({ name: 'cli-projects-missing-xyz' })]);
    expect(
      (result.projects as Array<{ name: string }>).some(
        (p) => p.name === 'cli-projects-missing-xyz',
      ),
    ).toBe(false);
    expect(result.flags).not.toContain('cli-projects-missing-xyz');
  });

  // The degenerate case above only ever has self and one missing project, so
  // it cannot tell `?` apart from the space that marks an ordinary resolved
  // project -- a test that only checks `?` is present would still pass if
  // `*` were later reused for missing too. This roadmap declares one project
  // that resolves and one that does not, so all three markers (`*`, ` `, `?`)
  // are on one page together, and the --json shape is read as a whole: the
  // pre-existing `projects` entries keep their old fields, `missing` sits
  // beside them rather than folding into them.
  it('projects list: three markers on one page, and --json adds missing beside projects, not into it', () => {
    const workspace = path.join(REPO_ROOT, 'workspaces', 'cli-projects-present-xyz');
    mkdirSync(workspace, { recursive: true });
    try {
      const roadmapPath = path.join(scratchDir, 'projects-list-mixed-roadmap.md');
      writeFileSync(
        roadmapPath,
        '# Roadmap\n\n## present-bootstrap\n- id: present-bootstrap\n' +
          '- status: completed\n- project: cli-projects-present-xyz\n' +
          '- epics: []\n- goal: whatever.\n\n' +
          '## missing-bootstrap\n- id: missing-bootstrap\n' +
          '- status: completed\n- project: cli-projects-missing-xyz\n' +
          '- epics: []\n- goal: whatever.\n',
      );

      const printed = runCli(['projects', 'list', '--roadmap', roadmapPath]);
      expect(printed.status).toBe(0);
      const rows = printed.stdout.split('\n');
      expect(rows.some((r) => /^\* /.test(r))).toBe(true);
      expect(rows.some((r) => /^ {2}cli-projects-present-xyz\t/.test(r))).toBe(true);
      expect(rows.some((r) => /^\? cli-projects-missing-xyz\t/.test(r))).toBe(true);
      expect(printed.stdout).toMatch(/--project [^\n]*cli-projects-present-xyz/);
      expect(printed.stdout).not.toMatch(/--project [^\n]*cli-projects-missing-xyz/);

      const json = runCli(['projects', 'list', '--roadmap', roadmapPath, '--json']);
      const result = JSON.parse(json.stdout);
      expect(result.projects).toEqual([
        expect.objectContaining({ name: 'blacksmith', self: true }),
        expect.objectContaining({ name: 'cli-projects-present-xyz', self: false }),
      ]);
      expect(result.missing).toEqual([
        expect.objectContaining({ name: 'cli-projects-missing-xyz' }),
      ]);
    } finally {
      rmSync(path.join(REPO_ROOT, 'workspaces'), { recursive: true, force: true });
    }
  });

  it('mcp init: layers the surface onto a scaffolded project and makes the milestone due', () => {
    const targetDir = path.join(scratchDir, 'wt', 'cli-mcp-project');
    const roadmapPath = path.join(scratchDir, 'mcp-roadmap.md');
    writeFileSync(roadmapPath, '# Roadmap\n');
    // --roadmap-path on both calls: the real factory/specs/roadmap.md is never
    // a test fixture, and `new` writes to it too.
    runOrThrow('node', [
      CLI_PATH,
      'new',
      'cli-mcp-project',
      '--skip-toolchain',
      '--target-dir',
      targetDir,
      '--roadmap-path',
      roadmapPath,
    ]);

    const { stdout, status } = runCli([
      'mcp',
      'init',
      'cli-mcp-project',
      '--target-dir',
      targetDir,
      '--roadmap-path',
      roadmapPath,
    ]);

    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.transport).toBe('stdio');
    expect(result.milestoneId).toBe('cli-mcp-project-mcp-surface');
    expect(JSON.parse(readFileSync(path.join(targetDir, 'mcp.manifest.json'), 'utf8')).name).toBe(
      'cli-mcp-project',
    );
    expect(readFileSync(roadmapPath, 'utf8')).toContain('## cli-mcp-project — mcp surface');
  });

  // The exit code is the whole interface for CI: a gate that only prints its
  // verdict is a gate whose caller has to parse JSON to find out it failed.
  it('mcp check: exit 0 on a fresh surface, exit 1 once the manifest drifts off the pin', () => {
    const targetDir = path.join(scratchDir, 'wt', 'cli-mcp-check');
    const roadmapPath = path.join(scratchDir, 'mcp-check-roadmap.md');
    writeFileSync(roadmapPath, '# Roadmap\n');
    for (const argv of [
      // --skip-toolchain: this suite never installs from the network.
      ['new', 'cli-mcp-check', '--skip-toolchain'],
      ['mcp', 'init', 'cli-mcp-check'],
    ]) {
      runOrThrow('node', [
        CLI_PATH,
        ...argv,
        '--target-dir',
        targetDir,
        '--roadmap-path',
        roadmapPath,
      ]);
    }

    const green = runCli([
      'mcp',
      'check',
      'cli-mcp-check',
      '--target-dir',
      targetDir,
      '--roadmap-path',
      roadmapPath,
    ]);
    expect(green.status).toBe(0);
    expect(JSON.parse(green.stdout).violations).toEqual([]);
    // D-133: a green verdict has to name what it graded. Without this the same
    // exit 0 was printed whether the manifest under test or a sibling checkout's
    // was parsed, and nothing in the output distinguished the two.
    expect(JSON.parse(green.stdout).targetDir).toBe(targetDir);
    expect(JSON.parse(green.stdout).targetSource).toBe('flag');

    const manifestPath = path.join(targetDir, 'mcp.manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.protocolRevision = '1999-01-01';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const red = runCli([
      'mcp',
      'check',
      'cli-mcp-check',
      '--target-dir',
      targetDir,
      '--roadmap-path',
      roadmapPath,
    ]);
    expect(red.status).toBe(1);
    expect(JSON.parse(red.stdout).violations.map((v: { rule: string }) => v.rule)).toEqual([
      'MCP-P1',
    ]);
  });

  it('scheduler run --dry computes proposals without appending events', () => {
    const sessionId = `cli-scheduler-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'scheduler-events');

    const rootResult = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      }),
      '--state-dir',
      eventsDir,
    ]);
    expect(rootResult.status).toBe(0);

    const { stdout, status } = runCli([
      'scheduler',
      'run',
      '--session',
      sessionId,
      '--dry',
      'true',
      // This clone is in the pass by default; --no-self keeps this test's
      // scope to the session-event question it actually asks rather than
      // this checkout's own dependency state.
      '--no-self',
      '--state-dir',
      eventsDir,
    ]);
    expect(status).toBe(0);
    const { proposals } = JSON.parse(stdout);
    // No tasks yet -> only the growth-review-due trigger fires (first-ever).
    expect(proposals).toEqual([{ kind: 'growth-review-due', cadenceDays: 30, lastReviewAt: null }]);

    const tailResult = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir]);
    expect(JSON.parse(tailResult.stdout)).toHaveLength(1); // dry run appended nothing
  });

  // `--no-self` is declared in usage.ts for this command (docCommands.test.ts
  // checks it); this pins that the parser actually accepts it rather than
  // failing "unknown flag", which a doc-only declaration would not catch.
  it('scheduler run --dry accepts --no-self', () => {
    const sessionId = `cli-scheduler-noself-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'scheduler-noself-events');
    runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      }),
      '--state-dir',
      eventsDir,
    ]);
    const { status } = runCli([
      'scheduler',
      'run',
      '--session',
      sessionId,
      '--dry',
      'true',
      '--no-self',
      '--state-dir',
      eventsDir,
    ]);
    expect(status).toBe(0);
  });

  // S1-b: `scheduler run` used to compute error-report fingerprints with no
  // project resolver at all (scheduler.ts's `() => null` default), while
  // `issues report`/`preview` resolved the same row through
  // `planProjectResolverForTaskRefOrSelf`. Two different `project` values
  // hashed into two different fingerprints for the same underlying row, so
  // a real report's `issue-reported` event -- keyed by fingerprint +
  // latest_event_id -- never matched the proposal `scheduler run` kept
  // re-appending. Proven two ways: the fingerprint `scheduler run` computes
  // must equal the one `issues preview` computes for the same row, and a
  // hand-appended `issue-reported` row carrying that shared fingerprint
  // must clear the proposal on the next tick.
  it('scheduler run resolves error-report projects the same way issues preview does, so a report clears the proposal (S1-b)', () => {
    const sessionId = `cli-scheduler-clears-${Date.now()}`;
    const eventsDir = path.join(scratchDir, `${sessionId}-events`);
    const specsDir = path.join(scratchDir, `${sessionId}-specs`);
    mkdirSync(path.join(specsDir, 'epic-1'), { recursive: true });
    writeFileSync(
      path.join(specsDir, 'epic-1', 'plan-v1.json'),
      JSON.stringify({
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        project: 'explicit-project',
        tasks: [],
        edges: [],
      }),
    );

    const append = (event: Record<string, unknown>) => {
      const run = runCli(['event', 'append', JSON.stringify(event), '--state-dir', eventsDir]);
      expect(run.status).toBe(0);
      return JSON.parse(run.stdout).event_id as string;
    };
    const base = { session_id: sessionId, actor: 'system', plan_version: 1 };
    const rootId = append({
      ...base,
      event_type: 'session-start',
      causal_parent: null,
      payload: {},
    });
    append({
      ...base,
      event_type: 'gate-outcome',
      task_id: 'epic-1/task-a',
      causal_parent: rootId,
      payload: { outcome: 'blocked', reason: 'tests-failed' },
    });

    const previewFlags = [
      '--session',
      sessionId,
      '--specs-dir',
      specsDir,
      '--state-dir',
      eventsDir,
    ];
    const preview = runCli(['issues', 'preview', ...previewFlags]);
    expect(preview.status).toBe(0);
    const [previewRecord] = JSON.parse(preview.stdout);
    expect(previewRecord.project).toBe('explicit-project');

    const schedulerFlags = [
      'scheduler',
      'run',
      '--session',
      sessionId,
      '--dry',
      'true',
      '--specs-dir',
      specsDir,
      '--no-self',
      '--state-dir',
      eventsDir,
    ];
    type ErrorReportProposalJson = {
      kind: string;
      project: string | null;
      fingerprint: string;
      taskRef: string;
      source: string;
      errorClass: string;
      latestEventId: string;
    };
    const firstRun = runCli(schedulerFlags);
    expect(firstRun.status).toBe(0);
    const firstProposals: ErrorReportProposalJson[] = JSON.parse(firstRun.stdout).proposals;
    const errorProposal = firstProposals.find((p) => p.kind === 'error-report');
    if (!errorProposal) throw new Error('expected an error-report proposal in the first run');
    expect(errorProposal.project).toBe('explicit-project');
    expect(errorProposal.fingerprint).toBe(previewRecord.fingerprint);

    // The `issue-reported` row the real reporter would append for this exact
    // fingerprint/latest-event pair (issueReporter.ts's `appendIssueReported`
    // and its `ISSUE_REPORT_PAYLOAD_KEYS` allowlist) -- proposeErrorReports
    // clears a proposal by that pair alone (scheduler.ts's `answered` set).
    append({
      ...base,
      event_type: 'issue-reported',
      task_id: errorProposal.taskRef,
      causal_parent: errorProposal.latestEventId,
      project: errorProposal.project,
      payload: {
        outcome: 'opened',
        fingerprint: errorProposal.fingerprint,
        source: errorProposal.source,
        error_class: errorProposal.errorClass,
        task_ref: errorProposal.taskRef,
        latest_event_id: errorProposal.latestEventId,
        repo_slug: 'juzser/explicit-project',
        issue_url: 'https://github.com/juzser/explicit-project/issues/1',
      },
    });

    const secondRun = runCli(schedulerFlags);
    expect(secondRun.status).toBe(0);
    const secondProposals: ErrorReportProposalJson[] = JSON.parse(secondRun.stdout).proposals;
    expect(secondProposals.some((p) => p.kind === 'error-report')).toBe(false);
  });

  // `scheduler admit` is the second half of the same tick: `run --dry` says
  // what is due, this says which of it may proceed without an operator. It is
  // a report and only a report -- the whole point of splitting it out of
  // `run` is that the classification can be read and argued with before
  // anything moves, so it appends nothing and dispatches nothing.
  it('scheduler admit classifies proposals and writes nothing', () => {
    const sessionId = `cli-admit-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'admit-events');

    const rootResult = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      }),
      '--state-dir',
      eventsDir,
    ]);
    expect(rootResult.status).toBe(0);

    const { stdout, status } = runCli([
      'scheduler',
      'admit',
      '--session',
      sessionId,
      // See the --dry test above: keep this clone out so the assertions
      // below stay about admission classification, not this checkout's
      // own dependency state.
      '--no-self',
      '--state-dir',
      eventsDir,
    ]);
    expect(status).toBe(0);
    const { admissions } = JSON.parse(stdout);
    // Same input as the `--dry` test above, so the same single proposal --
    // and growth review is the one kind autonomy.ts denies ahead of the
    // whitelist, so a shipped policy with `enabled: true` still holds it.
    expect(admissions).toHaveLength(1);
    expect(admissions[0].proposal.kind).toBe('growth-review-due');
    expect(admissions[0].decision).toBe('operator');
    expect(admissions[0].code).toBe('growth-never-auto');
    expect(admissions[0].subject).toContain('product-growth review');
    expect(typeof admissions[0].reason).toBe('string');

    const tailResult = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir]);
    expect(JSON.parse(tailResult.stdout)).toHaveLength(1); // admitting appended nothing

    // No event appended means no id to chain a follower off, so the printed
    // object carries no event_id key at all -- not an absent/undefined one,
    // a missing one, the same convention `findings raise` uses for a
    // suppressed finding.
    expect('event_id' in JSON.parse(stdout)).toBe(false);
  });

  // Same reason as `scheduler run --dry accepts --no-self`: a flag declared
  // only in usage.ts and never parsed would fail this with "unknown flag".
  it('scheduler admit accepts --no-self', () => {
    const sessionId = `cli-admit-noself-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'admit-noself-events');
    runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      }),
      '--state-dir',
      eventsDir,
    ]);
    const { status } = runCli([
      'scheduler',
      'admit',
      '--session',
      sessionId,
      '--no-self',
      '--state-dir',
      eventsDir,
    ]);
    expect(status).toBe(0);
  });

  // The wiring the test above cannot see. A RecheckProposal names a task id and
  // no paths, so the security match has nothing to read unless cli.ts folds the
  // log's claims in and hands them over. Pass an empty map instead and this
  // recheck comes back `auto` -- the task id "epic-1/task-1" matches no keyword,
  // and `time-elapsed` is whitelisted below on purpose so that `auto` is exactly
  // what a missing fold would produce. The claim is the only thing that holds it.
  it("scheduler admit matches security keywords against the log's claims, not just the task id", () => {
    const sessionId = `cli-admit-sec-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'admit-sec-events');

    const root = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      }),
      '--state-dir',
      eventsDir,
    ]);
    expect(root.status).toBe(0);
    const rootId = JSON.parse(root.stdout).event_id as string;

    for (const record of [
      {
        actor: 'planner',
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        payload: {
          epic_id: 'epic-1',
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          claims: ['src/auth/session.ts'],
        },
      },
      {
        actor: 'system',
        event_type: 'wave-merged',
        payload: { epic_id: 'epic-1', task_ids: ['epic-1/task-1'] },
      },
    ]) {
      const appended = runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          plan_version: 1,
          causal_parent: rootId,
          ...record,
        }),
        '--state-dir',
        eventsDir,
      ]);
      expect(appended.status).toBe(0);
    }

    // Its own policy rather than factory/policies/scheduler.yml: this asserts a
    // wiring, and retuning the shipped whitelist must not be able to turn that
    // assertion into a different one.
    const policyPath = path.join(scratchDir, 'admit-sec-scheduler.yml');
    writeFileSync(
      policyPath,
      [
        'recheck:',
        '  merge_threshold: 5',
        '  days_elapsed: 14',
        '  confidence_threshold: 0.6',
        'maintenance:',
        '  auto_schedule_confidence: 0.8',
        // A cadence no fixture can reach, so the only proposal here is the recheck.
        'growth:',
        '  cadence_days: 36500',
        'autonomy:',
        '  enabled: true',
        '  auto_dispatch_kinds: [recheck]',
        '  auto_dispatch_recheck_reasons: [merge-threshold, time-elapsed]',
        '  confidence_floor: 0.8',
        '',
      ].join('\n'),
    );

    // appendEvent stamps its own `ts`, so the fixture's merge is at real now;
    // 30 days past it is the only spelling of "T days elapsed" that is not a
    // fixed date waiting to expire.
    const now = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { stdout, status } = runCli([
      'scheduler',
      'admit',
      '--session',
      sessionId,
      '--state-dir',
      eventsDir,
      '--policy',
      policyPath,
      '--now',
      now,
    ]);
    expect(status).toBe(0);

    const { admissions } = JSON.parse(stdout);
    const admission = admissions.find(
      (a: { proposal: { kind: string } }) => a.proposal.kind === 'recheck',
    );
    expect(admission).toBeDefined();
    expect(admission.proposal.reasons).toEqual(['time-elapsed']);
    expect(admission.decision).toBe('operator');
    expect(admission.code).toBe('security-surface');
    // Names the claim that held it and the keyword it matched, so the operator
    // can argue with the rule rather than guess at it.
    expect(admission.reason).toContain('src/auth/session.ts');
    expect(admission.reason).toContain('auth');

    // A log with no growth review in it always proposes one, so the cadence
    // above cannot suppress that second proposal -- but it can be read back off
    // it. `--policy` has to govern which proposals EXIST as well as who may say
    // yes to them; a file consulted only for `autonomy:` would answer 30 here,
    // from the shipped scheduler.yml the operator did not point at.
    const growth = admissions.find(
      (a: { proposal: { kind: string } }) => a.proposal.kind === 'growth-review-due',
    );
    expect(growth.proposal.cadenceDays).toBe(36500);
  });

  // D-201's tail. `quorum-decision` has been written on every cross-check case
  // since the gate shipped and nothing read one back, so "which disagreements
  // is the operator still owed?" had no answer at all. This is the answer, and
  // the exit code is the half a script can read: 1 is a disagreement to settle,
  // 2 is a config that gated nothing, and they are different jobs.
  it('judge escalations lists open disagreements and scores them', () => {
    const eventsDir = path.join(scratchDir, 'escalations-events');

    function seed(sessionId: string, payloads: Record<string, unknown>[]): void {
      const root = runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        }),
        '--state-dir',
        eventsDir,
      ]);
      expect(root.status).toBe(0);
      const rootId = JSON.parse(root.stdout).event_id as string;

      for (const payload of payloads) {
        const appended = runCli([
          'event',
          'append',
          JSON.stringify({
            session_id: sessionId,
            actor: 'system',
            event_type: 'quorum-decision',
            task_id: String(payload.task_id),
            plan_version: 1,
            causal_parent: rootId,
            payload,
          }),
          '--state-dir',
          eventsDir,
        ]);
        expect(appended.status).toBe(0);
      }
    }

    function escalation(over: Record<string, unknown>): Record<string, unknown> {
      return {
        task_id: 'epic-1/task-1',
        finding_id: 'f1',
        fingerprint: 'fp-1',
        trigger_reason: 'severity-s1',
        finder_provider: 'claude',
        outcome: 'escalate',
        escalation_reason: 'disagreement',
        rationales: [{ provider: 'codex', verdict: 'refute', rationale: 'guarded above' }],
        participants: [
          {
            provider: 'claude',
            mode: 'native',
            ok: true,
            verdict: 'confirm',
            excluded_as_finder: true,
          },
        ],
        blocks: true,
        ...over,
      };
    }

    const mixed = `cli-esc-mixed-${Date.now()}`;
    seed(mixed, [
      escalation({}),
      escalation({ fingerprint: 'fp-2', escalation_reason: 'insufficient-providers' }),
      escalation({ fingerprint: 'fp-3', escalation_reason: 'insufficient-providers' }),
      // Settled on a later run, so it is not owed any more.
      escalation({ fingerprint: 'fp-4' }),
      escalation({
        fingerprint: 'fp-4',
        outcome: 'decided',
        escalation_reason: null,
        blocks: false,
      }),
    ]);

    const run = runCli(['judge', 'escalations', '--session', mixed, '--state-dir', eventsDir]);
    expect(run.status).toBe(1);
    const summary = JSON.parse(run.stdout);
    expect(summary.disagreements).toHaveLength(1);
    expect(summary.disagreements[0].fingerprint).toBe('fp-1');
    expect(summary.disagreements[0].held).toBe(true);
    expect(summary.ungated.count).toBe(2);
    expect(summary.ungated.hint).toContain('crosscheck.yml');

    // Nothing gated is not the same as nothing wrong, and 0 would have said it was.
    const ungatedOnly = `cli-esc-ungated-${Date.now()}`;
    seed(ungatedOnly, [escalation({ escalation_reason: 'insufficient-providers' })]);
    const second = runCli([
      'judge',
      'escalations',
      '--session',
      ungatedOnly,
      '--state-dir',
      eventsDir,
    ]);
    expect(second.status).toBe(2);
    expect(JSON.parse(second.stdout).disagreements).toEqual([]);

    const clean = `cli-esc-clean-${Date.now()}`;
    seed(clean, []);
    const third = runCli(['judge', 'escalations', '--session', clean, '--state-dir', eventsDir]);
    expect(third.status).toBe(0);
    expect(JSON.parse(third.stdout).ungated.count).toBe(0);
  });

  // D-208. The same number has two doors and only one of them was locked.
  // Through factory/policies/scheduler.yml, parseSchedulerPolicy refuses
  // anything outside (0, 1] and says why: the novelty gate reads it directly,
  // and a degenerate value voids the gate silently. Through
  // `--novelty-threshold`, which overrides that very number, a bare
  // Number.parseFloat took whatever was typed. parseFloat('80') is 80, and
  // every Jaccard score is <= 1, so a percent-for-fraction typo fails OPEN: a
  // verbatim re-statement lands as a `candidate`, exit 0, with no
  // novelty-rejected event, and can then be approved into lessons.md, where
  // every later novelty check scores against it. parseFloat('0,7') is 0, which
  // fails the other way and rejects an unrelated lesson as a duplicate. An
  // override may only express what its source of truth is allowed to hold.
  describe('lessons raise --novelty-threshold (D-208)', () => {
    const SEED =
      'Always give each dispatched task its own git worktree so two agents never share an index.';
    // One word away from SEED: Jaccard 0.75 over 3-shingles, which sits between
    // the 0.8 written to the policy file below and the 0.7 override.
    const NEAR =
      'Always give each dispatched task its own git worktree so two agents never share a branch.';

    // The length correction is written explicitly rather than left to default,
    // because on a sixteen-word pair it caps every bar at 0.647 and the two
    // thresholds under test here — the file's and the flag's — become the same
    // number. D-208 is about which of them wins; it is tested with the
    // correction off so that precedence is the only variable, and the last
    // case in the test turns it back on to show it reaches the gate.
    const policyAt = (threshold: number, lengthAware = false): string => {
      const file = path.join(scratchDir, `d208-scheduler-${threshold}-${lengthAware}.yml`);
      writeFileSync(
        file,
        [
          'recheck:',
          '  merge_threshold: 5',
          '  days_elapsed: 14',
          '  confidence_threshold: 0.6',
          'maintenance:',
          '  auto_schedule_confidence: 0.8',
          '  major_bump_confidence: 0.5',
          '  minor_or_patch_confidence: 0.9',
          'growth:',
          '  cadence_days: 30',
          'lessons:',
          `  novelty_jaccard_threshold: ${threshold}`,
          '  shingle_size: 3',
          `  novelty_length_aware: ${lengthAware}`,
          '',
        ].join('\n'),
        'utf8',
      );
      return file;
    };

    const seed = (tag: string): { sessionId: string; eventsDir: string; rootId: string } => {
      const sessionId = `cli-d208-${tag}-${Date.now()}`;
      const eventsDir = path.join(scratchDir, `d208-${tag}-events`);
      const started = runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        }),
        '--state-dir',
        eventsDir,
      ]);
      expect(started.status).toBe(0);
      return { sessionId, eventsDir, rootId: JSON.parse(started.stdout).event_id as string };
    };

    const raise = (
      s: { sessionId: string; eventsDir: string; rootId: string },
      statement: string,
      lessonId: string,
      extra: string[] = [],
    ): { stdout: string; stderr: string; status: number } =>
      runCli([
        'lessons',
        'raise',
        '--statement',
        statement,
        '--lesson-type',
        'rule',
        '--lesson-scope',
        'stack-wide',
        '--lesson-id',
        lessonId,
        '--provenance',
        s.rootId,
        '--session',
        s.sessionId,
        '--plan-version',
        '1',
        '--causal-parent',
        s.rootId,
        '--state-dir',
        s.eventsDir,
        ...extra,
      ]);

    const eventCount = (s: { sessionId: string; eventsDir: string }): number => {
      const result = runCli([
        'event',
        'tail',
        s.sessionId,
        '--n',
        '100',
        '--state-dir',
        s.eventsDir,
      ]);
      expect(result.status).toBe(0);
      return (JSON.parse(result.stdout) as unknown[]).length;
    };

    it('refuses a value scheduler.yml would be refused for, and writes nothing', () => {
      const s = seed('reject');
      const first = raise(s, SEED, 'lesson-d208-seed');
      expect(first.status).toBe(0);
      expect(JSON.parse(first.stdout).novel).toBe(true);
      const before = eventCount(s);

      // 80 and 80% are the percent-for-fraction typo, and gate the wrong way
      // round: no score can reach 80, so every duplicate is "novel". 0,7 and
      // abc are what parseFloat quietly turns into 0 and NaN. 0 and -1 pin
      // every candidate as a duplicate instead. 1.5 is simply out of range.
      for (const bad of ['80', '80%', 'abc', '0,7', '0', '-1', '1.5']) {
        const result = raise(s, SEED, `lesson-d208-dup-${bad}`, ['--novelty-threshold', bad]);
        expect(result.status, `--novelty-threshold ${bad} must be refused`).toBe(1);
        const error = JSON.parse(result.stdout).error;
        expect(error.code).toBe('cli.invalid-flag');
        expect(error.message).toContain('novelty-threshold');
      }

      // Refused before the gate, so the duplicate never reached the log.
      expect(eventCount(s)).toBe(before);
    });

    it('still lets a legal override beat the policy file', () => {
      // A rejected candidate is logged either way, so each threshold gets its
      // own session: score NEAR against SEED, never against a leftover NEAR.
      const scoreNear = (
        tag: string,
        extra: string[],
        policy = policyAt(0.8),
      ): Record<string, unknown> => {
        const s = seed(tag);
        expect(raise(s, SEED, 'lesson-d208-seed', ['--policy', policy]).status).toBe(0);
        const result = raise(s, NEAR, 'lesson-d208-near', ['--policy', policy, ...extra]);
        const json = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(json.mostSimilar).toMatchObject({ statement: SEED });
        return { ...json, status: result.status };
      };

      // 0.75 < 0.8: under the file alone the near-duplicate is novel.
      expect(scoreNear('file', [])).toMatchObject({ novel: true, status: 0 });

      // 0.75 >= 0.7: the operator's one-run override still wins.
      expect(scoreNear('flag', ['--novelty-threshold', '0.7'])).toMatchObject({
        novel: false,
        status: 1,
      });

      // 1 is the inclusive end of the range the policy file is held to, so the
      // check must admit it rather than fence the flag into (0, 1).
      expect(scoreNear('one', ['--novelty-threshold', '1'])).toMatchObject({ novel: true });

      // Same pair, same 0.8 in the file, correction on (P9-35 (a)): sixteen
      // words cannot score 0.8 after a small edit, so the bar drops to 0.647
      // and the text the flat gate called novel is what it always was.
      expect(scoreNear('corrected', [], policyAt(0.8, true))).toMatchObject({
        novel: false,
        status: 1,
      });
    });

    it('holds the approve door to the same range as the raise door', () => {
      const s = seed('approve');
      expect(raise(s, SEED, 'lesson-d208-seed').status).toBe(0);
      const base = [
        '--session',
        s.sessionId,
        '--plan-version',
        '1',
        '--causal-parent',
        s.rootId,
        '--state-dir',
        s.eventsDir,
      ];

      const refused = runCli([
        'lessons',
        'approve',
        'lesson-d208-seed',
        ...base,
        '--novelty-threshold',
        '80',
      ]);
      expect(refused.status).toBe(1);
      expect(JSON.parse(refused.stdout).error.code).toBe('cli.invalid-flag');

      const accepted = runCli([
        'lessons',
        'approve',
        'lesson-d208-seed',
        ...base,
        '--novelty-threshold',
        '0.9',
      ]);
      expect(accepted.status).toBe(0);
      expect(JSON.parse(accepted.stdout)).toMatchObject({ lessonStatus: 'approved' });
    });
  });

  it('lessons for-dispatch: scopes the block to the task claims, and fails loudly', () => {
    const planPath = path.join(scratchDir, 'dispatch-plan.json');
    const lessonsPath = path.join(scratchDir, 'dispatch-lessons.md');
    writeFileSync(
      planPath,
      JSON.stringify({
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [{ task_id: 'epic-1/task-1', claims: ['factory/orchestrator/src/**'] }],
        edges: [],
      }),
      'utf8',
    );
    writeFileSync(
      lessonsPath,
      [
        '## claim-path',
        '',
        '### lesson-cli-1: loop bounds',
        '',
        '- lesson_id: lesson-cli-1',
        '- finding_category: correctness',
        '- claim_path: factory/orchestrator/src/**',
        '- statement: Check the upper loop bound against the array length.',
        '',
        '### lesson-cli-2: elsewhere',
        '',
        '- lesson_id: lesson-cli-2',
        '- finding_category: maintainability',
        '- claim_path: ui/**',
        '- statement: Never hand-edit generated UI types.',
        '',
      ].join('\n'),
      'utf8',
    );

    const scoped = runCli([
      'lessons',
      'for-dispatch',
      'coder',
      '--plan',
      planPath,
      '--task',
      'epic-1/task-1',
      '--full',
      '--state-dir',
      dispatchStore(scratchDir, 'dispatch-store-scoped'),
      '--lessons',
      lessonsPath,
    ]);
    expect(scoped.status).toBe(0);
    const parsed = JSON.parse(scoped.stdout);
    expect(parsed.lessons.map((l: { lessonId: string }) => l.lessonId)).toEqual(['lesson-cli-1']);
    expect(parsed.text).toContain('Check the upper loop bound');
    expect(parsed.text).not.toContain('lesson-cli-2');

    const unknownTask = runCli([
      'lessons',
      'for-dispatch',
      'coder',
      '--plan',
      planPath,
      '--task',
      'epic-1/task-9',
      '--lessons',
      lessonsPath,
    ]);
    expect(unknownTask.status).toBe(1);
    expect(JSON.parse(unknownTask.stdout).error.code).toBe('cli.task-not-in-plan');

    const traversal = runCli(['lessons', 'for-dispatch', '../../etc/passwd']);
    expect(traversal.status).toBe(1);
    expect(JSON.parse(traversal.stdout).error.code).toBe('lessons.invalid-role-name');

    const noRole = runCli(['lessons', 'for-dispatch']);
    expect(noRole.status).toBe(1);
    expect(JSON.parse(noRole.stdout).error.code).toBe('cli.missing-positional');
  });

  it('lessons for-dispatch: scopes to the live record of a task, never a superseded copy of it', () => {
    const planPath = path.join(scratchDir, 'dispatch-superseded-plan.json');
    const lessonsPath = path.join(scratchDir, 'dispatch-superseded-lessons.md');
    writeFileSync(
      planPath,
      JSON.stringify({
        epic_id: 'epic-1',
        version: 2,
        status: 'active',
        tasks: [
          // The dead copy sits first, under the same id, as an amendment leaves it.
          { task_id: 'epic-1/task-1', claims: ['old-area/**'], task_status: 'superseded' },
          { task_id: 'epic-1/task-1', claims: ['live-area/**'], task_status: 'todo' },
        ],
        edges: [],
      }),
      'utf8',
    );
    writeFileSync(
      lessonsPath,
      [
        '## claim-path',
        '',
        '### lesson-old-1: dead area',
        '',
        '- lesson_id: lesson-old-1',
        '- finding_category: correctness',
        '- claim_path: old-area/**',
        '- statement: Applies to the superseded record only.',
        '',
        '### lesson-live-1: live area',
        '',
        '- lesson_id: lesson-live-1',
        '- finding_category: correctness',
        '- claim_path: live-area/**',
        '- statement: Applies to the live record.',
        '',
      ].join('\n'),
      'utf8',
    );
    const scoped = runCli([
      'lessons',
      'for-dispatch',
      'coder',
      '--plan',
      planPath,
      '--task',
      'epic-1/task-1',
      '--full',
      '--state-dir',
      dispatchStore(scratchDir, 'dispatch-store-live'),
      '--lessons',
      lessonsPath,
    ]);
    expect(scoped.status).toBe(0);
    expect(JSON.parse(scoped.stdout).lessons.map((l: { lessonId: string }) => l.lessonId)).toEqual([
      'lesson-live-1',
    ]);

    // A task whose every record is dead has no claims to scope to: refused
    // like an unknown task, not answered with the dead record's claims.
    const deadPlanPath = path.join(scratchDir, 'dispatch-all-superseded-plan.json');
    writeFileSync(
      deadPlanPath,
      JSON.stringify({
        epic_id: 'epic-1',
        version: 2,
        status: 'active',
        tasks: [{ task_id: 'epic-1/task-1', claims: ['old-area/**'], task_status: 'superseded' }],
        edges: [],
      }),
      'utf8',
    );
    const dead = runCli([
      'lessons',
      'for-dispatch',
      'coder',
      '--plan',
      deadPlanPath,
      '--task',
      'epic-1/task-1',
      '--lessons',
      lessonsPath,
    ]);
    expect(dead.status).toBe(1);
    expect(JSON.parse(dead.stdout).error.code).toBe('cli.task-not-in-plan');
  });

  it('lessons for-dispatch: resolves the task id the same way its siblings do (case-type)', () => {
    const planPath = path.join(scratchDir, 'dispatch-case-plan.json');
    const lessonsPath = path.join(scratchDir, 'dispatch-case-lessons.md');
    writeFileSync(
      planPath,
      JSON.stringify({
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [{ task_id: 'epic-1/task-1', case: 'bugfix', claims: [] }],
        edges: [],
      }),
      'utf8',
    );
    writeFileSync(
      lessonsPath,
      [
        '## case-type',
        '',
        '### lesson-cli-case-1: reproduce first',
        '',
        '- lesson_id: lesson-cli-case-1',
        '- finding_category: correctness',
        '- case_type: bugfix',
        '- statement: A bugfix without a reproducing test is a guess with a commit message.',
        '',
        '### lesson-cli-case-2: refactor only',
        '',
        '- lesson_id: lesson-cli-case-2',
        '- finding_category: maintainability',
        '- case_type: refactor',
        '- statement: Never fold a refactor into a feature commit.',
        '',
      ].join('\n'),
      'utf8',
    );

    // `task-1` is the short form `resolveTaskId` accepts; the plan only
    // names the long form `epic-1/task-1`. This used to throw
    // `cli.task-not-in-plan` out of `caseForDispatch` even though the same
    // `--task task-1` resolves fine for the gate (`budgetFromFlags`).
    const scoped = runCli([
      'lessons',
      'for-dispatch',
      'planner',
      '--plan',
      planPath,
      '--task',
      'task-1',
      '--full',
      '--state-dir',
      dispatchStore(scratchDir, 'dispatch-store-case', 'other.unclassified'),
      '--lessons',
      lessonsPath,
    ]);
    expect(scoped.status).toBe(0);
    const parsed = JSON.parse(scoped.stdout);
    expect(parsed.lessons.map((l: { lessonId: string }) => l.lessonId)).toEqual([
      'lesson-cli-case-1',
    ]);
    expect(parsed.text).toContain('A bugfix without a reproducing test');
    expect(parsed.text).not.toContain('lesson-cli-case-2');

    const unknownTask = runCli([
      'lessons',
      'for-dispatch',
      'planner',
      '--plan',
      planPath,
      '--task',
      'task-9',
      '--lessons',
      lessonsPath,
    ]);
    expect(unknownTask.status).toBe(1);
    expect(JSON.parse(unknownTask.stdout).error.code).toBe('cli.task-not-in-plan');
  });

  it('lessons approve: refuses a terminal-status lesson, an unknown id, and a missing positional', () => {
    const sessionId = `cli-approve-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'approve-events');

    const root = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      }),
      '--state-dir',
      eventsDir,
    ]);
    const rootId = JSON.parse(root.stdout).event_id as string;
    const raised = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'system',
        event_type: 'lesson-candidate-raised',
        plan_version: 1,
        causal_parent: rootId,
        payload: {
          lesson_id: 'lesson-cli-1',
          lesson_type: 'rule',
          lesson_level: 'principle',
          lesson_status: 'candidate',
          lesson_scope: 'claim-path',
          statement: 'Never hand-edit a lockfile.',
          valid_from: '2026-08-01T00:00:00.000Z',
          superseded_by: null,
          provenance_event_ids: [rootId],
        },
      }),
      '--state-dir',
      eventsDir,
    ]);
    const raisedId = JSON.parse(raised.stdout).event_id as string;

    const base = ['--session', sessionId, '--plan-version', '1', '--state-dir', eventsDir];

    const rejected = runCli([
      'lessons',
      'reject',
      'lesson-cli-1',
      ...base,
      '--causal-parent',
      raisedId,
      '--note',
      'Duplicate of the lockfile rule.',
    ]);
    expect(rejected.status).toBe(0);
    expect(JSON.parse(rejected.stdout).lessonStatus).toBe('invalidated');

    // `invalidated` is terminal — an approval after a rejection has to raise
    // the lesson again, not rewrite the decision.
    const revived = runCli([
      'lessons',
      'approve',
      'lesson-cli-1',
      ...base,
      '--causal-parent',
      raisedId,
    ]);
    expect(revived.status).toBe(1);
    expect(JSON.parse(revived.stdout).error.code).toBe('lessons.illegal-transition');

    const unknown = runCli([
      'lessons',
      'approve',
      'lesson-404',
      ...base,
      '--causal-parent',
      rootId,
    ]);
    expect(unknown.status).toBe(1);
    expect(JSON.parse(unknown.stdout).error.code).toBe('lessons.unknown-lesson');

    const noId = runCli(['lessons', 'approve', ...base, '--causal-parent', rootId]);
    expect(noId.status).toBe(1);
    expect(JSON.parse(noId.stdout).error.code).toBe('cli.missing-positional');
  });

  it('lessons approve: --statement goes through the novelty gate, and --accept-duplicate records the override (P9-34)', () => {
    const sessionId = `cli-approve-novelty-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'approve-novelty-events');
    const pinRule = 'Pin the CI runner image to a digest, never a moving tag.';

    const append = (record: Record<string, unknown>): string => {
      const result = runCli(['event', 'append', JSON.stringify(record), '--state-dir', eventsDir]);
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout).event_id as string;
    };
    const rootId = append({
      session_id: sessionId,
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    });
    const raise = (lessonId: string, statement: string, parent: string): string =>
      append({
        session_id: sessionId,
        actor: 'system',
        event_type: 'lesson-candidate-raised',
        plan_version: 1,
        causal_parent: parent,
        payload: {
          lesson_id: lessonId,
          lesson_type: 'rule',
          lesson_level: 'principle',
          lesson_status: 'candidate',
          lesson_scope: 'claim-path',
          // D-140: these two get approved below, and approval now refuses a
          // claim-path lesson with no glob — the fixture's own payload was one
          // of the hand-appended shapes the finding names.
          claim_path: '**/pnpm-lock.yaml',
          statement,
          valid_from: '2026-08-01T00:00:00.000Z',
          superseded_by: null,
          provenance_event_ids: [rootId],
        },
      });
    const firstId = raise('lesson-novel-1', 'Never hand-edit a lockfile.', rootId);
    const tip = raise('lesson-novel-2', pinRule, firstId);

    const base = [
      '--session',
      sessionId,
      '--plan-version',
      '1',
      '--state-dir',
      eventsDir,
      '--causal-parent',
      tip,
      '--actor',
      'operator',
    ];

    const eventCount = (): number =>
      readFileSync(path.join(eventsDir, `${sessionId}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean).length;
    const before = eventCount();

    const duplicate = runCli([
      'lessons',
      'approve',
      'lesson-novel-1',
      ...base,
      '--statement',
      pinRule,
    ]);
    expect(duplicate.status).toBe(1);
    expect(JSON.parse(duplicate.stdout).error.code).toBe('lessons.edit-not-novel');
    expect(eventCount()).toBe(before);

    const forced = runCli([
      'lessons',
      'approve',
      'lesson-novel-1',
      ...base,
      '--statement',
      pinRule,
      '--accept-duplicate',
    ]);
    // Exit 1 with the transition applied: the text landed, and it is not novel.
    expect(forced.status).toBe(1);
    expect(JSON.parse(forced.stdout)).toMatchObject({
      lessonId: 'lesson-novel-1',
      lessonStatus: 'approved',
      novelty: { novel: false, overridden: true, mostSimilarLessonId: 'lesson-novel-2' },
    });
    expect(eventCount()).toBe(before + 2);
  });

  it('judge run: error paths (unknown provider, disabled provider)', async () => {
    const requestPath = path.join(scratchDir, 'judge-request.json');
    await writeFile(
      requestPath,
      JSON.stringify({
        kind: 'verify',
        taskId: 'epic-1/task-1',
        inputRefs: {},
        prompt: 'judge this',
        schemaName: 'judge-verdict',
        budget: { timeout_ms: 5000, max_output_bytes: 100_000 },
      }),
    );

    // No crosscheck.yml provider named "node" exists — this exercises
    // `judge run`'s error path (unknown provider) first, cheaply, before the
    // real success path further down needs a live crosscheck.yml entry.
    const unknown = runCli([
      'judge',
      'run',
      '--provider',
      'not-a-real-provider',
      '--request',
      requestPath,
    ]);
    expect(unknown.status).toBe(1);
    expect(JSON.parse(unknown.stdout).error.code).toBe('provider.unknown');

    // codex is `enabled: false` in the committed crosscheck.yml — confirms
    // "enabled: false = never invoked at all" from the CLI's own exit path.
    const disabled = runCli(['judge', 'run', '--provider', 'codex', '--request', requestPath]);
    expect(disabled.status).toBe(1);
    expect(JSON.parse(disabled.stdout).error.code).toBe('provider.disabled');
  });

  it('judge preflight: names the unmet precondition, never its value', async () => {
    // `judge run` answers "did this provider work" by spending a call.
    // `judge preflight` answers "could it have worked" without spending one,
    // which is the question an operator actually has before a wave starts.
    const policyPath = path.join(scratchDir, 'preflight-policy.yml');
    await writeFile(
      policyPath,
      [
        'providers:',
        '  claude:',
        '    kind: native',
        '    enabled: true',
        '  ds:',
        '    kind: api',
        '    transport: api',
        '    enabled: true',
        '    mode: shadow',
        '    model_tier: mid',
        '    base_url: https://example.invalid',
        '    model: test-model',
        '    api_key_env: SMITH_TEST_KEY_THAT_IS_NEVER_SET',
        '',
      ].join('\n'),
    );

    const unmet = runCli(['judge', 'preflight', '--policy', policyPath]);
    expect(unmet.status).toBe(1);
    const report = JSON.parse(unmet.stdout);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('SMITH_TEST_KEY_THAT_IS_NEVER_SET');
    expect(report.gating).toMatchObject({ activeExternal: [], canDecide: false });

    // The whole point of reporting a key by NAME: a preflight that printed the
    // value would be a preflight that leaked one into every operator's stdout.
    const withKey = runCli(['judge', 'preflight', '--policy', policyPath], {
      SMITH_TEST_KEY_THAT_IS_NEVER_SET: 'sk-not-a-real-key',
    });
    expect(withKey.status).toBe(0);
    expect(withKey.stdout).not.toContain('sk-not-a-real-key');
    expect(JSON.parse(withKey.stdout).problems).toEqual([]);

    // SMITH_CROSSCHECK_OFFLINE forces every provider off at load time, which is
    // why `judge run` above sees codex as disabled. The preflight deliberately
    // does NOT apply it: the question is whether the file is sound, and the
    // offline switch would hide exactly the misconfiguration being looked for.
    const offline = runCli(['judge', 'preflight', '--policy', policyPath], {
      SMITH_CROSSCHECK_OFFLINE: '1',
    });
    expect(offline.status).toBe(1);
    expect(JSON.parse(offline.stdout).offlineSwitch).toBe(true);
    expect(
      JSON.parse(offline.stdout).providers.find((p: { provider: string }) => p.provider === 'ds')
        .enabled,
    ).toBe(true);
  });

  it('judge preflight --project: reads the project overlay over the policy file', async () => {
    // Operator decision 2 (OpenRouter brief): a project's
    // .blacksmith/crosscheck.yml overrides fields of an existing provider by
    // name, highest precedence. No --project at all is the pre-existing
    // behaviour above; this proves the CLI actually threads the flag through
    // rather than judgePreflight() merely supporting it in isolation.
    const policyPath = path.join(scratchDir, 'preflight-overlay-policy.yml');
    await writeFile(
      policyPath,
      [
        'providers:',
        '  claude:',
        '    kind: native',
        '    enabled: true',
        '  ds:',
        '    kind: api',
        '    transport: api',
        '    enabled: true',
        '    mode: shadow',
        '    model_tier: mid',
        '    base_url: https://example.invalid',
        '    model: test-model',
        '    api_key_env: SMITH_TEST_KEY_THAT_IS_NEVER_SET',
        '',
      ].join('\n'),
    );

    // No --project: same unmet result as the bare-policy test above.
    const withoutProject = runCli(['judge', 'preflight', '--policy', policyPath]);
    expect(withoutProject.status).toBe(1);
    expect(JSON.parse(withoutProject.stdout).problems).toHaveLength(1);

    // --project points at a directory whose overlay disables `ds` outright —
    // proves the CLI reads --project and hands it to judgePreflight(), not
    // just that judgePreflight() itself supports a projectDir.
    const projectDir = path.join(scratchDir, 'preflight-project');
    await mkdir(path.join(projectDir, '.blacksmith'), { recursive: true });
    await writeFile(
      path.join(projectDir, '.blacksmith', 'crosscheck.yml'),
      ['providers:', '  ds:', '    enabled: false', ''].join('\n'),
    );

    const withProject = runCli([
      'judge',
      'preflight',
      '--policy',
      policyPath,
      '--project',
      projectDir,
    ]);
    expect(withProject.status).toBe(0);
    const report = JSON.parse(withProject.stdout);
    expect(report.problems).toEqual([]);
    expect(report.providers.find((p: { provider: string }) => p.provider === 'ds')).toMatchObject({
      enabled: false,
      status: 'not-applicable',
    });
  });

  it('stats providers: reports per-provider calibration stats from judge-verdict events', () => {
    const sessionId = `cli-providers-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'providers-events');
    const dbPath = path.join(scratchDir, `${sessionId}.db`);

    const root = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      }),
      '--state-dir',
      eventsDir,
    ]);
    const rootId = JSON.parse(root.stdout).event_id as string;

    const dispatch = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'system',
        event_type: 'dispatch_decision',
        task_id: 'epic-1/task-1',
        plan_version: 1,
        causal_parent: rootId,
        payload: {
          agent_role: 'verifier',
          provider: 'codex',
          model_tier: 'mid',
          model: 'codex:default',
        },
      }),
      '--state-dir',
      eventsDir,
    ]);
    const dispatchId = JSON.parse(dispatch.stdout).event_id as string;

    const verdict = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'system',
        event_type: 'judge-verdict',
        task_id: 'epic-1/task-1',
        plan_version: 1,
        causal_parent: dispatchId,
        payload: {
          task_id: 'epic-1/task-1',
          agent: 'verifier',
          provider: 'codex',
          model_tier: 'mid',
          model: 'codex:default',
          kind: 'verify',
          mode: 'shadow',
          ok: true,
          verdict: 'confirm',
          rationale: 'real issue',
          native_verdict: 'confirm',
          agreement_with_native: true,
          schema_failure: false,
          latency_ms: 250,
        },
      }),
      '--state-dir',
      eventsDir,
    ]);
    expect(verdict.status).toBe(0);

    runCli(['db', 'rebuild', '--db', dbPath, '--session', sessionId, '--state-dir', eventsDir]);

    const providersResult = runCli(['stats', 'providers', '--db', dbPath, '--session', sessionId]);
    expect(providersResult.status).toBe(0);
    expect(JSON.parse(providersResult.stdout)).toEqual([
      {
        provider: 'codex',
        runs: 1,
        verdicts: 1,
        agreementRate: 1,
        latencySamples: 1,
        meanLatencyMs: 250,
        schemaFailureRate: 0,
        // D-253: a run that reached a verdict fails neither way, and
        // `failuresByCode` is empty rather than absent — the operator reading
        // this JSON should see the same keys whether or not anything failed.
        transportFailureRate: 0,
        failuresByCode: {},
      },
    ]);
  });
});
