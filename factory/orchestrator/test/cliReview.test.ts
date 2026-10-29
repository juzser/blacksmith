import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ISSUE_CANDIDATE_EVENT_TYPES } from '../src/errorIssues.js';
import { resolveRepoAtDir } from '../src/gh.js';
import { factoryProjects } from '../src/projects.js';
import { CLI_PATH, committedWorktreeIn, runCli } from './helpers/cliHarness.js';
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

  /**
   * A worktree the gate will actually score — see committedWorktreeIn in
   * helpers/cliHarness.ts.
   */
  const committedWorktree = (name: string) => committedWorktreeIn(scratchDir, name);

  // Wave 3 dispatched eight agents; five ended their turn on an announcement
  // and wrote nothing, and the layer above read that as `completed`. These
  // four verbs are the smallest thing that makes the difference visible from
  // outside the agent: what was promised, what landed, and the gap.
  describe('judge dispatch / report / outstanding (D-31, D-20 / P9-11)', () => {
    async function judgeSession(): Promise<{
      sessionId: string;
      eventsDir: string;
      artifact: string;
    }> {
      const sessionId = `cli-p9-11-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const eventsDir = path.join(scratchDir, `${sessionId}-events`);
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
      return { sessionId, eventsDir, artifact: path.join(scratchDir, `${sessionId}-review.json`) };
    }

    /**
     * `--causal-parent` is boilerplate for the verbs that append, and noise for
     * the one that only reads: `judge outstanding` documents `--session --task
     * [--state-dir]` and its handler never asks for a parent. Passing it anyway
     * was invisible while every `--`-token landed in a bag nobody audited; under
     * D-132 it is a flag the command does not accept, so the helper stops
     * inventing it rather than the usage table growing a flag to match.
     */
    function judgeCli(
      verb: string,
      sessionId: string,
      eventsDir: string,
      rest: string[],
    ): { stdout: string; status: number | null } {
      const causal = verb === 'outstanding' ? [] : ['--causal-parent', `${sessionId}#0`];
      return runCli([
        'judge',
        verb,
        ...rest,
        '--session',
        sessionId,
        ...causal,
        '--state-dir',
        eventsDir,
      ]);
    }

    /** Dispatch, asserting it worked — a silently failed dispatch owes nothing, which would make the next assertion vacuous. */
    function dispatchJudge(
      sessionId: string,
      eventsDir: string,
      role: string,
      artifact: string,
      kind?: string,
    ): void {
      const dispatched = judgeCli('dispatch', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--role',
        role,
        ...(kind ? ['--kind', kind] : []),
        '--round',
        '1',
        '--artifact',
        artifact,
        '--model',
        'claude-opus-5',
      ]);
      expect(dispatched.status).toBe(0);
    }

    async function gateFiles(
      sessionId: string,
    ): Promise<{ checks: string; result: string; worktree: string }> {
      const worktree = await committedWorktree(`p9-11-${sessionId}`);
      const checks = path.join(scratchDir, `${sessionId}-checks.json`);
      const result = path.join(scratchDir, `${sessionId}-result.json`);
      await writeFile(checks, JSON.stringify([{ name: 'test', cmd: 'true' }]));
      await writeFile(
        result,
        JSON.stringify({
          task_id: 'epic-1/task-1',
          run_status: 'done',
          structured_output: {},
          artifacts: [],
          token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          agent: 'coder',
          provider: 'claude',
          model_tier: 'mid',
        }),
      );
      return { checks, result, worktree };
    }

    function gateRun(
      sessionId: string,
      eventsDir: string,
      files: { checks: string; result: string; worktree: string },
      extra: string[] = [],
    ): { stdout: string; status: number | null } {
      return runCli([
        'gate',
        'run',
        'epic-1/task-1',
        '--worktree',
        files.worktree,
        '--checks',
        files.checks,
        '--result',
        files.result,
        ...extra,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
    }

    it('dispatch records the file a judge owes, and outstanding exits 1 while it is owed', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      const dispatched = judgeCli('dispatch', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--role',
        'security-reviewer',
        '--round',
        '1',
        '--artifact',
        artifact,
        '--model',
        'claude-opus-5',
      ]);
      expect(dispatched.status).toBe(0);
      expect(JSON.parse(dispatched.stdout).record.payload).toMatchObject({
        agent_role: 'security-reviewer',
        round: 1,
        declared_artifact: artifact,
        model: 'claude-opus-5',
      });
      // The line the dispatcher pastes into the prompt, so judge-stop reads it.
      expect(JSON.parse(dispatched.stdout).expected_line).toBe(`Declared artifact: ${artifact}`);

      // Exit 1, not 0: this is the re-poke signal. A wrapper that only reads
      // stdout still gets the list; a shell loop gets a status it can branch on.
      const outstanding = judgeCli('outstanding', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
      ]);
      expect(outstanding.status).toBe(1);
      expect(JSON.parse(outstanding.stdout)).toMatchObject({
        taskId: 'epic-1/task-1',
        sessionId,
        count: 1,
        outstanding: [
          { role: 'security-reviewer', round: 1, declaredArtifact: artifact, reported: false },
        ],
      });
    });

    // S2: a typo in --kind used to filter every turn out silently, printing
    // count 0 and exiting 0 while a real uiux turn was still open. An unknown
    // kind must fail loudly instead of reading as "nothing outstanding".
    it('outstanding rejects an unknown --kind rather than filtering everything out', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      const dispatched = judgeCli('dispatch', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--role',
        'uiux',
        '--kind',
        'visual',
        '--round',
        '1',
        '--artifact',
        artifact,
        '--model',
        'claude-opus-5',
      ]);
      expect(dispatched.status).toBe(0);

      const outstanding = judgeCli('outstanding', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--kind',
        'visaul',
      ]);
      expect(outstanding.status).not.toBe(0);
      expect(JSON.parse(outstanding.stdout).error.code).toBe('judges.invalid-kind');
    });

    it('outstanding --kind still filters to the matching turn when it is valid', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      const specArtifact = `${artifact}.spec`;
      const specDispatch = judgeCli('dispatch', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--role',
        'uiux',
        '--kind',
        'spec',
        '--round',
        '1',
        '--artifact',
        specArtifact,
        '--model',
        'claude-opus-5',
      ]);
      expect(specDispatch.status).toBe(0);
      const visualDispatch = runCli([
        'judge',
        'dispatch',
        '--task',
        'epic-1/task-1',
        '--role',
        'uiux',
        '--kind',
        'visual',
        '--round',
        '1',
        '--artifact',
        artifact,
        '--model',
        'claude-opus-5',
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#1`,
        '--state-dir',
        eventsDir,
      ]);
      expect(visualDispatch.status).toBe(0);

      const outstanding = judgeCli('outstanding', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--kind',
        'visual',
      ]);
      expect(outstanding.status).toBe(1);
      const payload = JSON.parse(outstanding.stdout) as {
        outstanding: Array<{ kind: string | null }>;
      };
      expect(payload.outstanding.map((t) => t.kind)).toEqual(['visual']);
    });

    it('dispatch rejects an unknown --kind', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      const dispatched = judgeCli('dispatch', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--role',
        'uiux',
        '--kind',
        'bogus',
        '--round',
        '1',
        '--artifact',
        artifact,
        '--model',
        'claude-opus-5',
      ]);
      expect(dispatched.status).not.toBe(0);
      const error = JSON.parse(dispatched.stdout).error;
      expect(error.code).toBe('judges.invalid-kind');
      expect(error.message).toContain('bogus');
    });

    it('report rejects an unknown --kind', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      dispatchJudge(sessionId, eventsDir, 'uiux', artifact, 'visual');

      const reported = judgeCli('report', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--role',
        'uiux',
        '--kind',
        'bogus',
        '--artifact',
        artifact,
      ]);
      expect(reported.status).not.toBe(0);
      const error = JSON.parse(reported.stdout).error;
      expect(error.code).toBe('judges.invalid-kind');
      expect(error.message).toContain('bogus');
    });

    // EPIPE on a failing command must not launder its exit code to 0. The
    // global stdout error handler (cli.ts ~4617) answers an EPIPE with
    // `process.exitCode = mainExitCode ?? 0` -- this verb resolves 1 (a judge
    // turn is still owed) before that write ever happens, so a reader that
    // goes away early has to see the same 1 an EPIPE-free run would report,
    // not the "reader said enough" 0 that answer falls back to only when no
    // verb has resolved a status yet.
    it('an EPIPE on `judge outstanding` still exits 1, the real status, not 0', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      dispatchJudge(sessionId, eventsDir, 'security-reviewer', artifact);

      const child = spawn(
        'node',
        [
          CLI_PATH,
          'judge',
          'outstanding',
          '--task',
          'epic-1/task-1',
          '--session',
          sessionId,
          '--state-dir',
          eventsDir,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.stdout.destroy();

      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
        (resolve) => {
          child.once('close', (code, sig) => resolve([code, sig]));
        },
      );

      expect(signal).toBeNull();
      expect(stderr).not.toMatch(/EPIPE/);
      expect(code).toBe(1);
    });

    // A judge dispatch is a dispatch, so P9-23's required `model` applies here
    // too — and it applies hardest here, because `reviewer` and `verifier` are
    // one of crosscheck.yml's finder_ne_critic pairs. Defaulting the field
    // would give `smith dispatch check` two placeholders to compare and an
    // answer that describes nothing that happened.
    it('refuses a dispatch that names no model, rather than defaulting one the audit would believe', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      const dispatched = judgeCli('dispatch', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--role',
        'reviewer',
        '--artifact',
        artifact,
      ]);
      expect(dispatched.status).toBe(1);

      // And nothing was written: the turn is not half-open.
      const outstanding = judgeCli('outstanding', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
      ]);
      expect(outstanding.status).toBe(0);
      expect(JSON.parse(outstanding.stdout)).toEqual({
        taskId: 'epic-1/task-1',
        sessionId,
        outstanding: [],
        count: 0,
      });
    });

    it('report closes the turn and counts findings; outstanding then exits 0 on an empty list', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      dispatchJudge(sessionId, eventsDir, 'reviewer', artifact);
      await writeFile(
        artifact,
        JSON.stringify([
          {
            file_path: 'src/a.ts',
            finding_category: 'correctness',
            severity: 'S2-major',
            summary: 'off-by-one in loop bound',
            failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
          },
        ]),
      );

      const reported = judgeCli('report', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--role',
        'reviewer',
      ]);
      expect(reported.status).toBe(0);
      const parsedReport = JSON.parse(reported.stdout);
      expect(parsedReport).toMatchObject({
        role: 'reviewer',
        round: 1,
        artifactPath: artifact,
        findingCount: 1,
        attested: false,
      });
      // session-start is #0, the dispatch above is #1, so this report's own
      // judge-reported event is #2 — printed here instead of making the
      // operator read the log (line-1) to find the id `audit record` wants
      // as its `--causal-parent`.
      expect(parsedReport.event_id).toBe(`${sessionId}#2`);

      const outstanding = judgeCli('outstanding', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
      ]);
      expect(outstanding.status).toBe(0);
      expect(JSON.parse(outstanding.stdout)).toEqual({
        taskId: 'epic-1/task-1',
        sessionId,
        outstanding: [],
        count: 0,
      });
    });

    it('report on a declared artifact that never landed is an error, not an empty review', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      dispatchJudge(sessionId, eventsDir, 'reviewer', artifact);
      const reported = judgeCli('report', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--role',
        'reviewer',
      ]);
      expect(reported.status).toBe(1);
      expect(JSON.parse(reported.stdout).error.code).toBe('judges.artifact-missing');
      // Still owed: a failed report is not a report.
      expect(
        judgeCli('outstanding', sessionId, eventsDir, ['--task', 'epic-1/task-1']).status,
      ).toBe(1);
    });

    it('report --no-findings records an operator attestation with no artifact', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      dispatchJudge(sessionId, eventsDir, 'reviewer', artifact);
      const reported = judgeCli('report', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--role',
        'reviewer',
        '--no-findings',
      ]);
      expect(reported.status).toBe(0);
      expect(JSON.parse(reported.stdout)).toMatchObject({
        artifactPath: null,
        findingCount: 0,
        attested: true,
      });
    });

    it('gate run refuses to score a task whose judge is still owed', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      const files = await gateFiles(sessionId);
      dispatchJudge(sessionId, eventsDir, 'security-reviewer', artifact);

      const gated = gateRun(sessionId, eventsDir, files);
      expect(gated.status).toBe(1);
      const outcome = JSON.parse(gated.stdout);
      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'judges-outstanding' });
      expect(outcome.outstandingJudges.map((j: { role: string }) => j.role)).toEqual([
        'security-reviewer',
      ]);
    });

    it('gate run --no-findings <role> attests the clean case and lets the gate score', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      const files = await gateFiles(sessionId);
      dispatchJudge(sessionId, eventsDir, 'security-reviewer', artifact);

      const gated = gateRun(sessionId, eventsDir, files, ['--no-findings', 'security-reviewer']);
      expect(gated.status).toBe(0);
      expect(JSON.parse(gated.stdout).outcome).not.toBe('blocked');
    });

    it('gate run --evidence closes the dispatched judge whose file it is', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      const files = await gateFiles(sessionId);
      dispatchJudge(sessionId, eventsDir, 'reviewer', artifact);
      await writeFile(artifact, JSON.stringify([]));

      // Handing the gate a judge's evidence IS that judge reporting. Without
      // this the common path needs two commands and forgetting the first one
      // blocks a task whose judge did everything right.
      const gated = gateRun(sessionId, eventsDir, files, [
        '--evidence',
        artifact,
        '--found-by',
        'reviewer',
      ]);
      expect(gated.status).toBe(0);
      expect(JSON.parse(gated.stdout).outcome).not.toBe('blocked');
      expect(
        judgeCli('outstanding', sessionId, eventsDir, ['--task', 'epic-1/task-1']).status,
      ).toBe(0);
    });

    // D-158. One gate run carries every judge's evidence (D-32/P9-13), and the
    // minting path already pairs each file with the role written after it. The
    // turn-closing path beside it read the single-valued `flags.evidence` /
    // `flags['found-by']`, which `parseArgs` resolves last-occurrence-wins — so
    // two judges reporting through one gate closed the second one's turn and
    // left the first outstanding, blocking the gate on a judge that had just
    // handed in its file. That is the exact failure the auto-close exists to
    // remove, reappearing whenever more than one judge is at the gate.
    it('gate run --evidence closes every judge whose file it was handed, not just the last', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      const files = await gateFiles(sessionId);
      const security = path.join(scratchDir, `${sessionId}-security.json`);
      dispatchJudge(sessionId, eventsDir, 'reviewer', artifact);
      dispatchJudge(sessionId, eventsDir, 'security-reviewer', security);
      await writeFile(artifact, JSON.stringify([]));
      await writeFile(security, JSON.stringify([]));

      const gated = gateRun(sessionId, eventsDir, files, [
        '--evidence',
        artifact,
        '--found-by',
        'reviewer',
        '--evidence',
        security,
        '--found-by',
        'security-reviewer',
      ]);
      expect(gated.status).toBe(0);
      expect(JSON.parse(gated.stdout).outcome).not.toBe('blocked');
      expect(
        judgeCli('outstanding', sessionId, eventsDir, ['--task', 'epic-1/task-1']).status,
      ).toBe(0);

      // Each turn closes against its own file: closing both against whichever
      // path came last would satisfy the outstanding list while recording an
      // artifact the judge never wrote.
      const events = runCli(['event', 'tail', sessionId, '--n', '100', '--state-dir', eventsDir]);
      expect(events.status).toBe(0);
      const reported = JSON.parse(events.stdout)
        .map((e: { record: { event_type: string; payload: Record<string, unknown> } }) => e.record)
        .filter((r: { event_type: string }) => r.event_type === 'judge-reported')
        .map((r: { payload: Record<string, unknown> }) => [
          r.payload.agent_role,
          r.payload.artifact_path,
        ]);
      expect(reported).toEqual([
        ['reviewer', artifact],
        ['security-reviewer', security],
      ]);
    });

    // FD-1. `--grader` hands the gate the grader's verdict the
    // way `--evidence` hands it a judge's findings, but only the evidence path
    // closed the judge's turn. A grader dispatched by `judge dispatch` then
    // blocked its own gate as `judges-outstanding` with its verdict sitting
    // in the same command line.
    it('gate run --grader closes the dispatched grader whose verdict it is', async () => {
      const { sessionId, eventsDir } = await judgeSession();
      const files = await gateFiles(sessionId);
      const grader = path.join(scratchDir, `${sessionId}-grader.json`);
      dispatchJudge(sessionId, eventsDir, 'grader', grader);
      await writeFile(
        grader,
        JSON.stringify({
          run_status: 'done',
          structured_output: {
            round: 1,
            criteria: [{ criterion: 'it builds', status: 'pass', evidence: 'build log' }],
            overall: 'pass',
          },
        }),
      );

      const gated = gateRun(sessionId, eventsDir, files, ['--grader', grader]);
      expect(gated.status).toBe(0);
      expect(JSON.parse(gated.stdout).outcome).not.toBe('blocked');
      expect(
        judgeCli('outstanding', sessionId, eventsDir, ['--task', 'epic-1/task-1']).status,
      ).toBe(0);

      const events = runCli(['event', 'tail', sessionId, '--n', '100', '--state-dir', eventsDir]);
      const reported = JSON.parse(events.stdout)
        .map((e: { record: { event_type: string; payload: Record<string, unknown> } }) => e.record)
        .filter((r: { event_type: string }) => r.event_type === 'judge-reported')
        .map((r: { payload: Record<string, unknown> }) => [
          r.payload.agent_role,
          r.payload.artifact_path,
          r.payload.finding_count,
        ]);
      expect(reported).toEqual([['grader', grader, 0]]);
    });

    it('gate run --evidence for a role nobody dispatched behaves exactly as it did before', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      const files = await gateFiles(sessionId);
      await writeFile(artifact, JSON.stringify([]));
      const gated = gateRun(sessionId, eventsDir, files, [
        '--evidence',
        artifact,
        '--found-by',
        'reviewer',
      ]);
      expect(gated.status).toBe(0);
      expect(JSON.parse(gated.stdout).outcome).not.toBe('blocked');
    });

    it('a bare --no-findings on the gate is a usage error, never an attestation for role "true"', async () => {
      const { sessionId, eventsDir } = await judgeSession();
      const files = await gateFiles(sessionId);
      // Accepting the invented value would attest a role nobody dispatched —
      // and silently, since an undispatched role is exactly what the refusal is
      // looking for. The parser now names the missing value before dispatch, so
      // this is caught one layer earlier than it used to be; what must not
      // change is that it is a usage error and not an attestation.
      const gated = gateRun(sessionId, eventsDir, files, ['--no-findings']);
      expect(gated.status).toBe(1);
      expect(JSON.parse(gated.stdout).error.code).toBe('cli.missing-flag-value');
    });

    // The call-site guard still has a job the parser cannot do: `--no-findings
    // true` is a value the operator actually typed, and there is no judge role
    // called "true" either.
    it('still refuses --no-findings true, which no parser can tell from a role', async () => {
      const { sessionId, eventsDir } = await judgeSession();
      const files = await gateFiles(sessionId);
      const gated = gateRun(sessionId, eventsDir, files, ['--no-findings', 'true']);
      expect(gated.status).toBe(1);
      expect(JSON.parse(gated.stdout).error.code).toBe('cli.no-findings-needs-role');
    });
  });

  describe('issues preview (task 5)', () => {
    // Only `issues preview` is driven here (nonfunctional clause 2). A `gh`
    // shim on PATH records any process a preview would have spawned.
    function ghShimDir(): { binDir: string; marker: string } {
      const binDir = path.join(scratchDir, 'issues-bin');
      const marker = path.join(scratchDir, 'issues-gh-invoked');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`);
      chmodSync(path.join(binDir, 'gh'), 0o755);
      return { binDir, marker };
    }

    // One candidate payload per event type errorIssues.ts folds from, written
    // out by hand rather than derived: the point of the two cases below is to
    // hold this side against the fold's own roster, and a map computed from
    // that roster would agree with it no matter what either one said.
    const CANDIDATE_PAYLOADS: Record<string, (taskId: string) => Record<string, unknown>> = {
      'gate-outcome': () => ({ outcome: 'blocked', reason: 'tests-failed' }),
      'error-logged': (taskId) => ({
        error: 'execution.flaky-test',
        severity: 'S3-minor',
        task_ref: taskId,
      }),
      'task-added': () => ({ task_status: 'failed' }),
    };

    /**
     * One session with a candidate of `eventType` per task id. `project`
     * left undefined reproduces an ordinary unstamped row (most of this
     * describe block's tests only care about scoping/argv shape and stay
     * agnostic to how -- or whether -- the row's project resolves); a caller
     * that needs a row to actually settle as this factory's own passes
     * `'black-smith'` explicitly, the same stamp production code writes for
     * a session it knows is its own (Phase 6b, `events.ts`'s `project?`).
     */
    function seedTyped(
      label: string,
      eventType: string,
      taskIds: string[],
      project?: string,
    ): [string, string] {
      const sessionId = `cli-issues-${label}-${Date.now()}`;
      const eventsDir = path.join(scratchDir, `${sessionId}-events`);
      const append = (event: Record<string, unknown>) => {
        const run = runCli(['event', 'append', JSON.stringify(event), '--state-dir', eventsDir]);
        expect(run.status).toBe(0);
        return JSON.parse(run.stdout).event_id as string;
      };
      const base = {
        session_id: sessionId,
        actor: 'system',
        plan_version: 1,
        ...(project === undefined ? {} : { project }),
      };
      const rootId = append({
        ...base,
        event_type: 'session-start',
        causal_parent: null,
        payload: {},
      });
      const payloadFor = CANDIDATE_PAYLOADS[eventType];
      if (!payloadFor) throw new Error(`no seed payload for ${eventType}`);
      for (const task_id of taskIds) {
        const payload = payloadFor(task_id);
        append({ ...base, event_type: eventType, task_id, causal_parent: rootId, payload });
      }
      return [sessionId, eventsDir];
    }

    /** One session with a blocked `gate-outcome` candidate per task id. */
    function seedCandidates(label: string, taskIds: string[], project?: string): [string, string] {
      return seedTyped(label, 'gate-outcome', taskIds, project);
    }

    function eventCount(sessionId: string, eventsDir: string): number {
      const tail = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir]);
      expect(tail.status).toBe(0);
      return JSON.parse(tail.stdout).length;
    }

    // AC1 (TDD, differential): under the null the binary refuses `issues
    // preview` as unknown and exits 1; after, it prints one record per
    // candidate. AC2: (a) zero `gh` processes and all three argv blocks;
    // (b) the literal slug from this checkout's `origin`; (c) no new event.
    it('issues preview prints one JSON record per candidate naming its argv, spawns no gh, and appends nothing (AC1, AC2)', () => {
      // Stamped: this test is about argv/repo_slug plumbing for a row that
      // resolves, not about project resolution itself -- see the fail-closed
      // 'project resolution' describe block below for the unstamped cases.
      const [sessionId, eventsDir] = seedCandidates('ac1', ['epic-1/task-a'], 'black-smith');
      const { binDir, marker } = ghShimDir();
      const before = eventCount(sessionId, eventsDir);

      const { stdout, stderr, status } = runCli(
        ['issues', 'preview', '--session', sessionId, '--state-dir', eventsDir],
        { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
      );
      expect(status).toBe(0);
      expect(stderr).toBe('');
      const records = JSON.parse(stdout);
      expect(records).toHaveLength(1);
      const [record] = records;
      expect(record.task_ref).toBe('epic-1/task-a');
      expect(record.error_class).toBe('gate.blocked.tests-failed');
      expect(typeof record.fingerprint).toBe('string');
      expect(record.step_3_gh_availability).toBe('not-performed');

      // (a) the `gh` shim was never executed, and all three blocks printed.
      expect(existsSync(marker)).toBe(false);
      const blocks = [record.search_argv, record.create_argv, record.comment_argv];
      expect(blocks.filter((b) => Array.isArray(b) && b[0] === 'issue')).toHaveLength(3);

      // (b) the slug comes from the register the CLI passed (AC6): the first
      // `factoryProjects()` entry is this checkout, `self: true`, whose
      // `origin` resolves to the literal below.
      const first = factoryProjects()[0];
      if (!first) throw new Error('factoryProjects() returned no entry');
      expect(first.self).toBe(true);
      const resolved = resolveRepoAtDir(first.dir);
      if (!('slug' in resolved)) throw new Error(`no slug: ${resolved.reason}`);
      expect(resolved.slug).toBe('juzser/blacksmith');
      expect(record.repo_slug).toBe('juzser/blacksmith');
      const search = [
        'issue',
        'list',
        '--repo',
        'juzser/blacksmith',
        '--state',
        'open',
        '--json',
        'number,body,url',
      ];
      expect(record.search_argv).toEqual([...search, '--search', record.fingerprint]);
      expect(record.create_argv).toContain('juzser/blacksmith');
      expect(record.comment_argv).toContain('juzser/blacksmith');

      // (c) preview appended nothing.
      expect(before).toBe(2);
      expect(eventCount(sessionId, eventsDir)).toBe(before);
    });

    // Functional clause 2: `--epic` narrows the candidates to one epic.
    it("issues preview --epic reports only that epic's candidates", () => {
      const [sessionId, eventsDir] = seedCandidates('scope', ['epic-1/task-c', 'epic-2/task-d']);
      const flags = ['--session', sessionId, '--epic', 'epic-2', '--state-dir', eventsDir];
      const { stdout, status } = runCli(['issues', 'preview', ...flags]);
      expect(status).toBe(0);
      const refs = JSON.parse(stdout).map((r: { task_ref: string }) => r.task_ref);
      expect(refs).toEqual(['epic-2/task-d']);
    });

    // ...and clause 2 holds for every source the fold reads, not just the one
    // the case above happens to seed. `scopeIssueCandidates` narrows by event
    // type and passes everything else through as history, so a source the
    // scoping roster has not heard of is not left unnarrowed-and-noisy: it is
    // reported under an `--epic` that was supposed to exclude it. The cases
    // below are two halves of one guard -- this one says the hand-written map
    // above still covers the roster, the next says each covered type is
    // actually narrowed. Either alone would pass a fourth source that the
    // roster gained but nobody scoped.
    it('the seed map above covers every event type the fold reads candidates from', () => {
      expect(Object.keys(CANDIDATE_PAYLOADS).sort()).toEqual(
        [...ISSUE_CANDIDATE_EVENT_TYPES].sort(),
      );
    });

    it.each([...ISSUE_CANDIDATE_EVENT_TYPES])(
      'issues preview --epic narrows %s candidates too',
      (eventType) => {
        const label = `scope-${eventType}`;
        const [sessionId, eventsDir] = seedTyped(label, eventType, [
          'epic-1/task-out',
          'epic-2/task-in',
        ]);
        const flags = ['--session', sessionId, '--epic', 'epic-2', '--state-dir', eventsDir];
        const { stdout, status } = runCli(['issues', 'preview', ...flags]);
        expect(status).toBe(0);
        const refs = JSON.parse(stdout).map((r: { task_ref: string }) => r.task_ref);
        expect(refs).toEqual(['epic-2/task-in']);
      },
    );

    // AC4: every candidate settled `skipped-disabled` at step 1 is a
    // recorded answer, so the run exits 0 and prints no argv for it.
    it('issues preview exits 0 when every candidate is skipped-disabled (AC4)', () => {
      // Stamped: this switch-off gate reads isEnabled(project), so the row
      // needs a resolved project to be disabled in the first place -- an
      // unresolved row settles skipped-unresolved-project before the switch
      // is ever consulted (skipped-unresolved-project is settled first, see
      // issueReporter.ts).
      const [sessionId, eventsDir] = seedCandidates('off', ['epic-1/task-e'], 'black-smith');
      const roadmapPath = path.join(scratchDir, 'issues-off-roadmap.md');
      const row = '## Phase 1 — Off\n- id: phase-1\n- status: planned\n- error_issues: off\n';
      writeFileSync(roadmapPath, `# Roadmap\n\n${row}`);
      const flags = [
        '--session',
        sessionId,
        '--roadmap-path',
        roadmapPath,
        '--state-dir',
        eventsDir,
      ];
      const { stdout, status } = runCli(['issues', 'preview', ...flags]);
      expect(status).toBe(0);
      const [record] = JSON.parse(stdout);
      expect(record.outcome).toBe('skipped-disabled');
      expect(record.reason).toBe('switch-off');
      expect(record.settled_at_step).toBe(1);
      expect(record.search_argv).toBeUndefined();
      expect(record.step_3_gh_availability).toBe('not-performed');
    });

    // AC4: a log that cannot be read at all exits non-zero -- a different
    // code from the all-skipped run above, which is the whole point.
    it('issues preview exits non-zero when the session log cannot be read (AC4)', () => {
      const eventsDir = path.join(scratchDir, 'issues-unreadable-events');
      const flags = ['--session', 'no-such-session', '--state-dir', eventsDir];
      const { stdout, status } = runCli(['issues', 'preview', ...flags]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.message).toMatch(/no-such-session/);
    });

    // PR #177's S1 finding: an unstamped row that cannot be resolved must be
    // SKIPPED, never filed against this repo. The three cases below drive
    // that through the real `issueInputs` wiring (the built binary's
    // `planProjectResolverForTaskRefOrSelf` + `withSessionFallback`, not a
    // stub resolver), the same three shapes errorIssues.ts's fold actually
    // has to tell apart.
    describe('project resolution (fail closed)', () => {
      // (i) A foreign epic's own ref shape (`<epic>/integration`), unstamped,
      // with no plan on disk anywhere this run can see: none of
      // withSessionFallback's three steps -- a stamp, a session-mate's
      // stamp, or a plan on disk -- can name a project, so the row settles
      // skipped-unresolved-project at step 0 rather than defaulting to this
      // factory's own name.
      it('reports skipped-unresolved-project for a foreign <epic>/integration ref with no local plan', () => {
        const [sessionId, eventsDir] = seedCandidates('foreign', ['epic-foreign/integration']);
        const specsDir = path.join(scratchDir, 'issues-foreign-specs');
        mkdirSync(specsDir, { recursive: true });
        const flags = ['--session', sessionId, '--specs-dir', specsDir, '--state-dir', eventsDir];
        const { stdout, status } = runCli(['issues', 'preview', ...flags]);
        expect(status).toBe(0);
        const [record] = JSON.parse(stdout);
        expect(record.task_ref).toBe('epic-foreign/integration');
        expect(record.project).toBeNull();
        expect(record.outcome).toBe('skipped-unresolved-project');
        expect(record.reason).toBe('project-unresolved');
        expect(record.settled_at_step).toBe(0);
        expect(record.search_argv).toBeUndefined();
      });

      // (ii) A BARE ref (no epic segment), `--specs-dir` pointed at a temp
      // directory that is NOT this checkout's own `specs/active` tree: the
      // direct resolver cannot even try, since there is no epic to look a
      // plan up under except through this session's own `task-added` row,
      // whose `payload.epic_id` widens it to `<epic>/<ref>`. A real plan
      // fixture on disk for that epic, declaring no `project` field, would
      // once have been treated as "self" -- but plan.ts's
      // `planProjectResolverForTaskRefOrSelf` only applies that fallback
      // when `--specs-dir` names THIS checkout's own active tree (S2-b):
      // `--specs-dir` is also how a caller points this resolver at a
      // DIFFERENT checkout's specs tree entirely (`issueInputs`'s own doc
      // comment), and an unlabeled plan found there is that OTHER project's
      // silence, not evidence of self. So this settles unresolved, same as
      // case (i), rather than defaulting to this factory's own name.
      it('reports skipped-unresolved-project for a bare ref whose plan fixture lives under a foreign --specs-dir', () => {
        const sessionId = `cli-issues-bare-${Date.now()}`;
        const eventsDir = path.join(scratchDir, `${sessionId}-events`);
        const specsDir = path.join(scratchDir, `${sessionId}-specs`);
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
        // The only source of the epic id: a task-added row for this exact
        // bare task id, same session. It is also itself a candidate --
        // task-added is one of ISSUE_CANDIDATE_EVENT_TYPES -- so one event
        // does both jobs, the way a real log's would.
        append({
          ...base,
          event_type: 'task-added',
          task_id: 'task-bare',
          causal_parent: rootId,
          payload: { task_status: 'failed', epic_id: 'epic-1' },
        });

        // A real plan on disk for epic-1, naming no `project`, but under a
        // temp `--specs-dir` -- never this checkout's own active tree, so
        // the self-fallback must not fire for it (S2-b).
        mkdirSync(path.join(specsDir, 'epic-1'), { recursive: true });
        writeFileSync(
          path.join(specsDir, 'epic-1', 'plan-v1.json'),
          JSON.stringify({
            epic_id: 'epic-1',
            version: 1,
            status: 'active',
            tasks: [],
            edges: [],
          }),
        );

        const flags = ['--session', sessionId, '--specs-dir', specsDir, '--state-dir', eventsDir];
        const { stdout, status } = runCli(['issues', 'preview', ...flags]);
        expect(status).toBe(0);
        const [record] = JSON.parse(stdout);
        expect(record.task_ref).toBe('task-bare');
        expect(record.project).toBeNull();
        expect(record.outcome).toBe('skipped-unresolved-project');
      });

      // (ii-b) The same shape as (ii), but WITHOUT `--specs-dir`: the plan
      // fixture is written under this run's own `SMITH_HOME`-relocated
      // `specs/active` tree instead, so `planOptsFromFlags` returns
      // `{ specsDir: undefined }` and the resolver's self-fallback IS
      // eligible (S2-b's `isSelfSpecsDir` treats "absent" as self). Proves
      // the restriction only narrows the foreign-specs-dir case above, and
      // does not regress the real, intended default -- an unlabeled local
      // plan still resolves to this factory's own name.
      it('still resolves a bare ref via self-fallback when --specs-dir is omitted (plan lives under SMITH_HOME)', () => {
        const sessionId = `cli-issues-bare-self-${Date.now()}`;
        const smithHome = path.join(scratchDir, `${sessionId}-home`);
        const eventsDir = path.join(scratchDir, `${sessionId}-events`);
        const envOverrides = { SMITH_HOME: smithHome };
        const append = (event: Record<string, unknown>) => {
          const run = runCli(
            ['event', 'append', JSON.stringify(event), '--state-dir', eventsDir],
            envOverrides,
          );
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
          event_type: 'task-added',
          task_id: 'task-bare',
          causal_parent: rootId,
          payload: { task_status: 'failed', epic_id: 'epic-1' },
        });

        // A real plan on disk under SMITH_HOME's own specs/active/epic-1,
        // naming no `project` -- the self-fallback case plan.ts's doc
        // comment describes.
        const selfSpecsDir = path.join(smithHome, 'factory', 'specs', 'active');
        mkdirSync(path.join(selfSpecsDir, 'epic-1'), { recursive: true });
        writeFileSync(
          path.join(selfSpecsDir, 'epic-1', 'plan-v1.json'),
          JSON.stringify({
            epic_id: 'epic-1',
            version: 1,
            status: 'active',
            tasks: [],
            edges: [],
          }),
        );

        // No --specs-dir: planOptsFromFlags leaves specsDir undefined, so
        // the resolver falls back to SPECS_ACTIVE_DIR -- SMITH_HOME's own,
        // in this child process.
        const flags = ['--session', sessionId, '--state-dir', eventsDir];
        const { stdout, status } = runCli(['issues', 'preview', ...flags], envOverrides);
        expect(status).toBe(0);
        const [record] = JSON.parse(stdout);
        expect(record.task_ref).toBe('task-bare');
        expect(record.project).toBe('blacksmith');
        expect(record.outcome).not.toBe('skipped-unresolved-project');
      });

      // (iii) The session-stamp fallback: one row in a session carries an
      // explicit `project`, a sibling row in the SAME session carries none.
      // withSessionFallback's third and last step picks up the session-mate's
      // stamp for the unstamped row -- proven here against an EMPTY specs
      // dir, so a plan on disk cannot be the thing that resolves it.
      it("resolves an unstamped row from a session-mate's project stamp", () => {
        const sessionId = `cli-issues-sessfallback-${Date.now()}`;
        const eventsDir = path.join(scratchDir, `${sessionId}-events`);
        const specsDir = path.join(scratchDir, `${sessionId}-specs`);
        mkdirSync(specsDir, { recursive: true });
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
          project: 'stamped-project',
          event_type: 'gate-outcome',
          task_id: 'epic-a/task-x',
          causal_parent: rootId,
          payload: { outcome: 'blocked', reason: 'tests-failed' },
        });
        append({
          ...base,
          event_type: 'gate-outcome',
          task_id: 'epic-b/task-y',
          causal_parent: rootId,
          payload: { outcome: 'blocked', reason: 'tests-failed' },
        });

        const flags = ['--session', sessionId, '--specs-dir', specsDir, '--state-dir', eventsDir];
        const { stdout, status } = runCli(['issues', 'preview', ...flags]);
        expect(status).toBe(0);
        const records: Array<{ task_ref: string; project: string | null; outcome?: string }> =
          JSON.parse(stdout);
        expect(records).toHaveLength(2);
        const unstamped = records.find((r) => r.task_ref === 'epic-b/task-y');
        if (!unstamped) throw new Error('no record for epic-b/task-y');
        // Neither the direct resolver (no plan on disk) nor the session's
        // task-added map (there is none) could have produced this --
        // the session stamp is the only path left standing.
        expect(unstamped.project).toBe('stamped-project');
        expect(unstamped.outcome).not.toBe('skipped-unresolved-project');
      });

      // (iv) S3: the same session-stamp fallback as (iii), but the stamped
      // row lives under a DIFFERENT epic than the one `--epic` narrows to.
      // `scopeIssueCandidates` drops the stamped row from the candidate
      // list `events` before it ever reaches the fold -- if the session
      // stamp were read off that same narrowed list, the unstamped row
      // would lose its only path to a project and settle
      // skipped-unresolved-project purely because of the `--epic` flag,
      // silently changing this row's fingerprint depending on whether the
      // caller happened to pass --epic. `issueInputs`'s `lineageEvents`
      // (unscoped) is what the session-stamp tier must consult instead, so
      // the row resolves exactly as it did in (iii) even though `--epic`
      // excludes the row that carries the stamp.
      it("resolves an unstamped row from a session-mate's stamp even when --epic excludes the stamped row (S3)", () => {
        const sessionId = `cli-issues-sessfallback-epic-${Date.now()}`;
        const eventsDir = path.join(scratchDir, `${sessionId}-events`);
        const specsDir = path.join(scratchDir, `${sessionId}-specs`);
        mkdirSync(specsDir, { recursive: true });
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
          project: 'stamped-project',
          event_type: 'gate-outcome',
          task_id: 'epic-a/task-x',
          causal_parent: rootId,
          payload: { outcome: 'blocked', reason: 'tests-failed' },
        });
        append({
          ...base,
          event_type: 'gate-outcome',
          task_id: 'epic-b/task-y',
          causal_parent: rootId,
          payload: { outcome: 'blocked', reason: 'tests-failed' },
        });

        const flags = [
          '--session',
          sessionId,
          '--epic',
          'epic-b',
          '--specs-dir',
          specsDir,
          '--state-dir',
          eventsDir,
        ];
        const { stdout, status } = runCli(['issues', 'preview', ...flags]);
        expect(status).toBe(0);
        const records: Array<{ task_ref: string; project: string | null; outcome?: string }> =
          JSON.parse(stdout);
        // --epic epic-b narrowed the candidates to one row -- the stamped
        // epic-a/task-x row is history/scope only now, not a candidate.
        expect(records).toHaveLength(1);
        const [unstamped] = records;
        if (!unstamped) throw new Error('no record for epic-b/task-y');
        expect(unstamped.task_ref).toBe('epic-b/task-y');
        expect(unstamped.project).toBe('stamped-project');
        expect(unstamped.outcome).not.toBe('skipped-unresolved-project');
      });
    });
  });

  describe('security triggers (P9-4)', () => {
    async function writeSpec(name: string, spec: Record<string, unknown>): Promise<string> {
      const specPath = path.join(scratchDir, name);
      await writeFile(specPath, JSON.stringify({ task_id: 'epic-1/task-1', ...spec }));
      return specPath;
    }

    it('fires on a claim that touches a sensitive path, naming claim and glob', async () => {
      const specPath = await writeSpec('sec-fires.json', { claims: ['src/parse.ts'] });
      const { stdout, status } = runCli(['security', 'triggers', '--task', specPath]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.dispatchSecurityReviewer).toBe(true);
      expect(parsed.taskId).toBe('epic-1/task-1');
      expect(parsed.triggers[0]).toMatchObject({
        trigger: 'sensitive-claim-path',
        claim: 'src/parse.ts',
      });
    });

    it('exits 0 with no triggers when nothing fires — firing is not a violation', async () => {
      const specPath = await writeSpec('sec-quiet.json', {
        claims: ['src/coerce.ts'],
        case: 'feature',
      });
      const { stdout, status } = runCli(['security', 'triggers', '--task', specPath]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.dispatchSecurityReviewer).toBe(false);
      expect(parsed.triggers).toEqual([]);
    });

    it('reads an alternate policy with --policy', async () => {
      const policyPath = path.join(scratchDir, 'sec-policy.yml');
      await writeFile(policyPath, 'globs: ["**/coerce*"]\n');
      const specPath = await writeSpec('sec-alt.json', { claims: ['src/coerce.ts'] });
      const { stdout } = runCli([
        'security',
        'triggers',
        '--task',
        specPath,
        '--policy',
        policyPath,
      ]);
      expect(JSON.parse(stdout).triggers).toEqual([
        { trigger: 'sensitive-claim-path', claim: 'src/coerce.ts', glob: '**/coerce*' },
      ]);
    });

    it('accumulates repeated --epic-tag and keeps only the tags the policy lists', async () => {
      const specPath = await writeSpec('sec-tags.json', { claims: ['src/coerce.ts'] });
      const { stdout } = runCli([
        'security',
        'triggers',
        '--task',
        specPath,
        '--epic-tag',
        'ui',
        '--epic-tag',
        'security',
      ]);
      expect(JSON.parse(stdout).triggers).toEqual([{ trigger: 'epic-tag', tag: 'security' }]);
    });

    it('fires on --case infra and on --recheck', async () => {
      const specPath = await writeSpec('sec-case.json', { claims: ['src/coerce.ts'] });
      const { stdout } = runCli([
        'security',
        'triggers',
        '--task',
        specPath,
        '--case',
        'infra',
        '--recheck',
      ]);
      expect(JSON.parse(stdout).triggers).toEqual([
        { trigger: 'case', case: 'infra' },
        { trigger: 'scheduled-recheck' },
      ]);
    });

    it('requires --task', () => {
      const { stdout, status } = runCli(['security', 'triggers']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-flag');
      expect(parsed.error.message).toContain('--task');
    });
  });

  // "Read-only" was prose in six judge templates that all hold Bash
  // (agent-interviews.md N-10). The dispatcher now fingerprints the worktree
  // before the judge and verifies it after (P9-5).
  describe('worktree fingerprint / verify (P9-5)', () => {
    let repoDir: string;
    let fingerprintPath: string;

    beforeAll(async () => {
      repoDir = await mkdtemp(path.join(tmpdir(), 'smith-cli-immutability-'));
      runOrThrow('git', ['init', '-q', '-b', 'main', repoDir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
      await mkdir(path.join(repoDir, 'src'), { recursive: true });
      await writeFile(path.join(repoDir, 'src', 'parse.ts'), 'export const parse = () => 1;\n');
      runOrThrow('git', ['add', '.'], { cwd: repoDir });
      runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
      fingerprintPath = path.join(scratchDir, 'before.json');
    });

    afterAll(async () => {
      if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    it('fingerprint prints head, branch and entries, and exits 0', () => {
      const { stdout, status } = runCli(['worktree', 'fingerprint', repoDir]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.head).toMatch(/^[0-9a-f]{40}$/);
      expect(parsed.branch).toBe('main');
      expect(parsed.entries).toEqual({});
    });

    it('verify exits 0 on a worktree the judge only read', () => {
      writeFileSync(fingerprintPath, runCli(['worktree', 'fingerprint', repoDir]).stdout);
      const { stdout, status } = runCli([
        'worktree',
        'verify',
        repoDir,
        '--before',
        fingerprintPath,
      ]);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ unchanged: true, drift: [], violation: null });
    });

    it('verify exits 1 and names the paths when the judge edited the code it judged', async () => {
      writeFileSync(fingerprintPath, runCli(['worktree', 'fingerprint', repoDir]).stdout);
      await writeFile(path.join(repoDir, 'src', 'parse.ts'), 'export const parse = () => 2;\n');

      const { stdout, status } = runCli([
        'worktree',
        'verify',
        repoDir,
        '--before',
        fingerprintPath,
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.unchanged).toBe(false);
      expect(parsed.violation).toEqual({
        error: 'contract.judge-mutation',
        paths: ['src/parse.ts'],
      });
      runOrThrow('git', ['checkout', '--', 'src/parse.ts'], { cwd: repoDir });
    });

    it('verify requires --before rather than silently passing', () => {
      const { stdout, status } = runCli(['worktree', 'verify', repoDir]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-flag');
      expect(parsed.error.message).toContain('--before');
    });
  });

  describe('prompt wrap / research check (P9-6)', () => {
    it('wrap prints a fenced, labelled block on stdout', () => {
      const payload = path.join(scratchDir, 'fetched.txt');
      writeFileSync(payload, 'The loader reads .env before .env.local.\n');

      const { stdout, status } = runCli([
        'prompt',
        'wrap',
        payload,
        '--kind',
        'web-fetch',
        '--source',
        'https://example.com/docs/env',
      ]);

      expect(status).toBe(0);
      expect(stdout).toContain('BEGIN UNTRUSTED DATA');
      expect(stdout).toContain('source: https://example.com/docs/env');
      expect(stdout).toContain('The loader reads .env before .env.local.');
    });

    it('wrap --json returns the metadata a dispatcher records', () => {
      const payload = path.join(scratchDir, 'fetched.txt');
      writeFileSync(payload, 'body\n');

      const { stdout, status } = runCli([
        'prompt',
        'wrap',
        payload,
        '--kind',
        'issue-text',
        '--source',
        'example-org/example-app#12',
        '--json',
      ]);

      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.kind).toBe('issue-text');
      expect(parsed.digest).toMatch(/^[0-9a-f]{12}$/);
    });

    it('wrap refuses a kind outside the closed list', () => {
      const payload = path.join(scratchDir, 'fetched.txt');
      writeFileSync(payload, 'body\n');

      const { stdout, status } = runCli([
        'prompt',
        'wrap',
        payload,
        '--kind',
        'gossip',
        '--source',
        'somewhere',
      ]);

      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('provenance.unknown-ingest-kind');
    });

    it('research check exits 0 on a brief whose recommendation names its findings', () => {
      const briefPath = path.join(scratchDir, 'brief.json');
      writeFileSync(
        briefPath,
        JSON.stringify({
          question: 'Which file loads the env?',
          findings: [{ id: 'f1', claim: 'src/load.ts does.', citation: 'src/load.ts:42' }],
          recommendation: { statement: 'Read src/load.ts.', based_on: ['f1'] },
          open_questions: [],
        }),
      );

      const { stdout, status } = runCli(['research', 'check', '--brief', briefPath]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.recommendation.provenance).toBe('repo');
    });

    it('research check exits 1 and names the uncited claim', () => {
      const briefPath = path.join(scratchDir, 'brief-bad.json');
      writeFileSync(
        briefPath,
        JSON.stringify({
          question: 'Which file loads the env?',
          findings: [{ id: 'f1', claim: 'Everyone knows dotenv wins.', citation: '' }],
          recommendation: { statement: 'Use dotenv.', based_on: ['f1'] },
        }),
      );

      const { stdout, status } = runCli(['research', 'check', '--brief', briefPath]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.violations[0].error).toBe('contract.uncited-claim');
      expect(parsed.violations[0].findingId).toBe('f1');
    });

    describe('prompt capture', () => {
      const CLI_ID = '11111111-2222-4333-8444-555555555555';

      let homes = 0;
      function captureHome(): { env: Record<string, string>; eventsDir: string } {
        const home = path.join(scratchDir, `prompt-capture-home-${homes++}`);
        const eventsDir = path.join(home, 'state', 'events');
        mkdirSync(eventsDir, { recursive: true });
        return { env: { BS_HOME: home }, eventsDir };
      }

      it('records a hook payload from stdin and prints the one line', () => {
        const { env, eventsDir } = captureHome();
        const { stdout, status } = runCli(
          ['prompt', 'capture'],
          env,
          JSON.stringify({ session_id: CLI_ID, prompt: 'Fix the flaky import.', cwd: scratchDir }),
        );
        expect(status).toBe(0);
        expect(stdout.trim()).toBe(
          `bs prompt capture: {"event_id":"prompts-${CLI_ID}#1","session_id":"prompts-${CLI_ID}"}`,
        );
        const lines = readFileSync(path.join(eventsDir, `prompts-${CLI_ID}.jsonl`), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        expect(lines[1].payload).toEqual({ prompt: 'Fix the flaky import.', source: 'hook' });
      });

      it('prints nothing and exits 0 for malformed stdin and for a skipped prompt', () => {
        const { env, eventsDir } = captureHome();
        for (const input of [
          'not json',
          JSON.stringify({ session_id: CLI_ID, prompt: '<system-reminder>x</system-reminder>' }),
        ]) {
          const { stdout, status } = runCli(['prompt', 'capture'], env, input);
          expect(status).toBe(0);
          expect(stdout).toBe('');
        }
        expect(readdirSync(eventsDir)).toEqual([]);
      });
    });

    describe('prompt import', () => {
      const CLI_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
      let homes = 0;

      function transcript(): { env: Record<string, string>; eventsDir: string; file: string } {
        const home = path.join(scratchDir, `prompt-import-home-${homes++}`);
        const eventsDir = path.join(home, 'state', 'events');
        mkdirSync(eventsDir, { recursive: true });
        const file = path.join(home, 'transcript.jsonl');
        const rows = ['Add the beta-app export.', 'Rename the acme flag.'].map((text, i) => ({
          type: 'user',
          sessionId: CLI_ID,
          cwd: scratchDir,
          uuid: `uuid-${i}`,
          timestamp: `2026-01-01T00:00:0${i}.000Z`,
          origin: { kind: 'human' },
          promptId: `prompt-${i}`,
          message: { role: 'user', content: text },
        }));
        writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
        return { env: { BS_HOME: home }, eventsDir, file };
      }

      it('imports, ends stdout with the summary line, and a second run imports 0', () => {
        const { env, eventsDir, file } = transcript();
        const first = runCli(['prompt', 'import', '--transcript', file], env);
        expect(first.status).toBe(0);
        expect(first.stdout.trim()).toBe(
          `{"session_id":"prompts-${CLI_ID}","imported":2,"skipped":{"duplicate":0,"older":0,"harness":0,"afk":0}}`,
        );
        expect(
          readFileSync(path.join(eventsDir, `prompts-${CLI_ID}.jsonl`), 'utf8')
            .trim()
            .split('\n'),
        ).toHaveLength(3);
        const second = runCli(['prompt', 'import', '--transcript', file], env);
        expect(second.stdout.trim()).toBe(
          `{"session_id":"prompts-${CLI_ID}","imported":0,"skipped":{"duplicate":2,"older":0,"harness":0,"afk":0}}`,
        );
      });

      it('--dry-run prints each event, then the summary, and writes nothing', () => {
        const { env, eventsDir, file } = transcript();
        const { stdout, status } = runCli(
          ['prompt', 'import', '--transcript', file, '--dry-run'],
          env,
        );
        expect(status).toBe(0);
        const out = stdout.trim().split('\n');
        expect(out).toHaveLength(4);
        expect(JSON.parse(out[1] as string)).toMatchObject({ event_type: 'user_prompt' });
        expect(JSON.parse(out[3] as string)).toMatchObject({ imported: 2 });
        expect(readdirSync(eventsDir)).toEqual([]);
      });

      it('exits 1 with prompts.import-unmanaged for a cwd outside every store', () => {
        const { file } = transcript();
        const { stdout, stderr, status } = runCli(['prompt', 'import', '--transcript', file], {
          BS_HOME: path.join(scratchDir, 'prompt-import-no-store'),
        });
        expect(status).toBe(1);
        expect(stdout + stderr).toContain('prompts.import-unmanaged');
      });

      it('requires --transcript', () => {
        expect(runCli(['prompt', 'import']).status).toBe(1);
      });
    });

    describe('prompt record (D-142)', () => {
      const promptsDir = () => path.join(scratchDir, 'prompt-record-events');

      function seedSession(sessionId: string): string {
        const { stdout, status } = runCli([
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
          promptsDir(),
        ]);
        expect(status).toBe(0);
        return JSON.parse(stdout).event_id;
      }

      function record(sessionId: string, parent: string, file: string) {
        return runCli([
          'prompt',
          'record',
          file,
          '--session',
          sessionId,
          '--causal-parent',
          parent,
          '--state-dir',
          promptsDir(),
        ]);
      }

      it('appends the operator turn and prints the id a dispatch hangs off', () => {
        const root = seedSession('rec-1');
        const file = path.join(scratchDir, 'turn.txt');
        writeFileSync(file, 'Fix the flaky import.\n');

        const { stdout, status } = record('rec-1', root, file);

        expect(status).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.event_id).toBe('rec-1#1');
        expect(parsed.record.event_type).toBe('user_prompt');
        expect(parsed.record.actor).toBe('user');
        // The trailing newline the file ends with survives: verbatim is the
        // spec's word for what this event holds.
        expect(parsed.record.payload.prompt).toBe('Fix the flaky import.\n');
      });

      it('reads the turn from stdin, which is how one is actually typed', () => {
        const root = seedSession('rec-2');

        const { stdout, status } = runCli(
          [
            'prompt',
            'record',
            '-',
            '--session',
            'rec-2',
            '--causal-parent',
            root,
            '--state-dir',
            promptsDir(),
          ],
          undefined,
          'Ship the widget.',
        );

        expect(status).toBe(0);
        expect(JSON.parse(stdout).record.payload.prompt).toBe('Ship the widget.');
      });

      it('refuses a whitespace-only turn and writes nothing', () => {
        const root = seedSession('rec-3');
        const file = path.join(scratchDir, 'blank.txt');
        writeFileSync(file, '   \n\n');

        const { stdout, status } = record('rec-3', root, file);

        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('prompts.empty-prompt');

        const tail = runCli(['event', 'tail', 'rec-3', '--state-dir', promptsDir()]);
        expect(JSON.parse(tail.stdout).length).toBe(1);
      });

      it('rejects a causal_parent that is not in this session', () => {
        seedSession('rec-4');
        const file = path.join(scratchDir, 'turn.txt');
        writeFileSync(file, 'Fix it.\n');

        const { status } = record('rec-4', 'rec-4#9', file);
        expect(status).toBe(1);
      });
    });
  });

  describe('feedback record / pending / resolve', () => {
    const feedbackDir = () => path.join(scratchDir, 'feedback-events');

    function seedSession(sessionId: string): string {
      const { stdout, status } = runCli([
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
        feedbackDir(),
      ]);
      expect(status).toBe(0);
      return JSON.parse(stdout).event_id;
    }

    function addTask(
      sessionId: string,
      parent: string,
      taskId: string,
      taskStatus: string,
    ): string {
      const { stdout, status } = runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          actor: 'system',
          event_type: 'task-added',
          task_id: taskId,
          plan_version: 1,
          causal_parent: parent,
          payload: { task_status: taskStatus },
        }),
        '--state-dir',
        feedbackDir(),
      ]);
      expect(status).toBe(0);
      return JSON.parse(stdout).event_id;
    }

    function record(sessionId: string, parent: string, taskId: string, extra: string[] = []) {
      return runCli([
        'feedback',
        'record',
        '--task',
        taskId,
        '--body',
        'Please fix the flaky test.',
        '--session',
        sessionId,
        '--causal-parent',
        parent,
        '--state-dir',
        feedbackDir(),
        ...extra,
      ]);
    }

    describe('feedback record', () => {
      it('appends operator-feedback-recorded and prints event_id/feedback_id', () => {
        const root = seedSession('fb-rec-1');
        const taskAdded = addTask('fb-rec-1', root, 'epic-1/task-1', 'todo');

        const { stdout, status } = record('fb-rec-1', taskAdded, 'epic-1/task-1');

        expect(status).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.event_id).toBe('fb-rec-1#2');
        expect(parsed.feedback_id).toMatch(/^fb-/);
        expect(parsed.deduped).toBe(false);
      });

      it('defaults kind to must-fix and source to cli, visible through feedback pending', () => {
        const root = seedSession('fb-rec-2');
        const rec = record('fb-rec-2', root, 'epic-1/task-1');
        const feedbackId = JSON.parse(rec.stdout).feedback_id;

        const pending = runCli([
          'feedback',
          'pending',
          '--session',
          'fb-rec-2',
          '--state-dir',
          feedbackDir(),
        ]);
        const item = JSON.parse(pending.stdout).pending.find(
          (p: { feedbackId: string }) => p.feedbackId === feedbackId,
        );
        expect(item).toMatchObject({ kind: 'must-fix', source: 'cli' });
      });

      it('reads the body from --body-file', () => {
        const root = seedSession('fb-rec-3');
        const file = path.join(scratchDir, 'feedback-body.txt');
        writeFileSync(file, 'From a file.\n');

        const { stdout, status } = runCli([
          'feedback',
          'record',
          '--task',
          'epic-1/task-1',
          '--body-file',
          file,
          '--session',
          'fb-rec-3',
          '--causal-parent',
          root,
          '--state-dir',
          feedbackDir(),
        ]);

        expect(status).toBe(0);
        expect(JSON.parse(stdout).feedback_id).toMatch(/^fb-/);
      });

      it('rejects neither --body nor --body-file', () => {
        const root = seedSession('fb-rec-7');
        const { stdout, status } = runCli([
          'feedback',
          'record',
          '--task',
          'epic-1/task-1',
          '--session',
          'fb-rec-7',
          '--causal-parent',
          root,
          '--state-dir',
          feedbackDir(),
        ]);
        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('cli.missing-flag');
      });

      it('refuses a whitespace-only body and writes nothing', () => {
        const root = seedSession('fb-rec-4');
        const { stdout, status } = runCli([
          'feedback',
          'record',
          '--task',
          'epic-1/task-1',
          '--body',
          '   ',
          '--session',
          'fb-rec-4',
          '--causal-parent',
          root,
          '--state-dir',
          feedbackDir(),
        ]);

        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('feedback.empty-body');

        const tail = runCli(['event', 'tail', 'fb-rec-4', '--state-dir', feedbackDir()]);
        expect(JSON.parse(tail.stdout).length).toBe(1);
      });

      it('rejects an invalid --kind', () => {
        const root = seedSession('fb-rec-5');
        const { stdout, status } = record('fb-rec-5', root, 'epic-1/task-1', ['--kind', 'urgent']);
        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('cli.invalid-flag');
      });

      it('rejects an invalid --source', () => {
        const root = seedSession('fb-rec-8');
        const { stdout, status } = record('fb-rec-8', root, 'epic-1/task-1', ['--source', 'slack']);
        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('cli.invalid-flag');
      });

      it('is idempotent on --external-id: a repeat returns the same feedback_id and appends nothing', () => {
        const root = seedSession('fb-rec-6');
        const first = record('fb-rec-6', root, 'epic-1/task-1', [
          '--source',
          'github',
          '--external-id',
          'gh-comment:1',
        ]);
        const firstParsed = JSON.parse(first.stdout);

        const second = record('fb-rec-6', firstParsed.event_id, 'epic-1/task-1', [
          '--source',
          'github',
          '--external-id',
          'gh-comment:1',
        ]);

        expect(second.status).toBe(0);
        const secondParsed = JSON.parse(second.stdout);
        expect(secondParsed.feedback_id).toBe(firstParsed.feedback_id);
        expect(secondParsed.deduped).toBe(true);

        const tail = runCli(['event', 'tail', 'fb-rec-6', '--state-dir', feedbackDir()]);
        expect(
          JSON.parse(tail.stdout).filter(
            (r: { record: { event_type: string } }) =>
              r.record.event_type === 'operator-feedback-recorded',
          ),
        ).toHaveLength(1);
      });
    });

    describe('feedback pending', () => {
      it('lists unresolved feedback for a session, suggesting bounce for an open task', () => {
        const root = seedSession('fb-pen-1');
        const taskAdded = addTask('fb-pen-1', root, 'epic-1/task-1', 'todo');
        record('fb-pen-1', taskAdded, 'epic-1/task-1');

        const { stdout, status } = runCli([
          'feedback',
          'pending',
          '--session',
          'fb-pen-1',
          '--state-dir',
          feedbackDir(),
        ]);

        expect(status).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.count).toBe(1);
        expect(parsed.pending[0]).toMatchObject({
          taskId: 'epic-1/task-1',
          suggestedAction: 'bounce',
        });
      });

      it('suggests follow-up once the task is closed to further work', () => {
        const root = seedSession('fb-pen-2');
        const taskAdded = addTask('fb-pen-2', root, 'epic-1/task-2', 'completed');
        record('fb-pen-2', taskAdded, 'epic-1/task-2');

        const { stdout } = runCli([
          'feedback',
          'pending',
          '--session',
          'fb-pen-2',
          '--state-dir',
          feedbackDir(),
        ]);
        expect(JSON.parse(stdout).pending[0].suggestedAction).toBe('follow-up');
      });

      it('narrows by --task', () => {
        const root = seedSession('fb-pen-3');
        const t1 = addTask('fb-pen-3', root, 'epic-1/task-1', 'todo');
        const rec1 = record('fb-pen-3', t1, 'epic-1/task-1');
        const t2 = addTask('fb-pen-3', JSON.parse(rec1.stdout).event_id, 'epic-1/task-2', 'todo');
        record('fb-pen-3', t2, 'epic-1/task-2');

        const { stdout } = runCli([
          'feedback',
          'pending',
          '--session',
          'fb-pen-3',
          '--task',
          'epic-1/task-1',
          '--state-dir',
          feedbackDir(),
        ]);
        const parsed = JSON.parse(stdout);
        expect(parsed.count).toBe(1);
        expect(parsed.pending[0].taskId).toBe('epic-1/task-1');
      });

      it('narrows by --epic', () => {
        const root = seedSession('fb-pen-4');
        const t1 = addTask('fb-pen-4', root, 'epic-1/task-1', 'todo');
        const rec1 = record('fb-pen-4', t1, 'epic-1/task-1');
        const t2 = addTask('fb-pen-4', JSON.parse(rec1.stdout).event_id, 'epic-2/task-1', 'todo');
        record('fb-pen-4', t2, 'epic-2/task-1');

        const { stdout } = runCli([
          'feedback',
          'pending',
          '--session',
          'fb-pen-4',
          '--epic',
          'epic-2',
          '--state-dir',
          feedbackDir(),
        ]);
        const parsed = JSON.parse(stdout);
        expect(parsed.count).toBe(1);
        expect(parsed.pending[0].taskId).toBe('epic-2/task-1');
      });

      it('omits a resolved feedback item', () => {
        const root = seedSession('fb-pen-5');
        const t1 = addTask('fb-pen-5', root, 'epic-1/task-1', 'todo');
        const rec = record('fb-pen-5', t1, 'epic-1/task-1');
        const recParsed = JSON.parse(rec.stdout);
        runCli([
          'feedback',
          'resolve',
          '--feedback',
          recParsed.feedback_id,
          '--resolution',
          'dismissed',
          '--session',
          'fb-pen-5',
          '--causal-parent',
          recParsed.event_id,
          '--state-dir',
          feedbackDir(),
        ]);

        const { stdout } = runCli([
          'feedback',
          'pending',
          '--session',
          'fb-pen-5',
          '--state-dir',
          feedbackDir(),
        ]);
        expect(JSON.parse(stdout).count).toBe(0);
      });

      it('rejects a session that was never started', () => {
        const { status } = runCli([
          'feedback',
          'pending',
          '--session',
          'fb-pen-never',
          '--state-dir',
          feedbackDir(),
        ]);
        expect(status).toBe(1);
      });
    });

    describe('feedback resolve', () => {
      it('resolves as bounced and prints the event', () => {
        const root = seedSession('fb-res-1');
        const t1 = addTask('fb-res-1', root, 'epic-1/task-1', 'todo');
        const rec = record('fb-res-1', t1, 'epic-1/task-1');
        const recParsed = JSON.parse(rec.stdout);

        const { stdout, status } = runCli([
          'feedback',
          'resolve',
          '--feedback',
          recParsed.feedback_id,
          '--resolution',
          'bounced',
          '--session',
          'fb-res-1',
          '--causal-parent',
          recParsed.event_id,
          '--state-dir',
          feedbackDir(),
        ]);

        expect(status).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.record.event_type).toBe('operator-feedback-resolved');
        expect(parsed.record.payload.resolution).toBe('bounced');
      });

      it('rejects an unknown feedback id', () => {
        const root = seedSession('fb-res-2');
        const { stdout, status } = runCli([
          'feedback',
          'resolve',
          '--feedback',
          'fb-does-not-exist',
          '--resolution',
          'dismissed',
          '--session',
          'fb-res-2',
          '--causal-parent',
          root,
          '--state-dir',
          feedbackDir(),
        ]);
        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('feedback.unknown-feedback');
      });

      it('rejects resolving the same feedback twice', () => {
        const root = seedSession('fb-res-3');
        const t1 = addTask('fb-res-3', root, 'epic-1/task-1', 'todo');
        const rec = record('fb-res-3', t1, 'epic-1/task-1');
        const recParsed = JSON.parse(rec.stdout);

        const first = runCli([
          'feedback',
          'resolve',
          '--feedback',
          recParsed.feedback_id,
          '--resolution',
          'dismissed',
          '--session',
          'fb-res-3',
          '--causal-parent',
          recParsed.event_id,
          '--state-dir',
          feedbackDir(),
        ]);
        expect(first.status).toBe(0);

        const second = runCli([
          'feedback',
          'resolve',
          '--feedback',
          recParsed.feedback_id,
          '--resolution',
          'bounced',
          '--session',
          'fb-res-3',
          '--causal-parent',
          JSON.parse(first.stdout).event_id,
          '--state-dir',
          feedbackDir(),
        ]);
        expect(second.status).toBe(1);
        expect(JSON.parse(second.stdout).error.code).toBe('feedback.already-resolved');
      });

      it('rejects follow-up resolution with no --follow-up-task, and appends no event', () => {
        const root = seedSession('fb-res-5');
        const t1 = addTask('fb-res-5', root, 'epic-1/task-1', 'todo');
        const rec = record('fb-res-5', t1, 'epic-1/task-1');
        const recParsed = JSON.parse(rec.stdout);

        const { stdout, status } = runCli([
          'feedback',
          'resolve',
          '--feedback',
          recParsed.feedback_id,
          '--resolution',
          'follow-up',
          '--session',
          'fb-res-5',
          '--causal-parent',
          recParsed.event_id,
          '--state-dir',
          feedbackDir(),
        ]);
        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('feedback.missing-follow-up-task');

        const pending = runCli([
          'feedback',
          'pending',
          '--session',
          'fb-res-5',
          '--state-dir',
          feedbackDir(),
        ]);
        expect(
          JSON.parse(pending.stdout).pending.some(
            (p: { feedbackId: string }) => p.feedbackId === recParsed.feedback_id,
          ),
        ).toBe(true);
      });

      it('rejects a --follow-up-task on a non-follow-up resolution, and appends no event', () => {
        const root = seedSession('fb-res-6');
        const t1 = addTask('fb-res-6', root, 'epic-1/task-1', 'todo');
        const rec = record('fb-res-6', t1, 'epic-1/task-1');
        const recParsed = JSON.parse(rec.stdout);

        const { stdout, status } = runCli([
          'feedback',
          'resolve',
          '--feedback',
          recParsed.feedback_id,
          '--resolution',
          'bounced',
          '--follow-up-task',
          'epic-1/task-2',
          '--session',
          'fb-res-6',
          '--causal-parent',
          recParsed.event_id,
          '--state-dir',
          feedbackDir(),
        ]);
        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('feedback.unexpected-follow-up-task');

        const pending = runCli([
          'feedback',
          'pending',
          '--session',
          'fb-res-6',
          '--state-dir',
          feedbackDir(),
        ]);
        expect(
          JSON.parse(pending.stdout).pending.some(
            (p: { feedbackId: string }) => p.feedbackId === recParsed.feedback_id,
          ),
        ).toBe(true);
      });

      it('rejects an invalid --resolution', () => {
        const root = seedSession('fb-res-4');
        const t1 = addTask('fb-res-4', root, 'epic-1/task-1', 'todo');
        const rec = record('fb-res-4', t1, 'epic-1/task-1');
        const recParsed = JSON.parse(rec.stdout);

        const { status } = runCli([
          'feedback',
          'resolve',
          '--feedback',
          recParsed.feedback_id,
          '--resolution',
          'ignored',
          '--session',
          'fb-res-4',
          '--causal-parent',
          recParsed.event_id,
          '--state-dir',
          feedbackDir(),
        ]);
        expect(status).toBe(1);
      });
    });
  });
});
