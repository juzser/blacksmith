import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchStore, runCli } from './helpers/cliHarness.js';

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

  // D-210. P9-28 just above closed the collapse for the session id: "you
  // forgot the argument", "no such session" and "the session is empty" used to
  // be one observable state, and it was the success one. `--n` reopened it
  // from the other side. The count went through a bare Number.parseInt and was
  // checked by nothing, so a typo did not fail -- it answered, wrongly, in
  // whichever direction the typo leaned.
  //
  // tailEvents ends in `all.slice(Math.max(0, all.length - n))`. That clamp
  // handles the one case it was written for -- asking for more than the log
  // holds -- and cannot see either case below, because both put the offset in
  // a range it reads as legitimate:
  //
  //   --n abc    NaN. `len - NaN` is NaN, `Math.max(0, NaN)` is NaN, and
  //              `slice(NaN)` is `slice(0)`: the WHOLE log, from the verb whose
  //              usage summary promises "the last n records".
  //   --n 0, -5  a LARGER offset, so the tail comes back empty -- precisely the
  //              "your log is empty" answer P9-28 exists to prevent, restored
  //              through a different typo on the same command.
  //   --n 1e2    1, not 100. `--n 0x10` is 0. `--n 10abc` is 10. parseInt stops
  //              at the first character it cannot use and returns the prefix,
  //              which is the trap `plan quorum --confidence` already documents
  //              for parseFloat -- the lesson was never carried to parseInt.
  //              These are not refused below: 1e2 and 0x10 are unambiguous
  //              numeric literals, and Number() reads them as the 100 and 16
  //              they say. The bug was the answer, not the notation.
  //
  // Of every flag usage.ts documents as a number, this was the only one with
  // nothing behind it. `--plan-version` is caught by the event schema
  // (`/plan_version must be integer`), `--round` by judges.invalid-round, and
  // `--input-tokens`/`--output-tokens` go through boundedIntFlag (#220: they
  // are optional and both-or-neither, unlike --n).
  describe('event tail --n is a count, not whatever parseInt salvages (D-210)', () => {
    function seedSession(sessionId: string, eventsDir: string, count: number): void {
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
      for (let i = 1; i < count; i += 1) {
        const next = runCli([
          'event',
          'append',
          JSON.stringify({
            session_id: sessionId,
            actor: 'user',
            event_type: 'operator-note',
            plan_version: 1,
            causal_parent: `${sessionId}#${i - 1}`,
            payload: { note: `event-${i}` },
          }),
          '--state-dir',
          eventsDir,
        ]);
        expect(next.status).toBe(0);
      }
    }

    it('refuses a --n it cannot read as a count, in either direction', () => {
      const sessionId = `cli-tail-n-bad-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'tail-n-bad-events');
      seedSession(sessionId, eventsDir, 3);

      // Each of these used to succeed with exit 0 and a wrong-length answer:
      // the first three printed the whole log, the next two printed nothing,
      // 3.9 truncated to 3 and 10abc to a 10 nobody typed.
      for (const bad of ['abc', '', 'Infinity', '0', '-5', '3.9', '10abc', ' ']) {
        const { stdout, status } = runCli([
          'event',
          'tail',
          sessionId,
          '--state-dir',
          eventsDir,
          '--n',
          bad,
        ]);
        expect(status, `--n ${JSON.stringify(bad)} must be refused`).toBe(1);
        const parsed = JSON.parse(stdout);
        expect(parsed.error.code).toBe('cli.invalid-flag');
        expect(parsed.error.message).toContain('--n');
      }
    });

    it('still tails exactly what a real count asks for, and clamps above the log', () => {
      const sessionId = `cli-tail-n-ok-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'tail-n-ok-events');
      seedSession(sessionId, eventsDir, 5);

      const two = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir, '--n', '2']);
      expect(two.status).toBe(0);
      expect(JSON.parse(two.stdout)).toHaveLength(2);

      // The clamp the fix must not break: more than the log holds is not an
      // error, it is the whole log.
      const many = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir, '--n', '500']);
      expect(many.status).toBe(0);
      expect(JSON.parse(many.stdout)).toHaveLength(5);

      // And the default is still 20, not something the validator now rejects.
      const bare = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir]);
      expect(bare.status).toBe(0);
      expect(JSON.parse(bare.stdout)).toHaveLength(5);

      // The two notations parseInt used to mangle now mean what they say: 1e2
      // is 100 and 0x10 is 16, so both clamp to the whole log rather than
      // coming back as the 1 and the 0 of their first character.
      for (const literal of ['1e2', '0x10']) {
        const read = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir, '--n', literal]);
        expect(read.status, `--n ${literal}`).toBe(0);
        expect(JSON.parse(read.stdout)).toHaveLength(5);
      }
    });

    it('ui serve --port names the flag instead of leaking a Node RangeError', () => {
      // `serve()` handed NaN to net.Server.listen, which threw
      // ERR_SOCKET_BAD_PORT. The CLI caught it, so the exit code was right, but
      // the operator got a stack trace with node_modules paths in it and no
      // `error.code` at all -- the one shape every other CLI error has.
      const { stdout, status } = runCli(['ui', 'serve', '--port', 'abc']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.invalid-flag');
      expect(parsed.error.message).toContain('--port');
      expect(JSON.stringify(parsed)).not.toContain('node_modules');
    });

    it('ui serve --now-iso refuses a value Date.parse cannot read, before the server is even loaded', () => {
      // The pin exists for the screenshot harness (ui/e2e/global-setup.ts):
      // a value that does not parse would reach every query as an Invalid
      // Date and silently mark every agent stalled on every page, which is
      // the one outcome a "fixed clock" must never produce. Refused at the
      // flag, like --port, so the error is the CLI's shape and not a 500.
      for (const bad of ['yesterday', '', '2026-13-45T99:99:99Z']) {
        const { stdout, status } = runCli(['ui', 'serve', '--now-iso', bad]);
        expect(status, `--now-iso ${JSON.stringify(bad)}`).toBe(1);
        const parsed = JSON.parse(stdout);
        expect(parsed.error.code).toBe('ui.invalid-now');
        expect(parsed.error.message).toContain('--now-iso');
        expect(parsed.error.details).toEqual({ flag: 'now-iso', value: bad });
        expect(JSON.stringify(parsed)).not.toContain('node_modules');
      }
    });
  });

  // D-210 named a class and fixed one member of it. Its own corollary says why
  // that is not enough: "a guard is scoped to the argument it names, not to the
  // command it sits in." Two integer flags still read their value through a
  // bare `Number.parseInt`, and D-210's survey of them -- "`--round` by
  // judges.invalid-round", "`--plan-version` ... caught by the event schema" --
  // only ever tried `abc`. NaN is the loud failure. The third outcome its rule
  // candidate names, "a confident wrong answer", was still live on both, and
  // that is the one no exit code reports. Against the built binary, before:
  //
  //   judge dispatch --round 1e2          exit 0, recorded round 1
  //   judge dispatch --round 2.7          exit 0, recorded round 2
  //   judge dispatch --round 10abc        exit 0, recorded round 10
  //   judge dispatch --plan-version 2.9   exit 0, envelope stamped plan 2
  //   judge dispatch --plan-version 9e9   exit 0, envelope stamped plan 9
  //   judge dispatch --plan-version ""    exit 0, envelope stamped plan 1
  //
  // `--plan-version` is the worse of the two. It is shared boilerplate on
  // twenty-odd verbs through eventContextFromFlags, and unlike --round the
  // number it salvages is written into the *persisted* envelope, where
  // plan-version fencing reads it back long after the typo is off the screen.
  // The empty case never even reached parseInt: `flags['plan-version'] ?` is a
  // truthiness test, so an explicitly empty value quietly became 1.
  describe('--round and --plan-version are counts, not parseInt salvage (D-210 class)', () => {
    /** A session log with only its root event: enough for an envelope to be legal. */
    function seedJudgeSession(label: string): { sessionId: string; eventsDir: string } {
      const sessionId = `cli-int-flag-${label}-${Date.now()}`;
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
      return { sessionId, eventsDir };
    }

    function dispatch(
      sessionId: string,
      eventsDir: string,
      rest: string[],
    ): { stdout: string; status: number | null } {
      return runCli([
        'judge',
        'dispatch',
        '--task',
        'epic-1/task-1',
        '--role',
        'reviewer',
        '--artifact',
        path.join(scratchDir, 'int-flag-review.json'),
        '--model',
        'claude-opus-5',
        ...rest,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
    }

    // The same list D-210 used on --n. Both flags are 1-based, so 0 and -5 are
    // out of range rather than unreadable, and both must be named all the same:
    // the operator's mistake is the flag either way.
    const UNREADABLE = ['abc', '', 'Infinity', '0', '-5', '3.9', '10abc', ' '];

    it('refuses a --round it cannot read as a round, and blames the flag', () => {
      const { sessionId, eventsDir } = seedJudgeSession('round');
      for (const bad of UNREADABLE) {
        const { stdout, status } = dispatch(sessionId, eventsDir, ['--round', bad]);
        expect(status, `--round ${JSON.stringify(bad)} must be refused`).toBe(1);
        const parsed = JSON.parse(stdout);
        // Not judges.invalid-round: that error reports the null its own
        // coercion produced, which points at the round instead of at the typo
        // that made it one.
        expect(parsed.error.code).toBe('cli.invalid-flag');
        // The operator's own text, echoed back: `got "3.9"`, not `got null`.
        expect(parsed.error.message).toContain(`got "${bad}"`);
      }
    });

    it('refuses the same --round on judge report, where a wrong one blames the round', () => {
      // `judge report --round abc` said "is on round 1, not round NaN" -- an
      // accusation aimed at the round rather than the flag. Same coercion, same
      // fix, and the verb is optional-round so the guard must not fire when the
      // flag is absent.
      const { sessionId, eventsDir } = seedJudgeSession('report');
      const { stdout, status } = runCli([
        'judge',
        'report',
        '--task',
        'epic-1/task-1',
        '--role',
        'reviewer',
        '--round',
        '2.7',
        '--no-findings',
        'true',
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.invalid-flag');
      expect(parsed.error.message).toContain('--round');
    });

    it('records the round the notation actually says', () => {
      // The half of D-210's choice that is not an error: 1e2 is an unambiguous
      // numeric literal for 100. The defect was answering with the 1 of its
      // first character, not the notation.
      const { sessionId, eventsDir } = seedJudgeSession('round-ok');
      const hundred = dispatch(sessionId, eventsDir, ['--round', '1e2']);
      expect(hundred.status).toBe(0);
      expect(JSON.parse(hundred.stdout).record.payload.round).toBe(100);

      // And the default survives: --round is optional and still means 1.
      const bare = dispatch(sessionId, eventsDir, []);
      expect(bare.status).toBe(0);
      expect(JSON.parse(bare.stdout).record.payload.round).toBe(1);
    });

    it('refuses a --plan-version it cannot read, instead of stamping one nobody typed', () => {
      const { sessionId, eventsDir } = seedJudgeSession('planver');
      for (const bad of UNREADABLE) {
        const { stdout, status } = dispatch(sessionId, eventsDir, ['--plan-version', bad]);
        expect(status, `--plan-version ${JSON.stringify(bad)} must be refused`).toBe(1);
        const parsed = JSON.parse(stdout);
        // Not events.invalid-record. The schema catches `abc` a layer later and
        // blames the record for a malformed field -- right outcome, wrong
        // culprit -- and it catches none of 2.9, 9e9, 3x or "" at all, because
        // by then they are the perfectly valid integers parseInt salvaged.
        expect(parsed.error.code).toBe('cli.invalid-flag');
        expect(parsed.error.message).toContain('--plan-version');
      }
    });

    it('still stamps the plan version it was given, and still defaults to 1', () => {
      const { sessionId, eventsDir } = seedJudgeSession('planver-ok');
      const three = dispatch(sessionId, eventsDir, ['--plan-version', '3']);
      expect(three.status).toBe(0);
      expect(JSON.parse(three.stdout).record.plan_version).toBe(3);

      const bare = dispatch(sessionId, eventsDir, []);
      expect(bare.status).toBe(0);
      expect(JSON.parse(bare.stdout).record.plan_version).toBe(1);
    });
  });

  it('event append + tail round-trips through a --state-dir override (never touches the real state/events dir)', () => {
    const sessionId = `cli-smoke-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'events');
    const appendResult = runCli([
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
    expect(appendResult.status).toBe(0);
    expect(JSON.parse(appendResult.stdout).event_id).toBe(`${sessionId}#0`);

    const tailResult = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir]);
    expect(tailResult.status).toBe(0);
    const events = JSON.parse(tailResult.stdout);
    expect(events).toHaveLength(1);
  });

  // D-163. `event_type` is an open free string at write time on purpose
  // (event.schema.json: a closed list here "would reject a new event type at
  // write time and lose the record"), and a closed allow-list at read time —
  // timeline() filters on timelineEventTypes(). A type outside that list is
  // therefore accepted, receipted as success, projected into the db by `db
  // rebuild`, and invisible on the only screen the operator has, under every
  // filter. The receipt now says which side of that line the record landed on,
  // at the one moment someone is looking.
  it('event append: the receipt says whether the type reaches the operator timeline (D-163)', () => {
    const sessionId = `cli-offtimeline-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'off-timeline-events');
    const append = (eventType: string, causalParent: string | null) =>
      runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          actor: 'operator',
          event_type: eventType,
          plan_version: 1,
          causal_parent: causalParent,
          payload: {},
        }),
        '--state-dir',
        eventsDir,
      ]);

    const start = append('session-start', null);
    expect(start.status).toBe(0);
    expect(JSON.parse(start.stdout).on_timeline).toBe(true);
    expect(start.stderr).not.toContain('operator timeline');

    // `operator-decision` is one of the nineteen types this factory's own
    // operator skill improvised through this command; not one of them is on
    // the read list, and 25 records went missing without a word.
    const off = append('operator-decision', `${sessionId}#0`);
    // The write succeeded. This is a receipt, not a rejection: refusing the
    // record is the outcome the open write side exists to prevent.
    expect(off.status).toBe(0);
    const receipt = JSON.parse(off.stdout);
    expect(receipt.event_id).toBe(`${sessionId}#1`);
    expect(receipt.on_timeline).toBe(false);
    expect(off.stderr).toContain('operator-decision');
    expect(off.stderr).toContain('operator timeline');
  });

  // D-245. The task id belongs on the envelope, beside `session_id`; a copy in
  // the payload is what SKILL.md's silence produced instead, 29 times across
  // two dogfood sessions. The readers now take it from either place, but only
  // the envelope field is indexed — so the receipt says which one the writer
  // used, at the one moment someone is looking.
  it('event append: warns when only the payload names the task (D-245)', () => {
    const sessionId = `cli-payload-task-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'payload-task-events');
    const append = (input: Record<string, unknown>, causalParent: string | null) =>
      runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          actor: 'operator',
          plan_version: 1,
          causal_parent: causalParent,
          ...input,
        }),
        '--state-dir',
        eventsDir,
      ]);

    const start = append({ event_type: 'session-start', payload: {} }, null);
    expect(start.status).toBe(0);

    const onEnvelope = append(
      {
        event_type: 'dispatch_decision',
        task_id: 'epic-1/task-1',
        payload: {
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
        },
      },
      `${sessionId}#0`,
    );
    expect(onEnvelope.status).toBe(0);
    expect(onEnvelope.stderr).not.toContain('task_id');

    // Both levels, agreeing: the envelope is the one that counts and it is
    // filled, so there is nothing to tell the writer.
    const bothLevels = append(
      {
        event_type: 'dispatch_decision',
        task_id: 'epic-1/task-1',
        payload: {
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
          task_id: 'epic-1/task-1',
        },
      },
      `${sessionId}#1`,
    );
    expect(bothLevels.status).toBe(0);
    expect(bothLevels.stderr).toBe('');

    const payloadOnly = append(
      {
        event_type: 'dispatch_decision',
        payload: {
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
          task_id: 'epic-1/task-2',
        },
      },
      `${sessionId}#2`,
    );
    // The write succeeded — this is a receipt, not a rejection, for the same
    // reason D-163's is.
    expect(payloadOnly.status).toBe(0);
    expect(JSON.parse(payloadOnly.stdout).event_id).toBe(`${sessionId}#3`);
    expect(payloadOnly.stderr).toContain('epic-1/task-2');
    expect(payloadOnly.stderr).toContain('task_id');
  });

  // ---------------------------------------------------------------------------
  // The first hop had no verb. Every write command needs `--session` and
  // `--causal-parent`, and the event those two point at could only be produced
  // by hand-writing the root envelope through `event append` — which is what
  // the operator guide, SKILL.md and agent-constraints.md all told you to do,
  // in JSON, on one line, quoted for a shell. `smith session start` is that
  // envelope as a command, and unlike the writer underneath it, it is allowed
  // to refuse.
  // ---------------------------------------------------------------------------
  describe('session start: opening a log is a command (D-261)', () => {
    it('writes the root nothing else could write, and prints the id everything chains off', () => {
      const sessionId = `cli-session-start-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'session-start-events');

      const started = runCli(['session', 'start', sessionId, '--state-dir', eventsDir]);
      expect(started.status).toBe(0);
      const receipt = JSON.parse(started.stdout);
      expect(receipt.event_id).toBe(`${sessionId}#0`);
      expect(receipt.record.event_type).toBe('session-start');
      expect(receipt.record.causal_parent).toBeNull();
      expect(receipt.record.actor).toBe('operator');

      // The id it printed is a usable `--causal-parent`, which is the only
      // reason the receipt exists.
      const recorded = runCli(
        [
          'prompt',
          'record',
          '-',
          '--session',
          sessionId,
          '--causal-parent',
          receipt.event_id,
          '--state-dir',
          eventsDir,
        ],
        undefined,
        'the first thing the operator said',
      );
      expect(recorded.status).toBe(0);
      expect(JSON.parse(recorded.stdout).record.causal_parent).toBe(receipt.event_id);
    });

    it('refuses a session that is already open, and names the anchor instead', () => {
      const sessionId = `cli-session-twice-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'session-twice-events');

      expect(runCli(['session', 'start', sessionId, '--state-dir', eventsDir]).status).toBe(0);

      const again = runCli(['session', 'start', sessionId, '--state-dir', eventsDir]);
      expect(again.status).toBe(1);
      const error = JSON.parse(again.stdout).error;
      expect(error.code).toBe('events.session-already-started');
      expect(error.message).toContain(`${sessionId}#0`);

      // Refused, not appended: the log still holds the one root.
      const tail = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir]);
      expect(JSON.parse(tail.stdout)).toHaveLength(1);
    });

    // A write from inside a Claude Code session logs which CLI session made
    // it; the same write from a plain shell logs no such key. The plain run
    // inherits this worker's env, so it also proves test/setup.ts scrubbed
    // the runner's own CLAUDE_CODE_SESSION_ID before any child saw it.
    it('stamps cli_session_id from CLAUDE_CODE_SESSION_ID, and only when it is set', async () => {
      const cliId = '0f3c9a52-6b1e-4d7a-9c2f-5e8d1a2b3c4d';
      const inside = `cli-stamp-inside-${Date.now()}`;
      const outside = `cli-stamp-outside-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'session-cli-stamp-events');
      const linesOf = async (sessionId: string) =>
        (await readFile(path.join(eventsDir, `${sessionId}.jsonl`), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);

      const env = { CLAUDE_CODE_SESSION_ID: cliId };
      const started = runCli(['session', 'start', inside, '--state-dir', eventsDir], env);
      expect(started.status).toBe(0);
      expect(JSON.parse(started.stdout).record.cli_session_id).toBe(cliId);
      const recorded = runCli(
        [
          'prompt',
          'record',
          '-',
          '--session',
          inside,
          '--causal-parent',
          `${inside}#0`,
          '--state-dir',
          eventsDir,
        ],
        env,
        'a prompt typed inside the CLI session',
      );
      expect(recorded.status).toBe(0);
      expect((await linesOf(inside)).map((line) => line.cli_session_id)).toEqual([cliId, cliId]);

      expect(runCli(['session', 'start', outside, '--state-dir', eventsDir]).status).toBe(0);
      const [plain] = await linesOf(outside);
      expect(plain).not.toHaveProperty('cli_session_id');

      // A malformed value never breaks the write; it is simply not recorded.
      const odd = `cli-stamp-odd-${Date.now()}`;
      const malformed = runCli(['session', 'start', odd, '--state-dir', eventsDir], {
        CLAUDE_CODE_SESSION_ID: 'not a session id',
      });
      expect(malformed.status).toBe(0);
      expect((await linesOf(odd))[0]).not.toHaveProperty('cli_session_id');
    });

    it('continues another session in one flag (§5b)', () => {
      const first = `cli-session-a-${Date.now()}`;
      const second = `cli-session-b-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'session-continue-events');

      expect(runCli(['session', 'start', first, '--state-dir', eventsDir]).status).toBe(0);
      const continued = runCli([
        'session',
        'start',
        second,
        '--continues',
        `${first}#0`,
        '--actor',
        'operator-skill',
        '--state-dir',
        eventsDir,
      ]);
      expect(continued.status).toBe(0);
      expect(JSON.parse(continued.stdout).record.causal_parent).toBe(`${first}#0`);
      expect(JSON.parse(continued.stdout).record.actor).toBe('operator-skill');

      const lineage = runCli(['event', 'lineage', second, '--state-dir', eventsDir]);
      expect(JSON.parse(lineage.stdout).lineage).toEqual([first, second]);
    });

    // The other half of the same defect, on the side that has to stay open.
    // `event append` cannot refuse a second root — refusing a record is what
    // its openness exists to prevent — so it says so, in the same shape as
    // D-163's and D-245's receipts, and still exits 0.
    it('event append: warns when a session-start is not the first event in its log', () => {
      const sessionId = `cli-second-root-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'second-root-events');
      const root = () =>
        runCli([
          'event',
          'append',
          JSON.stringify({
            session_id: sessionId,
            actor: 'operator',
            event_type: 'session-start',
            plan_version: 1,
            causal_parent: null,
            payload: {},
          }),
          '--state-dir',
          eventsDir,
        ]);

      const first = root();
      expect(first.status).toBe(0);
      expect(first.stderr).toBe('');

      const second = root();
      // The write succeeded and is durable. This is a receipt, not a rejection.
      expect(second.status).toBe(0);
      expect(JSON.parse(second.stdout).event_id).toBe(`${sessionId}#1`);
      expect(second.stderr).toContain('session-start');
      expect(second.stderr).toContain('bs session start');
    });
  });

  describe('session start --prompt: the root names the prompt that asked for it', () => {
    const stamp = Date.now();
    const promptIn = (eventsDir: string, session: string): string => {
      expect(runCli(['session', 'start', session, '--state-dir', eventsDir]).status).toBe(0);
      const recorded = runCli(
        [
          'prompt',
          'record',
          '-',
          '--session',
          session,
          '--causal-parent',
          `${session}#0`,
          '--state-dir',
          eventsDir,
        ],
        undefined,
        'run alpha-1',
      );
      expect(recorded.status).toBe(0);
      return JSON.parse(recorded.stdout).event_id as string;
    };

    it('writes payload.parent_prompt_id and leaves causal_parent alone', () => {
      const eventsDir = path.join(scratchDir, 'sp-events-1');
      const promptId = promptIn(eventsDir, `sp-home-${stamp}`);
      const started = runCli([
        'session',
        'start',
        `sp-epic-${stamp}`,
        '--prompt',
        promptId,
        '--state-dir',
        eventsDir,
      ]);
      expect(started.status).toBe(0);
      const { record } = JSON.parse(started.stdout);
      expect(record.payload.parent_prompt_id).toBe(promptId);
      expect(record.causal_parent).toBeNull();
    });

    it('composes with --continues', () => {
      const eventsDir = path.join(scratchDir, 'sp-events-2');
      const promptId = promptIn(eventsDir, `sp-home2-${stamp}`);
      expect(
        runCli(['session', 'start', `sp-first-${stamp}`, '--state-dir', eventsDir]).status,
      ).toBe(0);
      const started = runCli([
        'session',
        'start',
        `sp-next-${stamp}`,
        '--continues',
        `sp-first-${stamp}#0`,
        '--prompt',
        promptId,
        '--state-dir',
        eventsDir,
      ]);
      expect(started.status).toBe(0);
      const { record } = JSON.parse(started.stdout);
      expect(record.causal_parent).toBe(`sp-first-${stamp}#0`);
      expect(record.payload.parent_prompt_id).toBe(promptId);
    });

    it('refuses an id that does not exist', () => {
      const eventsDir = path.join(scratchDir, 'sp-events-3');
      const promptId = promptIn(eventsDir, `sp-home3-${stamp}`);
      const missing = promptId.replace(/#\d+$/, '#99');
      const refused = runCli([
        'session',
        'start',
        `sp-bad-${stamp}`,
        '--prompt',
        missing,
        '--state-dir',
        eventsDir,
      ]);
      expect(refused.status).toBe(1);
      expect(JSON.parse(refused.stdout).error.code).toBe('events.unknown-causal-parent');
      const nowhere = runCli([
        'session',
        'start',
        `sp-bad2-${stamp}`,
        '--prompt',
        'sp-nowhere#0',
        '--state-dir',
        eventsDir,
      ]);
      expect(nowhere.status).toBe(1);
      expect(JSON.parse(nowhere.stdout).error.code).toBe('events.unknown-causal-session');
      expect(existsSync(path.join(eventsDir, `sp-bad-${stamp}.jsonl`))).toBe(false);
    });

    it('refuses an id whose event is not a user_prompt', () => {
      const eventsDir = path.join(scratchDir, 'sp-events-4');
      const promptId = promptIn(eventsDir, `sp-home4-${stamp}`);
      const root = promptId.replace(/#\d+$/, '#0');
      const refused = runCli([
        'session',
        'start',
        `sp-bad3-${stamp}`,
        '--prompt',
        root,
        '--state-dir',
        eventsDir,
      ]);
      expect(refused.status).toBe(1);
      expect(JSON.parse(refused.stdout).error.code).toBe('events.not-a-user-prompt');
    });
  });

  // ---------------------------------------------------------------------------
  // D-263. `session start --continues` made an epic able to outlast the window
  // that opened it, and the operator console then recommended splitting one
  // that way. Every `stats` page still narrowed on a single session id, so the
  // continuation session asking about its own epic was answered with the part
  // of it that happened to fall inside that window -- and told nothing about
  // the rest. `--lineage` is the scope that follows the epic instead.
  // ---------------------------------------------------------------------------
  describe('stats --lineage: an epic outlives the session that opened it (D-263)', () => {
    const taskEvent = (session: string, taskId: string): string =>
      JSON.stringify({
        session_id: session,
        actor: 'planner',
        event_type: 'task-added',
        task_id: taskId,
        plan_version: 1,
        causal_parent: `${session}#0`,
        payload: {
          epic_id: 'epic-lin',
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          plan_version: 1,
          objective: `Do ${taskId}.`,
          claims: [`src/${taskId.replace('/', '-')}.ts`],
          budget_tokens: 1000,
        },
      });

    it('reads the whole epic where --session alone reads one window of it', () => {
      const stamp = Date.now();
      const first = `cli-lineage-a-${stamp}`;
      const second = `cli-lineage-b-${stamp}`;
      const eventsDir = path.join(scratchDir, 'lineage-events');
      const dbPath = path.join(scratchDir, `lineage-${stamp}.db`);

      expect(runCli(['session', 'start', first, '--state-dir', eventsDir]).status).toBe(0);
      expect(
        runCli(['event', 'append', taskEvent(first, 'epic-lin/task-1'), '--state-dir', eventsDir])
          .status,
      ).toBe(0);
      expect(
        runCli(['session', 'start', second, '--continues', `${first}#0`, '--state-dir', eventsDir])
          .status,
      ).toBe(0);
      expect(
        runCli(['event', 'append', taskEvent(second, 'epic-lin/task-2'), '--state-dir', eventsDir])
          .status,
      ).toBe(0);

      expect(runCli(['db', 'rebuild', '--db', dbPath, '--state-dir', eventsDir]).status).toBe(0);

      const taskIdsOf = (stdout: string): string[] =>
        (JSON.parse(stdout) as { tasks: { taskId: string }[] }[])
          .flatMap((column) => column.tasks)
          .map((t) => t.taskId)
          .sort();

      const narrow = runCli([
        'stats',
        'kanban',
        '--db',
        dbPath,
        '--epic',
        'epic-lin',
        '--session',
        second,
      ]);
      expect(narrow.status).toBe(0);
      expect(taskIdsOf(narrow.stdout)).toEqual(['epic-lin/task-2']);

      const wide = runCli([
        'stats',
        'kanban',
        '--db',
        dbPath,
        '--epic',
        'epic-lin',
        '--session',
        second,
        '--lineage',
      ]);
      expect(wide.status).toBe(0);
      expect(taskIdsOf(wide.stdout)).toEqual(['epic-lin/task-1', 'epic-lin/task-2']);
    });

    it('refuses --lineage with no session to widen', () => {
      const stamp = Date.now();
      const eventsDir = path.join(scratchDir, 'lineage-alone-events');
      const dbPath = path.join(scratchDir, `lineage-alone-${stamp}.db`);
      expect(
        runCli(['session', 'start', `cli-lineage-c-${stamp}`, '--state-dir', eventsDir]).status,
      ).toBe(0);
      expect(runCli(['db', 'rebuild', '--db', dbPath, '--state-dir', eventsDir]).status).toBe(0);

      // Not a silent no-op: without --session there is nothing to widen, and
      // answering with every session at once would be a different question.
      const orphan = runCli(['stats', 'overview', '--db', dbPath, '--lineage']);
      expect(orphan.status).toBe(1);
      expect(JSON.parse(orphan.stdout).error.code).toBe('cli.missing-flag');
    });
  });

  // D-131/D-132, driven through the binary because that is where they were
  // found: the unit tests in args.test.ts prove the parser, and these prove
  // the parser is the one the CLI actually runs.
  describe('flag parsing (D-131/D-132)', () => {
    const sessionId = `cli-flagform-${Date.now()}`;
    let eventsDir: string;

    beforeAll(() => {
      eventsDir = path.join(scratchDir, 'flag-form-events');
      const appended = runCli([
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
      expect(appended.status).toBe(0);
    });

    it('honours the =-joined form of a flag that has a default', () => {
      // The dangerous half of D-131. `--state-dir=<dir>` used to parse as a
      // flag named `state-dir=<dir>`, `flags['state-dir']` stayed undefined,
      // and `event tail` read the real state/events dir instead — which for a
      // flag with a default means exit 0 and an answer about the wrong data.
      const { stdout, status } = runCli(['event', 'tail', sessionId, `--state-dir=${eventsDir}`]);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toHaveLength(1);
    });

    it('refuses a flag the command does not declare instead of ignoring it', () => {
      const { stdout, status } = runCli([
        'event',
        'tail',
        sessionId,
        '--state-dir',
        eventsDir,
        '--totally-bogus-flag',
        'xyz',
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.unknown-flag');
      expect(parsed.error.message).toContain('totally-bogus-flag');
    });

    it('names the usage line it checked the flag against', () => {
      // A rejection that does not say what WAS allowed just moves the guessing
      // one step along — which is how D-139's four missing flags were found.
      const { stdout } = runCli(['event', 'tail', sessionId, '--lineag']);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.details.usage).toContain('bs event tail');
      expect(parsed.error.details.usage).toContain('--lineage');
    });

    it('still prints help for a command carrying a bad flag', () => {
      const { status, stdout } = runCli(['event', 'tail', '--help', '--nonsense']);
      expect(status).toBe(0);
      expect(stdout).toContain('bs event tail');
    });

    // The same defect as D-131, one step further along: there the value was
    // mis-parsed, here it is absent and invented. `--task` documents
    // `<task-id>`, so a bare one filtered the session down to a task called
    // "true" and printed `[]` -- exit 0, well-formed JSON, and an empty list
    // that reads as "this task did nothing" rather than "you lost the id".
    it('refuses a documented value-taking flag whose value went missing', () => {
      const { stdout, status } = runCli([
        'event',
        'tail',
        sessionId,
        '--state-dir',
        eventsDir,
        '--task',
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-flag-value');
      expect(parsed.error.message).toContain('--task');
      expect(parsed.error.details.usage).toContain('bs event tail');
      expect(parsed.error.details.usage).toContain('--task <task-id>');
    });

    it('still reads a flag that takes nothing, and one whose value is there', () => {
      // The guard must not cost the two shapes that were always correct.
      const { status } = runCli([
        'event',
        'tail',
        sessionId,
        '--state-dir',
        eventsDir,
        '--lineage',
      ]);
      expect(status).toBe(0);
      const named = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir, '--task', 't-1']);
      expect(named.status).toBe(0);
      expect(JSON.parse(named.stdout)).toEqual([]);
    });

    it('still prints help for a command carrying a flag that lost its value', () => {
      // Help is asked for by people who do not yet know the shape, so it has
      // to survive the command line that made them ask.
      const { status, stdout } = runCli(['event', 'tail', '--help', '--task']);
      expect(status).toBe(0);
      expect(stdout).toContain('bs event tail');
    });

    // D-139 itself: the documented invocation must not fail on a flag the
    // usage line never mentioned.
    it('documents every flag epic spec-review requires', () => {
      const { stdout, status } = runCli(['epic', 'spec-review', '--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('--reviewed-by');
      expect(stdout).toContain('--no-findings');
    });
  });

  // D-209. Three flags are documented `<iso>` -- `scheduler run --now`,
  // `dream --since` and `stats providers --since` -- and not one of them read
  // the string it was handed. usage.ts says the flag column is "Documentation
  // only -- never parsed", and nothing downstream made up the difference: each
  // fed the value straight to a Date or to a SQL comparison and let the
  // resulting NaN decide the outcome, in a different direction each time.
  describe('ISO date flags (D-209)', () => {
    function appendRoot(sessionId: string, eventsDir: string): void {
      const result = runCli([
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
      expect(result.status).toBe(0);
    }

    it('scheduler run --now refuses what it cannot read as an ISO instant', () => {
      const sessionId = `cli-now-bad-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'now-bad-events');
      appendRoot(sessionId, eventsDir);

      // `now` and `tomorrow` are the words an operator reaches for, and
      // 2026-13-45 is a typo in the right shape. All three are Invalid Date,
      // and the NaN behind it disarms one gate while permanently arming the
      // other: `NaN >= daysElapsed` is false, so a recheck never gets its
      // `time-elapsed` reason, and `NaN < cadenceDays` is false too, so the
      // growth review fires on every run regardless of cadence.
      //
      // 01/10/2026 and `Oct 1 2026` are worse than an Invalid Date, because
      // they are not invalid: V8 accepts both, reading the first as a US
      // M/D/Y date. A dd/mm/yyyy operator gets January 10 -- a silently wrong
      // instant seven months from the one they asked for, and no error at all.
      for (const bad of ['now', 'tomorrow', '2026-13-45', '01/10/2026', 'Oct 1 2026']) {
        const { stdout, status } = runCli([
          'scheduler',
          'run',
          '--session',
          sessionId,
          '--dry',
          'true',
          '--now',
          bad,
          '--state-dir',
          eventsDir,
        ]);
        expect(status, `--now ${bad} must be refused`).toBe(1);
        const error = JSON.parse(stdout).error;
        expect(error.code).toBe('cli.invalid-flag');
        expect(error.message).toContain('now');
      }
    });

    it('scheduler run --now still moves the clock a valid ISO instant asks it to', () => {
      const sessionId = `cli-now-good-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'now-good-events');
      appendRoot(sessionId, eventsDir);

      const added = runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          actor: 'system',
          event_type: 'task-added',
          task_id: 'd209/t1',
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: { task_status: 'completed', origin: 'user', claims: ['src/a/**'] },
        }),
        '--state-dir',
        eventsDir,
      ]);
      expect(added.status).toBe(0);

      // The task completed just now, so only a future --now can trip the
      // 14-day recheck threshold. That is what the flag is for, and it is the
      // behaviour a validator must not cost us.
      const future = new Date(Date.now() + 42 * 24 * 60 * 60 * 1000).toISOString();
      const shifted = runCli([
        'scheduler',
        'run',
        '--session',
        sessionId,
        '--dry',
        'true',
        '--now',
        future,
        '--state-dir',
        eventsDir,
      ]);
      expect(shifted.status).toBe(0);
      const proposal = JSON.parse(shifted.stdout).proposals.find(
        (p: { kind: string }) => p.kind === 'recheck',
      );
      expect(proposal.reasons).toContain('time-elapsed');
      // Not null. Math.floor(NaN) serialises to null, and this object IS the
      // event payload runScheduler persists -- event.schema.json leaves
      // `payload` unconstrained, so a null day count outlives the typo that
      // produced it in an append-only log.
      expect(typeof proposal.daysElapsed).toBe('number');
      expect(proposal.daysElapsed).toBeGreaterThanOrEqual(41);

      // Same log, real clock: the threshold is not met and nothing is due.
      const unshifted = runCli([
        'scheduler',
        'run',
        '--session',
        sessionId,
        '--dry',
        'true',
        '--state-dir',
        eventsDir,
      ]);
      expect(unshifted.status).toBe(0);
      const now = JSON.parse(unshifted.stdout).proposals.find(
        (p: { kind: string }) => p.kind === 'recheck',
      );
      expect(now).toBeUndefined();
    });

    it('dream --since and stats providers --since are held to the same form', () => {
      const sessionId = `cli-since-bad-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'since-bad-events');
      appendRoot(sessionId, eventsDir);

      // Fails OPEN: extractDecisionCheckpoints skips an event when
      // `Date.parse(ts) < sinceMs`, and every comparison against NaN is false,
      // so a typo silently distils the whole log instead of the window asked
      // for.
      const dreamt = runCli([
        'dream',
        '--session',
        sessionId,
        '--since',
        'yesterday',
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(dreamt.status).toBe(1);
      expect(JSON.parse(dreamt.stdout).error.code).toBe('cli.invalid-flag');

      // Fails CLOSED, and for a different reason: providerAgreement compares
      // `ts >= since` in SQL, lexically. Every stored ts starts with a digit,
      // so any word sorts above all of them and the result is always empty.
      const stats = runCli([
        'stats',
        'providers',
        '--db',
        path.join(scratchDir, `${sessionId}.db`),
        '--since',
        'yesterday',
      ]);
      expect(stats.status).toBe(1);
      expect(JSON.parse(stats.stdout).error.code).toBe('cli.invalid-flag');
    });
  });

  it('dream + lessons candidates/compile: end-to-end through a gate block', () => {
    const sessionId = `cli-dream-${Date.now()}`;
    const eventsDir = path.join(scratchDir, 'dream-events');
    const dbPath = path.join(scratchDir, `${sessionId}.db`);
    const lessonsOut = path.join(scratchDir, `${sessionId}-lessons.md`);

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

    const blocked = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'system',
        event_type: 'gate-outcome',
        task_id: 'epic-1/task-1',
        plan_version: 1,
        causal_parent: rootId,
        payload: { outcome: 'blocked', reason: 'tests-failed' },
      }),
      '--state-dir',
      eventsDir,
    ]);
    const blockedId = JSON.parse(blocked.stdout).event_id as string;

    const dreamResult = runCli([
      'dream',
      '--session',
      sessionId,
      '--plan-version',
      '1',
      '--causal-parent',
      blockedId,
      '--state-dir',
      eventsDir,
    ]);
    expect(dreamResult.status).toBe(0);
    const dreamJson = JSON.parse(dreamResult.stdout);
    expect(dreamJson.checkpointsExtracted).toBe(1);
    expect(dreamJson.raised).toHaveLength(1);
    const lessonId = dreamJson.raised[0] as string;

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

    // `--state-dir` alongside `--db`/`--session` here (not just accepted, but
    // load-bearing): `candidates` validates `--session` against the event log
    // at this path the same way `raise`/`approve`/`reject`/`db rebuild` do
    // (P9-28) — the negative case (a typoed session) is its own test below.
    const candidatesResult = runCli([
      'lessons',
      'candidates',
      '--db',
      dbPath,
      '--session',
      sessionId,
      '--state-dir',
      eventsDir,
    ]);
    expect(candidatesResult.status).toBe(0);
    const candidates = JSON.parse(candidatesResult.stdout);
    expect(candidates.map((c: { lessonId: string }) => c.lessonId)).toEqual([lessonId]);

    // Approve it with the operator's own verb (P9-1) — the one door for a
    // lesson decision now that the dashboard only reads.
    const approveResult = runCli([
      'lessons',
      'approve',
      lessonId,
      '--session',
      sessionId,
      '--plan-version',
      '1',
      '--causal-parent',
      blockedId,
      '--actor',
      'operator',
      '--note',
      'Real rule, keeping it.',
      '--state-dir',
      eventsDir,
    ]);
    expect(approveResult.status).toBe(0);
    expect(JSON.parse(approveResult.stdout)).toMatchObject({
      lessonId,
      lessonStatus: 'approved',
    });

    runCli(['db', 'rebuild', '--db', dbPath, '--session', sessionId, '--state-dir', eventsDir]);

    const compileResult = runCli([
      'lessons',
      'compile',
      '--db',
      dbPath,
      '--session',
      sessionId,
      '--out',
      lessonsOut,
    ]);
    expect(compileResult.status).toBe(0);
    expect(JSON.parse(compileResult.stdout)).toEqual({
      outPath: lessonsOut,
      lessonsCompiled: 1,
      lessonsPreserved: 0,
    });
    expect(readFileSync(lessonsOut, 'utf8')).toContain(lessonId);

    // A hand-authored entry with no store row, sitting in the output file
    // before `compile` runs again — the shape a real lessons.md carries today
    // (~24 such entries, predating the store). Recompiling must not delete
    // it: this is the CLI-level proof for the insertions-only guarantee
    // unit-tested in lessons.test.ts's `compileLessons` suite. A separate
    // output path keeps this from perturbing the dispatch/audit assertions
    // below, which read the plain (no hand entry) `lessonsOut`.
    const lessonsOutPreserve = path.join(scratchDir, `${sessionId}-lessons-preserve.md`);
    const handLessonId = 'lesson-hand-e2e-001';
    writeFileSync(
      lessonsOutPreserve,
      [
        '# Compiled Lessons',
        '',
        '## agent-role',
        '',
        '_(none yet)_',
        '',
        '## claim-path',
        '',
        `### ${handLessonId}: Never hand-edit a lockfile in a worker`,
        '',
        `- lesson_id: ${handLessonId}`,
        '- finding_category: maintainability',
        '- claim_path: **/pnpm-lock.yaml',
        '- statement: Lockfiles are regenerable and regenerated by the merge queue;',
        '  a worker editing one directly is always a mistake, not a judgment call.',
        '',
        '## case-type',
        '',
        '_(none yet)_',
        '',
        '## stack-wide',
        '',
        '_(none yet)_',
        '',
        '## security',
        '',
        '_(none yet)_',
        '',
      ].join('\n'),
      'utf8',
    );
    const compilePreserveResult = runCli([
      'lessons',
      'compile',
      '--db',
      dbPath,
      '--session',
      sessionId,
      '--out',
      lessonsOutPreserve,
    ]);
    expect(compilePreserveResult.status).toBe(0);
    // lessonsCompiled counts DB-approved rows compiled, not entries in the
    // output file; lessonsPreserved is the hand entry that has no store row
    // and so survives verbatim instead.
    expect(JSON.parse(compilePreserveResult.stdout)).toEqual({
      outPath: lessonsOutPreserve,
      lessonsCompiled: 1,
      lessonsPreserved: 1,
    });
    const preservedMarkdown = readFileSync(lessonsOutPreserve, 'utf8');
    expect(preservedMarkdown).toContain(lessonId);
    expect(preservedMarkdown).toContain(handLessonId);

    // ...and out the far end: the approved, compiled lesson reaches a prompt
    // (P9-2). A gate-block checkpoint compiles as `stack-wide`, which the
    // scribe template declares, so this closes candidate -> approve ->
    // compile -> dispatch in one run.
    const dispatchResult = runCli([
      'lessons',
      'for-dispatch',
      'scribe',
      '--full',
      '--state-dir',
      dispatchStore(scratchDir, 'dispatch-store-dream', 'other.unclassified'),
      '--lessons',
      lessonsOut,
    ]);
    expect(dispatchResult.status).toBe(0);
    const dispatch = JSON.parse(dispatchResult.stdout);
    expect(dispatch.role).toBe('scribe');
    expect(dispatch.scopes).toContain('stack-wide');
    expect(dispatch.lessons.map((l: { lessonId: string }) => l.lessonId)).toContain(lessonId);
    expect(dispatch.text).toContain(lessonId);

    // ...and the verb that reads it back, on the corpus the factory's own loop
    // just produced. The reading is `dispatch-only`, and that is not a stub:
    // a gate-block checkpoint compiles with no `finding_category`, so the
    // lesson this whole pipeline just minted reaches the scribe's prompt and
    // is invisible to the escalation match — `reach.withoutCategory` names
    // exactly why. Being unmeasurable here is not evidence against it, so the
    // recommendation is `no-evidence` and never `retire`.
    //
    // Exit 1 because `unverifiable` is the honest verdict on a log holding no
    // gate decision at all: nothing here could have shown the lesson working.
    const auditResult = runCli([
      'lessons',
      'audit',
      sessionId,
      '--lessons',
      lessonsOut,
      '--state-dir',
      eventsDir,
    ]);
    expect(auditResult.status).toBe(1);
    const audit = JSON.parse(auditResult.stdout);
    expect(audit.status).toBe('unverifiable');
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      lessonId,
      escalates: false,
      liveness: 'dispatch-only',
      recommendation: 'no-evidence',
      firings: 0,
      opportunities: 0,
    });
    expect(audit.reach).toMatchObject({ total: 1, escalating: 0, withoutCategory: 1 });
    expect(audit.counts.retire).toBe(0);
  });

  // `candidates` now accepts `--state-dir` alongside its siblings
  // (`raise`/`approve`/`reject`/`db rebuild`), and the point of accepting it
  // is that a typoed `--session` fails loudly (P9-28) instead of silently
  // reading back an empty or wrong candidate list.
  it('lessons candidates: an unknown --session fails against --state-dir, not silently', () => {
    const eventsDir = path.join(scratchDir, 'dream-events');
    const dbPath = path.join(scratchDir, `cli-candidates-unknown-session-${Date.now()}.db`);

    const result = runCli([
      'lessons',
      'candidates',
      '--db',
      dbPath,
      '--session',
      'no-such-session',
      '--state-dir',
      eventsDir,
    ]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('events.unknown-session');
  });

  // D-159. The novelty gate's cutoff is documented as living in
  // factory/policies/scheduler.yml: architecture §9.3 points operators at it,
  // the block's own comment explains what the number does, and
  // parseSchedulerPolicy parses it into SchedulerPolicy.lessons. Nothing read
  // it — dream() fell back to lessons.ts's DEFAULT_NOVELTY_THRESHOLD every
  // run, so retuning the file changed nothing. These two escalations differ by
  // one word in thirteen (Jaccard 0.571), which straddles the two policies
  // below: ignore the file again and one of the two runs is wrong.
  it('dream: novelty gate scores against the policy file, not a constant', () => {
    // Length-awareness is written explicitly here for the reason D-208 writes
    // it: one word in thirteen scores exactly 0.571, which is also the ceiling
    // a thirteen-word statement has after one word changes, so with the
    // correction on no threshold in the file can call the pair novel. It is
    // off while the file's own number is the variable, then on for the last
    // run, which is what proves the correction reaches dream() from the file.
    const policyAt = (threshold: number, lengthAware = false): string => {
      const file = path.join(scratchDir, `d159-scheduler-${threshold}-${lengthAware}.yml`);
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

    const dreamUnder = (policy: string, tag: string): Record<string, unknown> => {
      const sessionId = `cli-d159-${tag}-${Date.now()}`;
      const eventsDir = path.join(scratchDir, `d159-${tag}-events`);
      const append = (record: Record<string, unknown>): string => {
        const result = runCli([
          'event',
          'append',
          JSON.stringify(record),
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        return JSON.parse(result.stdout).event_id as string;
      };

      let parent = append({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      });
      for (const taskRef of ['epic-1/task-1', 'epic-1/task-2']) {
        parent = append({
          session_id: sessionId,
          actor: 'system',
          event_type: 'error-logged',
          task_id: taskRef,
          plan_version: 1,
          causal_parent: parent,
          payload: {
            error: 'coordination.deadlock',
            severity: 'S2-major',
            task_ref: taskRef,
            detail: 'worker idle for twenty minutes',
          },
        });
      }

      const result = runCli([
        'dream',
        '--session',
        sessionId,
        '--plan-version',
        '1',
        '--causal-parent',
        parent,
        '--policy',
        policy,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(json.checkpointsExtracted).toBe(2);
      return json;
    };

    // 0.571 >= 0.5: the second escalation is "clearly redundant", auto-rejected
    // without an LLM call.
    const strict = dreamUnder(policyAt(0.5), 'strict');
    expect(strict.raised).toHaveLength(1);
    expect(strict.noveltyRejected).toHaveLength(1);

    // 0.571 < 0.6: same events, same run, both raised.
    const loose = dreamUnder(policyAt(0.6), 'loose');
    expect(loose.raised).toHaveLength(2);
    expect(loose.noveltyRejected).toHaveLength(0);

    // Same 0.6, same events, correction on (P9-35 (a)): thirteen words cannot
    // score above 0.571 after one word changes, so the bar comes down to meet
    // the score and the second escalation is what it always was — the first
    // one restated. This is the hole P9-35 measured, closed through the file.
    const corrected = dreamUnder(policyAt(0.6, true), 'corrected');
    expect(corrected.raised).toHaveLength(1);
    expect(corrected.noveltyRejected).toHaveLength(1);
  });
});
