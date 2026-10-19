import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertExited, runProcess } from './helpers/process.js';

// ---------------------------------------------------------------------------
// D13 step 3 -- the wiring, not the rule.
//
// `delegation.test.ts` asserts the two checks against their own inputs. This
// file asserts the verb: that `smith delegation check` reads the LINEAGE and
// not one session (D-119, and here it is the whole point -- a wave-runner's
// dispatches land in its own log, so a session-scoped read would find the
// delegation it exists to audit absent and call that a pass), that the report
// carries both halves because they fail apart, and that the exit code is
// fail-closed on `unverifiable` as well as on `violation`.
//
// Every scenario below is one status the check can return, driven end to end
// through the built binary over the exact topology the grant produces.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');

const EPIC = 'epic-1';
const WAVE = 'wave-1';
const T1 = 'E1/t-1';

interface Run {
  stdout: string;
  stderr: string;
  status: number;
}

interface Check {
  role: string;
  sessionId: string | null;
  status: string;
  detail: string;
}

describe('smith delegation check (D13 step 3)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-delegation-cli-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  function smith(args: string[]): Run {
    const run = runProcess('node', [CLI_PATH, ...args, '--state-dir', stateDir]);
    assertExited(run, `smith ${args.join(' ')}`);
    return { stdout: run.stdout, stderr: run.stderr, status: run.status as number };
  }

  function start(sessionId: string, continues?: string, actor?: string): string {
    const args = ['session', 'start', sessionId];
    if (continues !== undefined) args.push('--continues', continues);
    if (actor !== undefined) args.push('--actor', actor);
    const run = smith(args);
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout).event_id as string;
  }

  function dispatch(
    sessionId: string,
    parent: string,
    actor: string,
    role: string,
    taskId: string,
  ): string {
    const run = smith([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor,
        event_type: 'dispatch_decision',
        task_id: taskId,
        plan_version: 1,
        causal_parent: parent,
        payload: {
          agent_role: role,
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
        },
      }),
    ]);
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout).event_id as string;
  }

  /** The epic session, up to and including the dispatch that starts the wave. */
  function dispatchTheWave(): string {
    const root = start(EPIC);
    return dispatch(EPIC, root, 'operator', 'wave-runner', T1);
  }

  function check(sessionId: string): { run: Run; checks: Check[]; ok: boolean } {
    const run = smith(['delegation', 'check', sessionId]);
    const report = JSON.parse(run.stdout);
    return { run, checks: report.log.checks as Check[], ok: report.ok as boolean };
  }

  it('reports a dispatched grantee that has not opened its log as unverifiable, and exits 1', () => {
    dispatchTheWave();

    const { run, checks, ok } = check(EPIC);

    expect(ok).toBe(false);
    expect(run.status).toBe(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('unverifiable');
    expect(checks[0]?.detail).toMatch(/has opened no session against it yet/);
  });

  it('passes a grantee that opened its own log against the dispatch, and exits 0', () => {
    const dispatched = dispatchTheWave();
    const waveRoot = start(WAVE, dispatched, 'wave-runner');
    dispatch(WAVE, waveRoot, 'wave-runner', 'coder', T1);

    const { run, checks, ok } = check(EPIC);

    expect(ok).toBe(true);
    expect(run.status).toBe(0);
    expect(checks.map((c) => c.status)).toEqual(['ok']);
    expect(checks[0]?.sessionId).toBe(WAVE);
    expect(checks[0]?.detail).toMatch(/opened session wave-1 against it/);
  });

  it('answers the same from the wave session, because lineage walks up as well as down', () => {
    const dispatched = dispatchTheWave();
    const waveRoot = start(WAVE, dispatched, 'wave-runner');
    dispatch(WAVE, waveRoot, 'wave-runner', 'coder', T1);

    // The control D-119 asks for: if this verb read one session's log, the
    // epic's dispatch would be invisible from here and the wave would audit
    // as a session nobody delegated to -- a pass for the wrong reason.
    const { run, checks, ok } = check(WAVE);

    expect(ok).toBe(true);
    expect(run.status).toBe(0);
    expect(checks.map((c) => c.status)).toEqual(['ok']);
  });

  /** A wave-runner's terminal in the epic session, as the epic session logs a failed wave. */
  function waveRunnerFails(parent: string): void {
    const run = smith([
      'event',
      'append',
      JSON.stringify({
        session_id: EPIC,
        actor: 'operator',
        event_type: 'error-logged',
        task_id: T1,
        plan_version: 1,
        causal_parent: parent,
        payload: {
          error: 'execution.env-failure',
          severity: 'S2-major',
          task_ref: T1,
          agent: 'wave-runner',
          agent_role: 'wave-runner',
        },
      }),
    ]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
  }

  describe('from a later wave session, whose earlier siblings are outside its lineage', () => {
    const WAVE2 = 'wave-2';
    const T2 = 'E1/t-2';

    /** Epic dispatches wave 1 and wave 2; each wave-runner opens its own session. */
    function twoWaves(): { epicRoot: string; first: string; second: string } {
      const epicRoot = start(EPIC);
      const first = dispatch(EPIC, epicRoot, 'operator', 'wave-runner', T1);
      const waveRoot = start(WAVE, first, 'wave-runner');
      dispatch(WAVE, waveRoot, 'wave-runner', 'coder', T1);
      const second = dispatch(EPIC, first, 'operator', 'wave-runner', T2);
      const wave2Root = start(WAVE2, second, 'wave-runner');
      dispatch(WAVE2, wave2Root, 'wave-runner', 'coder', T2);
      return { epicRoot, first, second };
    }

    it('reads the earlier wave-runner dispatch as ok, because a session opened against it', () => {
      twoWaves();

      const { run, checks, ok } = check(WAVE2);

      expect(checks.map((c) => `${c.status}:${c.sessionId}`).sort()).toEqual([
        'ok:wave-1',
        'ok:wave-2',
      ]);
      expect(ok).toBe(true);
      expect(run.status).toBe(0);
    });

    it('still reads a dispatch that opened no session anywhere as unverifiable', () => {
      const { first } = twoWaves();
      const lost = dispatch(EPIC, first, 'operator', 'wave-runner', 'E1/t-3');

      const { run, checks, ok } = check(WAVE2);

      expect(ok).toBe(false);
      expect(run.status).toBe(1);
      const unverifiable = checks.filter((c) => c.status === 'unverifiable');
      expect(unverifiable).toHaveLength(1);
      expect(unverifiable[0]?.detail).toContain(lost);
    });

    it('still reads it as a violation when a wave-runner terminal follows it in the epic', () => {
      const { first } = twoWaves();
      const lost = dispatch(EPIC, first, 'operator', 'wave-runner', T1);
      waveRunnerFails(lost);

      const { run, checks, ok } = check(WAVE2);

      expect(ok).toBe(false);
      expect(run.status).toBe(1);
      expect(checks.some((c) => c.status === 'violation')).toBe(true);
    });

    // Observed, not endorsed: a resumed wave-runner keeps writing into the
    // session it opened and opens no new one, so the second dispatch of the
    // same role and task has no session of its own to point at.
    it('reports a re-dispatch that resumes an open wave-runner the same from the epic and from the wave', () => {
      const { first } = twoWaves();
      dispatch(EPIC, first, 'operator', 'wave-runner', T1);

      const fromEpic = check(EPIC);
      const fromWave = check(WAVE);

      expect(fromEpic.checks.map((c) => c.status).sort()).toEqual(
        fromWave.checks.map((c) => c.status).sort(),
      );
      expect(fromEpic.checks.filter((c) => c.status === 'unverifiable')).toHaveLength(1);
    });

    it('answers from the epic session as it always did', () => {
      twoWaves();

      const { run, checks, ok } = check(EPIC);

      expect(checks.map((c) => `${c.status}:${c.sessionId}`).sort()).toEqual([
        'ok:wave-1',
        'ok:wave-2',
      ]);
      expect(ok).toBe(true);
      expect(run.status).toBe(0);
    });
  });

  it('answers a resumed wave-runner from the session its original dispatch opened', () => {
    const dispatched = dispatchTheWave();
    const waveRoot = start(WAVE, dispatched, 'wave-runner');
    dispatch(WAVE, waveRoot, 'wave-runner', 'coder', T1);
    const run = smith([
      'event',
      'append',
      JSON.stringify({
        session_id: EPIC,
        actor: 'operator',
        event_type: 'dispatch_decision',
        task_id: T1,
        plan_version: 1,
        causal_parent: dispatched,
        payload: {
          agent_role: 'wave-runner',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
          continuation_of: dispatched,
        },
      }),
    ]);
    expect(run.status, run.stderr).toBe(0);
    const resumed = JSON.parse(run.stdout).event_id as string;

    const { run: checkRun, checks, ok } = check(EPIC);

    expect(ok).toBe(true);
    expect(checkRun.status).toBe(0);
    expect(checks.map((c) => `${c.status}:${c.sessionId}`)).toEqual(['ok:wave-1', 'ok:wave-1']);
    expect(checks.some((c) => c.detail.includes(resumed))).toBe(true);
  });

  it('reports a grantee dispatching outside its grant as a violation, and exits 1', () => {
    const dispatched = dispatchTheWave();
    const waveRoot = start(WAVE, dispatched, 'wave-runner');
    // `planner` is deliberately absent from the grant: a wave that could
    // re-plan itself could plan its way out of the plan it was admitted under.
    dispatch(WAVE, waveRoot, 'wave-runner', 'planner', T1);

    const { run, checks, ok } = check(EPIC);

    expect(ok).toBe(false);
    expect(run.status).toBe(1);
    expect(checks.some((c) => c.status === 'violation')).toBe(true);
    expect(checks.find((c) => c.status === 'violation')?.detail).toMatch(
      /dispatched `planner`.*which its delegation\.yml grant does not list/,
    );
  });

  it('reports a second writer inside a delegated session as a violation', () => {
    const dispatched = dispatchTheWave();
    const waveRoot = start(WAVE, dispatched, 'wave-runner');
    // The grant is enforced against an actor string, so a delegated session
    // with two authors is a grant enforced against nobody in particular.
    const first = dispatch(WAVE, waveRoot, 'wave-runner', 'coder', T1);
    dispatch(WAVE, first, 'coder', 'tester', T1);

    const { run, checks, ok } = check(EPIC);

    expect(ok).toBe(false);
    expect(run.status).toBe(1);
    expect(checks.some((c) => c.detail.includes('One dispatching node, one log'))).toBe(true);
  });

  it('reports the shipped topology alongside the run, because the two fail apart', () => {
    dispatchTheWave();

    const report = JSON.parse(smith(['delegation', 'check', EPIC]).stdout);

    // `grants` reads the files that ship in this repo, so it answers the same
    // whatever the log says: the topology can be sound while the run disobeys
    // it, which is exactly why both halves are in one report.
    expect(report.session).toBe(EPIC);
    expect(report.grants.ok).toBe(true);
    expect(report.grants.grantsExamined).toBeGreaterThan(0);
    expect(report.log.ok).toBe(false);
  });

  it('refuses a session that does not exist rather than answering about an empty log', () => {
    const run = smith(['delegation', 'check', 'no-such-session']);

    expect(run.status).not.toBe(0);
    expect(JSON.parse(run.stdout).error).toBeDefined();
  });
});
