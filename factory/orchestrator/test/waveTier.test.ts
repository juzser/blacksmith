import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertExited, runProcess } from './helpers/process.js';

// ---------------------------------------------------------------------------
// D13 step 2 -- the premise, not the prose.
//
// The finding's fix is to split `/bs` into an epic-level playbook and a
// disposable wave-level one, "so each tier owns the log for what it
// dispatches". A wave tier that owns its own log is a SECOND SESSION: it opens
// with `session start <wave-id> --continues <epic-session>#<n>` and writes its
// dispatches there, which is the whole point -- the epic session stops
// carrying every wave's turns in its window.
//
// That only works if every epic-level read still sees the wave's work. Each of
// these verbs decides something (was the wave parallel, has the epic crossed
// its alarm, did a tester grade its own coder, is a judge turn still owed) and
// each one is asked with the session the OPERATOR is standing in, which after
// the split is the epic session and not the session that did the dispatching.
// D-119 is the whole reason to be nervous: `sessionLineage` shipped read by
// two display verbs while every deciding fold still read one session's log,
// and splitting a real log in two turned `hold` with eleven open findings into
// `go` with none.
//
// So this file drives the built binary over the exact topology the split
// produces, and pairs every claim with the sibling-scoped control that would
// have caught a session-scoped read: a wave sees its own ancestry and not its
// siblings, so a verb that answers the same from both sessions is not reading
// the lineage -- it is reading the whole directory.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');

interface Run {
  stdout: string;
  stderr: string;
  status: number;
}

function runCli(args: string[]): Run {
  const run = runProcess('node', [CLI_PATH, ...args]);
  assertExited(run, `smith ${args.join(' ')}`);
  return { stdout: run.stdout, stderr: run.stderr, status: run.status as number };
}

const EPIC = 'epic-1';
const T1 = 'E1/t-1';
const T2 = 'E1/t-2';

describe('an epic session and the wave sessions it fans out into (D13 step 2)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-wave-tier-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  function smith(args: string[]): Run {
    return runCli([...args, '--state-dir', stateDir]);
  }

  function start(sessionId: string, continues?: string): string {
    const args = ['session', 'start', sessionId];
    if (continues !== undefined) args.push('--continues', continues);
    const run = smith(args);
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout).event_id as string;
  }

  function append(
    sessionId: string,
    parent: string,
    eventType: string,
    payload: Record<string, unknown>,
    taskId?: string,
  ): string {
    const input = {
      session_id: sessionId,
      actor: 'system',
      event_type: eventType,
      ...(taskId === undefined ? {} : { task_id: taskId }),
      plan_version: 1,
      causal_parent: parent,
      payload,
    };
    const run = smith(['event', 'append', JSON.stringify(input)]);
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout).event_id as string;
  }

  function dispatch(sessionId: string, parent: string, role: string, taskId: string): string {
    return append(
      sessionId,
      parent,
      'dispatch_decision',
      { agent_role: role, provider: 'claude', model_tier: 'frontier', model: 'claude-opus-5' },
      taskId,
    );
  }

  function result(
    sessionId: string,
    parent: string,
    role: string,
    taskId: string,
    tokens: number,
  ): string {
    return append(
      sessionId,
      parent,
      'task-result-recorded',
      { agent: role, token_usage: { total_tokens: tokens } },
      taskId,
    );
  }

  /**
   * The topology the split produces. The epic session admits the wave and
   * writes nothing else; `wave-1` dispatches both of its tasks and comes back;
   * `wave-2` is the next wave's session, opened but not yet worked -- the
   * sibling every control below is asked from.
   */
  function fanOut(): void {
    let epic = start(EPIC);
    epic = append(EPIC, epic, 'wave-admitted', {
      epic_id: 'E1',
      wave: 1,
      task_ids: [T1, T2],
    });
    let w1 = start('wave-1', epic);
    // Interleaved on purpose: two coders live at once is the fact `wave audit`
    // exists to confirm, and the log's only evidence of it is the order of
    // these four records.
    w1 = dispatch('wave-1', w1, 'coder', T1);
    w1 = dispatch('wave-1', w1, 'coder', T2);
    w1 = result('wave-1', w1, 'coder', T1, 40_000);
    result('wave-1', w1, 'coder', T2, 50_000);
    start('wave-2', epic);
  }

  describe('smith wave audit', () => {
    it('judges a wave the epic admitted and a wave session ran, from the epic session', () => {
      fanOut();
      const run = smith(['wave', 'audit', '--session', EPIC, '--epic', 'E1']);
      const summary = JSON.parse(run.stdout);
      expect(summary.waves, run.stdout).toHaveLength(1);
      expect(summary.waves[0].verdict).toBe('parallel');
      expect(summary.waves[0].peak).toBe(2);
      expect(summary.waves[0].observed.map((run: { taskId: string }) => run.taskId)).toEqual([
        T1,
        T2,
      ]);
      expect(summary.unobserved).toEqual([]);
      expect(run.status).toBe(0);
    });

    // The control. `wave-2` shares the admission and none of the work, so a
    // verb reading the lineage answers `unobserved` here and `parallel` above.
    // One answer from both sessions would mean the scope is the directory.
    it('reports the same wave as unobserved from a sibling wave session', () => {
      fanOut();
      const run = smith(['wave', 'audit', '--session', 'wave-2', '--epic', 'E1']);
      const summary = JSON.parse(run.stdout);
      expect(summary.unobserved, run.stdout).toEqual(['E1']);
      expect(summary.waves[0].verdict).toBe('unobserved');
      expect(run.status).toBe(2);
    });
  });

  describe('smith budget alarm', () => {
    it("counts a wave session's spend against the epic that admitted it", () => {
      fanOut();
      const run = smith(['budget', 'alarm', EPIC, '--epic', 'E1']);
      const report = JSON.parse(run.stdout);
      expect(report.epics, run.stdout).toHaveLength(1);
      expect(report.epics[0].measuredTokens).toBe(90_000);
      expect(report.epics[0].measuredTaskCount).toBe(2);
    });

    it('measures none of it from a sibling wave session', () => {
      fanOut();
      const run = smith(['budget', 'alarm', 'wave-2', '--epic', 'E1']);
      const report = JSON.parse(run.stdout);
      expect(report.epics[0].measuredTokens, run.stdout).toBe(0);
    });
  });

  describe('smith tester check', () => {
    // The pairing this verb exists to read is now split across two sessions by
    // construction: waves are what the tiers divide the work into, and a task
    // coded in one wave is retested in the next.
    /** The tester half of the pairing, written where the next wave runs it. */
    function retestInWave2(): void {
      let w2 = dispatch('wave-2', 'wave-2#0', 'tester', T1);
      w2 = result('wave-2', w2, 'tester', T1, 10_000);
      append(
        'wave-2',
        w2,
        'testgate-result',
        { pass: true, results: [{ name: 'unit', pass: true, exitCode: 0 }] },
        T1,
      );
    }

    it('pairs a coder in one wave session with a tester in the next', () => {
      fanOut();
      retestInWave2();
      const run = smith(['tester', 'check', EPIC, '--task', T1]);
      const report = JSON.parse(run.stdout);
      expect(report.checks[0].status, run.stdout).toBe('ok');
      expect(report.checks[0].workerEventId).toMatch(/^wave-1#/);
      expect(report.checks[0].auditorEventId).toMatch(/^wave-2#/);
      expect(run.status).toBe(0);
    });

    // The control, and the sharpest one here: from inside the wave that ran
    // the tester the coder's dispatch is in a sibling log, so the same gate
    // that verifies from the epic session is unverifiable from this one. A
    // session-scoped read is what the wave tier would have looked like.
    it('cannot verify the same gate from the wave that only ran the tester', () => {
      fanOut();
      retestInWave2();
      const run = smith(['tester', 'check', 'wave-2', '--task', T1]);
      const report = JSON.parse(run.stdout);
      expect(report.checks[0].status, run.stdout).toBe('unverifiable');
      expect(run.status).toBe(1);
    });
  });

  describe('smith judge outstanding', () => {
    /**
     * The turn is declared where the work happened: `wave-1#4` is the last
     * event `fanOut` wrote there, so the dispatch chains off the wave's own
     * log rather than the epic's.
     */
    function declareInWave1(): void {
      const declared = smith([
        'judge',
        'dispatch',
        '--task',
        T1,
        '--role',
        'reviewer',
        '--artifact',
        'review.json',
        '--model',
        'claude-opus-5',
        '--session',
        'wave-1',
        '--plan-version',
        '1',
        '--causal-parent',
        'wave-1#4',
      ]);
      expect(declared.status, declared.stderr).toBe(0);
    }

    it('is owed a turn a wave session declared', () => {
      fanOut();
      declareInWave1();
      const owed = smith(['judge', 'outstanding', '--session', EPIC, '--task', T1]);
      expect(owed.status, owed.stdout).toBe(1);
      expect(owed.stdout).toContain('reviewer');
    });

    // The other half, and the one that matters at the gate: an epic that can
    // see the turn owed but not the turn closed would block forever on work
    // that was done.
    it('is cleared from the epic once that wave reports', () => {
      fanOut();
      declareInWave1();
      const reported = smith([
        'judge',
        'report',
        '--task',
        T1,
        '--role',
        'reviewer',
        '--no-findings',
        '--session',
        'wave-1',
        '--plan-version',
        '1',
        '--causal-parent',
        'wave-1#5',
      ]);
      expect(reported.status, reported.stderr).toBe(0);

      const owed = smith(['judge', 'outstanding', '--session', EPIC, '--task', T1]);
      expect(JSON.parse(owed.stdout), owed.stdout).toEqual([]);
      expect(owed.status).toBe(0);
    });

    // The control. `recordJudgeReport` folds its own lineage to find the
    // dispatch it is closing, so a sibling wave cannot close a turn it never
    // took -- and the epic still holds it open afterwards. A directory-scoped
    // read would let any session clear any other session's judge.
    it('refuses a report from a sibling wave, which never saw the dispatch', () => {
      fanOut();
      declareInWave1();
      const reported = smith([
        'judge',
        'report',
        '--task',
        T1,
        '--role',
        'reviewer',
        '--no-findings',
        '--session',
        'wave-2',
        '--plan-version',
        '1',
        '--causal-parent',
        'wave-2#0',
      ]);
      expect(reported.status, reported.stdout).toBe(1);
      expect(JSON.parse(reported.stdout).error.code).toBe('judges.not-dispatched');

      const owed = smith(['judge', 'outstanding', '--session', EPIC, '--task', T1]);
      expect(owed.status, owed.stdout).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// The split itself. Everything above proves the topology WORKS; this proves
// the playbooks actually ask for it. D-191 in both directions: a verb in code
// named in no governing document reaches no agent, and a document that still
// carries the steps it handed away is a second copy, which is a copy that
// drifts.
// ---------------------------------------------------------------------------
describe('the two playbooks the topology above exists for (D13 step 2)', () => {
  const SKILLS_DIR = path.join(REPO_ROOT, '.claude', 'skills', 'bs');
  const skill = readFileSync(path.join(SKILLS_DIR, 'SKILL.md'), 'utf8');
  const wave = readFileSync(path.join(SKILLS_DIR, 'wave.md'), 'utf8');
  const head = skill.indexOf('## `/bs run');
  const runSection = skill.slice(head, skill.indexOf('\n## ', head + 1));

  /** The loop's own step numbers, as the ordered lists actually render them. */
  const stepsIn = (text: string): number[] =>
    [...text.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));

  it('routes from the epic tier to the wave playbook by name', () => {
    expect(runSection, 'the `/bs run` section was not found').not.toBe('');
    expect(runSection).toContain('wave.md');
  });

  it('leaves the epic tier owning step 1 and step 11 on, and nothing between', () => {
    const epic = stepsIn(runSection);
    expect(epic).toContain(1);
    expect(epic).toContain(11);
    expect(epic.filter((n) => n >= 2 && n <= 10)).toEqual([]);
  });

  it('gives the wave tier exactly the steps the epic tier stopped carrying', () => {
    expect(stepsIn(wave)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('names the flag both tiers depend on, in both tiers', () => {
    // Every claim proved above rests on `--continues`: a wave session opened
    // without it writes into a log no epic-level verb reads, and those verbs
    // then answer about a wave that appears never to have run.
    expect(wave).toContain('--continues');
    expect(runSection).toContain('--continues');
  });
});
