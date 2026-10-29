import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOLLOW_TICK_MS } from '../src/events.js';
import { CLI_PATH, committedWorktreeIn, REPO_ROOT, runCli } from './helpers/cliHarness.js';
import { runOrThrow, startProcess } from './helpers/process.js';

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

  // The tester's screenshots reach the dashboard the moment the tester
  // finishes, not only at the next `gate run`. `gate run` bundles this same
  // schema-check/task-result-recorded/artifact-check sequence with a worktree
  // certification a tester never has, so wave.md's tester dispatch needed a
  // caller with no worktree and no tests to run — this verb is that caller,
  // over `recordTaskResult` (gate.ts).
  describe('results record', () => {
    const eventsDir = () => path.join(scratchDir, 'results-record-events');
    const artifactsDir = () => path.join(scratchDir, 'results-record-artifacts');

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
        eventsDir(),
      ]);
      expect(status).toBe(0);
      return JSON.parse(stdout).event_id;
    }

    function resultFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        task_id: 'epic-1/task-2',
        run_status: 'done',
        structured_output: {},
        artifacts: [],
        token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        agent: 'tester',
        provider: 'claude',
        model_tier: 'mid',
        ...overrides,
      };
    }

    function writeResult(name: string, overrides: Record<string, unknown> = {}): string {
      const file = path.join(scratchDir, name);
      writeFileSync(file, JSON.stringify(resultFixture(overrides)));
      return file;
    }

    function record(sessionId: string, parent: string, resultFile: string, extra: string[] = []) {
      return runCli([
        'results',
        'record',
        '--task',
        'epic-1/task-2',
        '--result',
        resultFile,
        '--session',
        sessionId,
        '--causal-parent',
        parent,
        '--state-dir',
        eventsDir(),
        ...extra,
      ]);
    }

    it('records a valid result and prints the event id it was written under', () => {
      const root = seedSession('res-1');
      const file = writeResult('res-1-result.json');

      const { stdout, status } = record('res-1', root, file);

      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toMatchObject({
        outcome: 'recorded',
        taskId: 'epic-1/task-2',
        deduped: false,
      });
      expect(parsed.eventId).toMatch(/^res-1#\d+$/);

      const tail = runCli(['event', 'tail', 'res-1', '--state-dir', eventsDir()]);
      const events = JSON.parse(tail.stdout);
      expect(
        events.some(
          (e: { record: { event_type: string } }) => e.record.event_type === 'task-result-recorded',
        ),
      ).toBe(true);
    });

    it('blocks on a schema-invalid result and exits 1', () => {
      const root = seedSession('res-2');
      const file = writeResult('res-2-result.json', { run_status: 'not-a-real-status' });

      const { stdout, status } = record('res-2', root, file);

      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed).toMatchObject({ outcome: 'blocked', reason: 'schema-invalid' });
      expect(parsed.schemaErrors.length).toBeGreaterThan(0);
    });

    it('blocks on an artifact outside the task home', () => {
      const root = seedSession('res-3');
      const file = writeResult('res-3-result.json', {
        artifacts: [{ type: 'screenshot', path: '/tmp/probe-outside-home.png' }],
      });

      const { stdout, status } = record('res-3', root, file, ['--artifacts-dir', artifactsDir()]);

      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed).toMatchObject({ outcome: 'blocked', reason: 'artifacts-missing' });
      expect(parsed.artifactIssues).toHaveLength(1);
    });

    it('projects a screenshot declared inside the task home, via --artifacts-dir', () => {
      const root = seedSession('res-4');
      const home = path.join(artifactsDir(), 'epic-1', 'task-2');
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, 'screen.png'), 'not-really-a-png');
      const file = writeResult('res-4-result.json', {
        artifacts: [{ type: 'screenshot', path: 'screen.png' }],
      });

      const { stdout, status } = record('res-4', root, file, ['--artifacts-dir', artifactsDir()]);

      expect(status).toBe(0);
      expect(JSON.parse(stdout).outcome).toBe('recorded');
    });

    it('is idempotent: a byte-identical re-run hands back the first event id, deduped', () => {
      const root = seedSession('res-5');
      const file = writeResult('res-5-result.json');

      const first = record('res-5', root, file);
      const second = record('res-5', root, file);

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      const firstParsed = JSON.parse(first.stdout);
      const secondParsed = JSON.parse(second.stdout);
      expect(firstParsed.deduped).toBe(false);
      expect(secondParsed.deduped).toBe(true);
      expect(secondParsed.eventId).toBe(firstParsed.eventId);

      const tail = runCli(['event', 'tail', 'res-5', '--state-dir', eventsDir()]);
      const events = JSON.parse(tail.stdout);
      expect(
        events.filter(
          (e: { record: { event_type: string } }) => e.record.event_type === 'task-result-recorded',
        ),
      ).toHaveLength(1);
    });

    it('requires --task and --result', () => {
      const root = seedSession('res-6');
      const file = writeResult('res-6-result.json');

      const missingTask = runCli([
        'results',
        'record',
        '--result',
        file,
        '--session',
        'res-6',
        '--causal-parent',
        root,
        '--state-dir',
        eventsDir(),
      ]);
      expect(missingTask.status).toBe(1);
      expect(JSON.parse(missingTask.stdout).error.code).toBe('cli.missing-flag');

      const missingResult = runCli([
        'results',
        'record',
        '--task',
        'epic-1/task-2',
        '--session',
        'res-6',
        '--causal-parent',
        root,
        '--state-dir',
        eventsDir(),
      ]);
      expect(missingResult.status).toBe(1);
      expect(JSON.parse(missingResult.stdout).error.code).toBe('cli.missing-flag');
    });

    it('never emits gate-outcome — a Result projection is not a gate run', () => {
      const root = seedSession('res-7');
      const file = writeResult('res-7-result.json');

      expect(record('res-7', root, file).status).toBe(0);

      const tail = runCli(['event', 'tail', 'res-7', '--state-dir', eventsDir()]);
      const types = JSON.parse(tail.stdout).map(
        (e: { record: { event_type: string } }) => e.record.event_type,
      );
      expect(types).toContain('task-result-recorded');
      expect(types).not.toContain('gate-outcome');
    });

    // D-18/P9-17, as `gate run` has it: with `--agent` the file is the worker's
    // half and the dispatcher stamps token_usage, so a tester cannot feed the
    // budget reads a count it wrote itself.
    describe('with --agent (dispatcher stamping)', () => {
      const TESTER_HALF = { run_status: 'done', structured_output: {}, artifacts: [] };
      const STAMP = ['--agent', 'tester', '--provider', 'claude', '--model-tier', 'mid'];

      function writeHalf(name: string, half: Record<string, unknown>): string {
        const file = path.join(scratchDir, name);
        writeFileSync(file, JSON.stringify(half));
        return file;
      }

      function recordedPayload(sessionId: string): Record<string, unknown> | undefined {
        const tail = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir()]);
        return JSON.parse(tail.stdout).find(
          (e: { record: { event_type: string } }) => e.record.event_type === 'task-result-recorded',
        )?.record.payload;
      }

      it('stamps {measured: false} when no token flags are given', () => {
        const root = seedSession('res-8');
        const file = writeHalf('res-8-half.json', TESTER_HALF);

        const { status } = record('res-8', root, file, STAMP);

        expect(status).toBe(0);
        expect(recordedPayload('res-8')).toMatchObject({
          task_id: 'epic-1/task-2',
          agent: 'tester',
          token_usage: { measured: false },
        });
      });

      it('stamps the measured count when both token flags are given', () => {
        const root = seedSession('res-9');
        const file = writeHalf('res-9-half.json', TESTER_HALF);

        const { status } = record('res-9', root, file, [
          ...STAMP,
          '--input-tokens',
          '1200',
          '--output-tokens',
          '300',
        ]);

        expect(status).toBe(0);
        expect(recordedPayload('res-9')).toMatchObject({
          token_usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
        });
      });

      it('refuses a tester-written token_usage instead of recording it', () => {
        const root = seedSession('res-10');
        const file = writeHalf('res-10-half.json', {
          ...TESTER_HALF,
          token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });

        const { stdout, status } = record('res-10', root, file, STAMP);

        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('results.agent-wrote-owned-field');
        expect(recordedPayload('res-10')).toBeUndefined();
      });
    });

    // U2 S3/D2: freshness is proven by the HEAD recorded alongside the
    // tester's own results record call, not an mtime or a self-written
    // manifest -- so `--worktree` is what makes that sha part of the record.
    describe('--worktree (freshness, U2 S3)', () => {
      it('records head and screenshots on artifact-check-result when given --worktree', async () => {
        const worktreeDir = await committedWorktree('results-record-worktree');
        const head = runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: worktreeDir }).stdout.trim();
        const home = path.join(artifactsDir(), 'epic-1', 'task-2');
        mkdirSync(home, { recursive: true });
        writeFileSync(path.join(home, 'home-desktop-light.png'), 'png-bytes');
        const root = seedSession('res-11');
        const file = writeResult('res-11-result.json', {
          artifacts: [{ type: 'screenshot', path: 'home-desktop-light.png' }],
        });

        const { status } = record('res-11', root, file, [
          '--artifacts-dir',
          artifactsDir(),
          '--worktree',
          worktreeDir,
        ]);

        expect(status).toBe(0);
        const tail = runCli(['event', 'tail', 'res-11', '--state-dir', eventsDir()]);
        const check = JSON.parse(tail.stdout).find(
          (e: { record: { event_type: string } }) =>
            e.record.event_type === 'artifact-check-result',
        );
        expect(check.record.payload.head).toBe(head);
        expect(check.record.payload.screenshots).toEqual([
          { path: 'home-desktop-light.png', viewport: 'desktop', theme: 'light' },
        ]);
      });

      it('omits head and screenshots when no --worktree is given', () => {
        const root = seedSession('res-12');
        const file = writeResult('res-12-result.json');

        const { status } = record('res-12', root, file);

        expect(status).toBe(0);
        const tail = runCli(['event', 'tail', 'res-12', '--state-dir', eventsDir()]);
        const check = JSON.parse(tail.stdout).find(
          (e: { record: { event_type: string } }) =>
            e.record.event_type === 'artifact-check-result',
        );
        expect(check.record.payload.head).toBeUndefined();
        expect(check.record.payload.screenshots).toBeUndefined();
      });
    });
  });

  describe('event lineage / tail --lineage (P9-7)', () => {
    const eventsDir = () => path.join(scratchDir, 'lineage-events');

    function append(sessionId: string, eventType: string, parent: string | null): string {
      const { stdout, status } = runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          actor: 'user',
          event_type: eventType,
          plan_version: 1,
          causal_parent: parent,
          payload: {},
        }),
        '--state-dir',
        eventsDir(),
      ]);
      expect(status).toBe(0);
      return JSON.parse(stdout).event_id;
    }

    it('chains a second session onto the first and reports the lineage root-first', () => {
      const a0 = append('lin-a', 'session-start', null);
      const a1 = append('lin-a', 'user_prompt', a0);
      append('lin-b', 'session-start', a1);

      const { stdout, status } = runCli(['event', 'lineage', 'lin-b', '--state-dir', eventsDir()]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.lineage).toEqual(['lin-a', 'lin-b']);
      expect(parsed.root).toBe('lin-a');
      expect(parsed.depth).toBe(2);
      expect(parsed.continued_by).toEqual([]);
    });

    it('names the waves that continue an epic, read from the epic itself (D-266)', () => {
      const r0 = append('fan-root', 'session-start', null);
      append('fan-w2', 'session-start', r0);
      append('fan-w1', 'session-start', r0);

      const { stdout, status } = runCli([
        'event',
        'lineage',
        'fan-root',
        '--state-dir',
        eventsDir(),
      ]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.lineage).toEqual(['fan-root', 'fan-w1', 'fan-w2']);
      expect(parsed.continued_by).toEqual(['fan-w1', 'fan-w2']);
      // A fan-out is width, not depth: the epic is still one window deep.
      expect(parsed.depth).toBe(1);
      expect(parsed.root).toBe('fan-root');

      // And from inside a wave, the siblings are somebody else's scope.
      const wave = runCli(['event', 'lineage', 'fan-w1', '--state-dir', eventsDir()]);
      expect(wave.status).toBe(0);
      expect(JSON.parse(wave.stdout).lineage).toEqual(['fan-root', 'fan-w1']);
    });

    it('tail --lineage reads the whole epic, plain tail reads one session', () => {
      const c0 = append('lin-c', 'session-start', null);
      append('lin-c', 'user_prompt', c0);
      const d0 = append('lin-d', 'session-start', 'lin-c#1');
      append('lin-d', 'user_prompt', d0);

      const plain = runCli(['event', 'tail', 'lin-d', '--state-dir', eventsDir()]);
      expect(plain.status).toBe(0);
      expect(JSON.parse(plain.stdout)).toHaveLength(2);

      const across = runCli(['event', 'tail', 'lin-d', '--lineage', '--state-dir', eventsDir()]);
      expect(across.status).toBe(0);
      const events = JSON.parse(across.stdout);
      expect(events).toHaveLength(4);
      expect(events.map((e: { event_id: string }) => e.event_id)).toEqual([
        'lin-c#0',
        'lin-c#1',
        'lin-d#0',
        'lin-d#1',
      ]);
    });

    it('rejects a cross-session parent on an event that is not the session root', () => {
      const e0 = append('lin-e', 'session-start', null);
      append('lin-f', 'session-start', e0);

      const { stdout, status } = runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: 'lin-f',
          actor: 'user',
          event_type: 'user_prompt',
          plan_version: 1,
          causal_parent: 'lin-e#0',
          payload: {},
        }),
        '--state-dir',
        eventsDir(),
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('events.cross-session-parent-not-root');
    });

    it('names the session when the cross-session parent points at a log that does not exist', () => {
      const { stdout, status } = runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: 'lin-g',
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: 'lin-typo#0',
          payload: {},
        }),
        '--state-dir',
        eventsDir(),
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('events.unknown-causal-session');
      expect(parsed.error.message).toContain('lin-typo');
    });
  });

  // A stream is not an array. Every other read verb prints one JSON document
  // and exits; `--follow` prints one record per line and keeps the file open,
  // so the two things worth an end-to-end test are the ones no unit test of
  // followEvents can see: that the built binary ACCEPTS the flag (the usage
  // table is the allow-list), and that the bytes reaching a pipe are line-
  // delimited from the first record rather than at the end.
  describe('event tail --follow (P9-7 follow-up)', () => {
    const eventsDir = () => path.join(scratchDir, 'follow-events');

    function append(
      sessionId: string,
      note: string,
      parent: string | null,
      taskId?: string,
    ): string {
      const { stdout, status } = runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          actor: 'user',
          event_type: 'operator-note',
          plan_version: 1,
          causal_parent: parent,
          payload: { note, ...(taskId === undefined ? {} : { task_id: taskId }) },
        }),
        '--state-dir',
        eventsDir(),
      ]);
      expect(status).toBe(0);
      return JSON.parse(stdout).event_id;
    }

    /** A log has to be opened before it can be followed; only a root may be parentless. */
    function start(sessionId: string): string {
      const { stdout, status } = runCli([
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
        eventsDir(),
      ]);
      expect(status).toBe(0);
      return JSON.parse(stdout).event_id;
    }

    it('prints the backlog a line at a time, then each new record, each one once', async () => {
      const sessionId = `cli-follow-${Date.now()}`;
      const root = start(sessionId);
      const first = append(sessionId, 'one', root);

      const follow = startProcess('node', [
        CLI_PATH,
        'event',
        'tail',
        sessionId,
        '--state-dir',
        eventsDir(),
        '--follow',
      ]);
      try {
        // The backlog lands before anything appends. A follower that printed
        // nothing until the next event would show an operator a blank screen
        // over a log that already holds the answer they came for.
        const backlog = await follow.waitForLines(2);
        expect(backlog.map((line) => JSON.parse(line).event_id)).toEqual([root, first]);

        const second = append(sessionId, 'two', first);
        const all = await follow.waitForLines(3);
        expect(all.map((line) => JSON.parse(line).event_id)).toEqual([root, first, second]);

        // Re-reading is not re-printing. The poll is a second, so waiting out
        // two of them is the only way to tell a cursor that holds from one
        // that re-emits the tail on every read.
        await new Promise((resolve) => setTimeout(resolve, 2 * FOLLOW_TICK_MS + 500));
        expect(follow.lines()).toHaveLength(3);

        // ^C is how this command is meant to end, so it ENDS on one -- an
        // operator who hits it and then waits reaches for `kill -9`.
        const ended = await follow.stop('SIGINT');
        expect(ended.signal).toBeNull();
        expect(ended.status).toBe(0);
        expect(ended.stderr).toBe('');
      } finally {
        await follow.stop('SIGKILL');
      }
    });

    it('bounds the backlog with --n and scopes the stream with --task', async () => {
      const sessionId = `cli-follow-scope-${Date.now()}`;
      const mine = append(sessionId, 'mine-1', start(sessionId), 'T-follow');
      const theirs = append(sessionId, 'theirs-1', mine, 'T-other');
      const recent = append(sessionId, 'mine-2', theirs, 'T-follow');

      const follow = startProcess('node', [
        CLI_PATH,
        'event',
        'tail',
        sessionId,
        '--state-dir',
        eventsDir(),
        '--n',
        '2',
        '--task',
        'T-follow',
        '--follow',
      ]);
      try {
        // Slice first, then filter -- the order the one-shot form already
        // uses. The last two records are theirs-1 and mine-2; only mine-2
        // survives the scope, and mine-1 is older than the window regardless.
        const backlog = await follow.waitForLines(1);
        expect(backlog.map((line) => JSON.parse(line).event_id)).toEqual([recent]);

        // A record outside the scope is not a record this stream skipped over
        // silently: it never enters it, and the one after it still arrives.
        const alsoTheirs = append(sessionId, 'theirs-2', recent, 'T-other');
        const mineAgain = append(sessionId, 'mine-3', alsoTheirs, 'T-follow');
        const seen = await follow.waitForLines(2);
        expect(seen.map((line) => JSON.parse(line).event_id)).toEqual([recent, mineAgain]);

        const ended = await follow.stop('SIGINT');
        expect(ended.status).toBe(0);
      } finally {
        await follow.stop('SIGKILL');
      }
    });
  });

  // P9-16(b)/D-24. The factory speaks JSON on stdout and nothing anywhere
  // else. A project with no remote — which is every project `smith new`
  // creates — used to make the default-branch probe print `fatal: ref
  // refs/remotes/origin/HEAD is not a symbolic ref` onto the operator's
  // terminal, and `git worktree add` follow it with `Preparing worktree`.
  // Both are normal operation reported as alarm.
  describe('stderr silence on a remote-less project (P9-16b)', () => {
    let projectDir: string;

    beforeAll(async () => {
      projectDir = path.join(scratchDir, 'quiet-project');
      await mkdir(projectDir, { recursive: true });
      runOrThrow('git', ['init', '-q', '-b', 'main', projectDir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
      await writeFile(path.join(projectDir, 'README.md'), '# quiet\n');
      runOrThrow('git', ['add', '.'], { cwd: projectDir });
      runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
    });

    it('worktree create says nothing on stderr', () => {
      const { stderr, status } = runCli(['worktree', 'create', projectDir, 'epic-1', 'task-1']);
      expect(status).toBe(0);
      expect(stderr).toBe('');
    });

    // Silence must not cost the diagnosis: when git does fail, its own words
    // come back in the JSON envelope on stdout instead of the terminal.
    it('reports git’s own words in the error envelope when git fails', () => {
      const { stdout, stderr, status } = runCli([
        'worktree',
        'rm',
        projectDir,
        'epic-1',
        'no-such-task',
      ]);
      expect(status).toBe(1);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout).error.message).toContain('is not a working tree');
    });
  });

  // A successor task's whole point is to keep the predecessor's commits, so
  // reusing them has to be tied to the logged amendment that actually paired
  // the two ids -- not to an operator's bare say-so on the command line.
  describe('worktree create --from (successor re-scope)', () => {
    let projectDir: string;

    beforeAll(async () => {
      projectDir = path.join(scratchDir, 'from-project');
      await mkdir(projectDir, { recursive: true });
      runOrThrow('git', ['init', '-q', '-b', 'main', projectDir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
      await writeFile(path.join(projectDir, 'README.md'), '# from\n');
      runOrThrow('git', ['add', '.'], { cwd: projectDir });
      runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
    });

    function append(eventsDir: string, event: Record<string, unknown>): string {
      const run = runCli(['event', 'append', JSON.stringify(event), '--state-dir', eventsDir]);
      expect(run.status, run.stdout).toBe(0);
      return JSON.parse(run.stdout).event_id as string;
    }

    it('is refused without a logged successors entry pairing the two ids', () => {
      const sessionId = `cli-from-refuse-${Date.now()}`;
      const eventsDir = path.join(scratchDir, `events-from-refuse-${Date.now()}`);
      const parent = append(eventsDir, {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      });
      void parent;

      const worktreeDir = path.join(scratchDir, 'wt', `from-refuse-${Date.now()}`);
      runOrThrow('git', ['worktree', 'add', '-b', 'smith/epic-from/task-1', worktreeDir, 'main'], {
        cwd: projectDir,
      });

      const { stdout, status } = runCli([
        'worktree',
        'create',
        projectDir,
        'epic-from',
        'task-1-v2',
        '--from',
        'task-1',
        '--session',
        sessionId,
        '--state-dir',
        eventsDir,
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('worktree.not-a-successor');
    });

    it('is accepted once a plan amendment records the successors pairing', () => {
      const sessionId = `cli-from-accept-${Date.now()}`;
      const eventsDir = path.join(scratchDir, `events-from-accept-${Date.now()}`);
      const parent = append(eventsDir, {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      });
      append(eventsDir, {
        session_id: sessionId,
        actor: 'user',
        event_type: 'plan-version-created',
        plan_version: 2,
        causal_parent: parent,
        payload: {
          epic_id: 'epic-from2',
          version: 2,
          previous_version: 1,
          successors: { 'epic-from2/task-1': 'epic-from2/task-1-v2' },
        },
      });

      runOrThrow(
        'git',
        [
          'worktree',
          'add',
          '-b',
          'bs/epic-from2/task-1',
          path.join(scratchDir, 'wt', 'from2-pred'),
          'main',
        ],
        { cwd: projectDir },
      );

      const { stdout, status } = runCli([
        'worktree',
        'create',
        projectDir,
        'epic-from2',
        'task-1-v2',
        '--from',
        'task-1',
        '--session',
        sessionId,
        '--state-dir',
        eventsDir,
      ]);
      expect(status, stdout).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.branch).toBe('bs/epic-from2/task-1-v2');
    });

    // The bug this pins: a plan amended twice before the intermediate
    // successor is ever cut. v2 pairs task-1 -> task-1-v2, v3 pairs
    // task-1-v2 -> task-1-v3, and task-1-v2 itself never gets a worktree.
    // `taskSuccessors` only ever holds each amendment's own one-hop pairing,
    // so `--from task-1` has to walk both hops to see task-1-v3 as task-1's
    // successor at all.
    it('is accepted across a two-hop supersede chain when the intermediate task was never cut', () => {
      const sessionId = `cli-from-chain-${Date.now()}`;
      const eventsDir = path.join(scratchDir, `events-from-chain-${Date.now()}`);
      const parent = append(eventsDir, {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      });
      const v2 = append(eventsDir, {
        session_id: sessionId,
        actor: 'user',
        event_type: 'plan-version-created',
        plan_version: 2,
        causal_parent: parent,
        payload: {
          epic_id: 'epic-from3',
          version: 2,
          previous_version: 1,
          successors: { 'epic-from3/task-1': 'epic-from3/task-1-v2' },
        },
      });
      append(eventsDir, {
        session_id: sessionId,
        actor: 'user',
        event_type: 'plan-version-created',
        plan_version: 3,
        causal_parent: v2,
        payload: {
          epic_id: 'epic-from3',
          version: 3,
          previous_version: 2,
          successors: { 'epic-from3/task-1-v2': 'epic-from3/task-1-v3' },
        },
      });

      runOrThrow(
        'git',
        [
          'worktree',
          'add',
          '-b',
          'bs/epic-from3/task-1',
          path.join(scratchDir, 'wt', 'from3-pred'),
          'main',
        ],
        { cwd: projectDir },
      );

      const { stdout, status } = runCli([
        'worktree',
        'create',
        projectDir,
        'epic-from3',
        'task-1-v3',
        '--from',
        'task-1',
        '--session',
        sessionId,
        '--state-dir',
        eventsDir,
      ]);
      expect(status, stdout).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.branch).toBe('bs/epic-from3/task-1-v3');
    });

    // A logged chain existing at all must not loosen the check into "any task
    // this epic ever amended" -- an id that never appears on `from`'s own
    // chain is still refused.
    it('is refused for a task off the chain even when other successors are logged', () => {
      const sessionId = `cli-from-offchain-${Date.now()}`;
      const eventsDir = path.join(scratchDir, `events-from-offchain-${Date.now()}`);
      const parent = append(eventsDir, {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      });
      append(eventsDir, {
        session_id: sessionId,
        actor: 'user',
        event_type: 'plan-version-created',
        plan_version: 2,
        causal_parent: parent,
        payload: {
          epic_id: 'epic-from4',
          version: 2,
          previous_version: 1,
          successors: { 'epic-from4/task-1': 'epic-from4/task-1-v2' },
        },
      });

      const { stdout, status } = runCli([
        'worktree',
        'create',
        projectDir,
        'epic-from4',
        'task-unrelated',
        '--from',
        'task-1',
        '--session',
        sessionId,
        '--state-dir',
        eventsDir,
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('worktree.not-a-successor');
    });

    // Verified review blocker on the transitive-chain fix above: A -> B -> C
    // logged, but B actually got cut as its own branch before C did. Because
    // `createTaskWorktree` branches `--from`'s target directly off `--from`'s
    // own branch, `--from task-1` for task-5-final would silently drop every
    // commit made on task-5-mid's branch -- the guard must refuse it, name
    // task-5-mid, and accept `--from task-5-mid` instead.
    it('is refused across a two-hop chain when the intermediate task was already cut, and names it', () => {
      const sessionId = `cli-from-cut-${Date.now()}`;
      const eventsDir = path.join(scratchDir, `events-from-cut-${Date.now()}`);
      const parent = append(eventsDir, {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      });
      const v2 = append(eventsDir, {
        session_id: sessionId,
        actor: 'user',
        event_type: 'plan-version-created',
        plan_version: 2,
        causal_parent: parent,
        payload: {
          epic_id: 'epic-from5',
          version: 2,
          previous_version: 1,
          successors: { 'epic-from5/task-1': 'epic-from5/task-5-mid' },
        },
      });
      append(eventsDir, {
        session_id: sessionId,
        actor: 'user',
        event_type: 'plan-version-created',
        plan_version: 3,
        causal_parent: v2,
        payload: {
          epic_id: 'epic-from5',
          version: 3,
          previous_version: 2,
          successors: { 'epic-from5/task-5-mid': 'epic-from5/task-5-final' },
        },
      });

      runOrThrow(
        'git',
        [
          'worktree',
          'add',
          '-b',
          'bs/epic-from5/task-1',
          path.join(scratchDir, 'wt', 'from5-pred'),
          'main',
        ],
        { cwd: projectDir },
      );
      // The intermediate WAS cut -- its branch may carry real commits that a
      // straight `--from task-1` skip would drop without a trace.
      runOrThrow(
        'git',
        [
          'worktree',
          'add',
          '-b',
          'bs/epic-from5/task-5-mid',
          path.join(scratchDir, 'wt', 'from5-mid'),
          'main',
        ],
        { cwd: projectDir },
      );

      const refused = runCli([
        'worktree',
        'create',
        projectDir,
        'epic-from5',
        'task-5-final',
        '--from',
        'task-1',
        '--session',
        sessionId,
        '--state-dir',
        eventsDir,
      ]);
      expect(refused.status).toBe(1);
      const error = JSON.parse(refused.stdout).error;
      expect(error.code).toBe('worktree.chain-intermediate-cut');
      expect(error.message).toContain('task-5-mid');

      const accepted = runCli([
        'worktree',
        'create',
        projectDir,
        'epic-from5',
        'task-5-final',
        '--from',
        'task-5-mid',
        '--session',
        sessionId,
        '--state-dir',
        eventsDir,
      ]);
      expect(accepted.status, accepted.stdout).toBe(0);
      const result = JSON.parse(accepted.stdout);
      expect(result.branch).toBe('bs/epic-from5/task-5-final');
    });
  });

  // D-40/P9-25: the gate's coverage evidence, reachable without staging a
  // whole gate run — which is how an operator checks the thing D-40 cost a
  // full investigation to establish.
  describe('coverage check (P9-25)', () => {
    let worktreeDir: string;
    let planPath: string;

    const entry = (pct: number) => ({
      lines: { total: 10, covered: pct / 10, skipped: 0, pct },
      statements: { total: 10, covered: pct / 10, skipped: 0, pct },
      functions: { total: 2, covered: 2, skipped: 0, pct },
      branches: { total: 4, covered: 4, skipped: 0, pct },
    });

    async function writeSummary(files: Record<string, number>): Promise<void> {
      const doc: Record<string, unknown> = { total: entry(90) };
      for (const [rel, pct] of Object.entries(files)) doc[path.join(worktreeDir, rel)] = entry(pct);
      await mkdir(path.join(worktreeDir, 'coverage'), { recursive: true });
      await writeFile(
        path.join(worktreeDir, 'coverage', 'coverage-summary.json'),
        JSON.stringify(doc),
      );
    }

    beforeAll(async () => {
      worktreeDir = await mkdtemp(path.join(tmpdir(), 'smith-cli-cov-'));
      planPath = path.join(scratchDir, 'coverage-plan.json');
      await writeFile(
        planPath,
        JSON.stringify({
          epic_id: 'epic-1',
          version: 1,
          status: 'active',
          tasks: [
            { task_id: 'epic-1/task-4', claims: ['src/index.ts', 'test/index.test.ts'] },
            { task_id: 'epic-1/task-5', claims: ['src/parse.ts'] },
          ],
          edges: [],
        }),
      );
    });

    afterAll(async () => {
      if (worktreeDir) await rm(worktreeDir, { recursive: true, force: true });
    });

    it('prints the per-file number for the file the criterion names, and exits 0', async () => {
      // The D-40 shape exactly: index.ts and validate.ts at 100% (the rows the
      // text table hides), coerce.ts and parse.ts below it (the rows it shows).
      await writeSummary({
        'src/index.ts': 100,
        'src/validate.ts': 100,
        'src/coerce.ts': 90,
        'src/parse.ts': 90,
      });

      const { stdout, status } = runCli([
        'coverage',
        'check',
        worktreeDir,
        '--plan',
        planPath,
        '--task',
        'epic-1/task-4',
      ]);

      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.complete).toBe(true);
      expect(parsed.files_measured).toBe(4);
      expect(parsed.subjects).toContainEqual(
        expect.objectContaining({ path: 'src/index.ts', status: 'measured', lines_pct: 100 }),
      );
    });

    it('exits 1 and names the file when the run measured everything except it', async () => {
      await writeSummary({ 'src/parse.ts': 90 });

      const { stdout, status } = runCli([
        'coverage',
        'check',
        worktreeDir,
        '--plan',
        planPath,
        '--task',
        'epic-1/task-4',
      ]);

      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.complete).toBe(false);
      expect(parsed.detail).toContain('src/index.ts');
    });

    it('exits 1 naming json-summary when the coverage run wrote no summary', async () => {
      const bare = await mkdtemp(path.join(tmpdir(), 'smith-cli-cov-bare-'));
      try {
        const { stdout, status } = runCli(['coverage', 'check', bare]);
        expect(status).toBe(1);
        const parsed = JSON.parse(stdout);
        expect(parsed.present).toBe(false);
        expect(parsed.detail).toContain('json-summary');
      } finally {
        await rm(bare, { recursive: true, force: true });
      }
    });

    it('requires the worktree directory instead of defaulting to cwd', () => {
      const { stdout, status } = runCli(['coverage', 'check']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.message).toContain('worktree-dir');
    });

    it('requires --task alongside --plan rather than guessing whose claims to judge', async () => {
      await writeSummary({ 'src/index.ts': 100 });

      const { stdout, status } = runCli(['coverage', 'check', worktreeDir, '--plan', planPath]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-flag');
      expect(parsed.error.message).toContain('--task');
    });
  });

  describe('sandbox open/close/status', () => {
    // The orchestrator's half of the judge sandbox: it opens a lease before
    // handing a worktree to a judge and closes it when the verdict is in.
    // While one is open, `policy hook` evaluates guardrails.yml's judge-*
    // rules on top of the six that always apply. The judge itself is refused
    // all three of these verbs by `judge-sandbox-escape`, which is the only
    // reason a lease it could lift would mean anything.
    const openArgs = (worktree: string, leaseDir: string, overrides: string[] = []): string[] => [
      'sandbox',
      'open',
      worktree,
      '--role',
      'reviewer',
      '--task',
      'epic-1/task-1',
      '--session',
      'sess-1',
      '--at',
      '2026-08-26T00:00:00.000Z',
      '--lease-dir',
      leaseDir,
      ...overrides,
    ];

    const worktreeAt = (name: string): string => {
      const dir = path.join(scratchDir, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    };

    it('opens a lease, prints it, and refuses a second one on the same worktree', () => {
      const leaseDir = path.join(scratchDir, 'leases-open');
      const worktree = worktreeAt('sandbox-open-wt');

      const first = runCli(openArgs(worktree, leaseDir));
      expect(first.status).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual({
        worktreeDir: worktree,
        role: 'reviewer',
        taskId: 'epic-1/task-1',
        sessionId: 'sess-1',
        openedAt: '2026-08-26T00:00:00.000Z',
      });

      // Two judges in one worktree means the second one's writes land inside
      // the first one's lease and neither verdict can be trusted; the
      // orchestrator's answer is a second worktree, so this is an error.
      const second = runCli(openArgs(worktree, leaseDir, ['--role', 'verifier']));
      expect(second.status).toBe(1);
      const failure = JSON.parse(second.stdout);
      expect(failure.error.code).toBe('sandbox.already-open');
      expect(failure.error.message).toContain('reviewer');
    });

    it('requires the role, task and session a denial has to be able to name', () => {
      const leaseDir = path.join(scratchDir, 'leases-flags');
      const worktree = worktreeAt('sandbox-flags-wt');
      const { stdout, status } = runCli(['sandbox', 'open', worktree, '--lease-dir', leaseDir]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-flag');
      expect(parsed.error.message).toContain('--role');
    });

    it('lists every open lease, and resolves the one covering a subdirectory', () => {
      const leaseDir = path.join(scratchDir, 'leases-status');
      const worktree = worktreeAt('sandbox-status-wt');
      const deep = path.join(worktree, 'factory', 'orchestrator');
      mkdirSync(deep, { recursive: true });
      runCli(openArgs(worktree, leaseDir));

      const all = JSON.parse(runCli(['sandbox', 'status', '--lease-dir', leaseDir]).stdout);
      expect(all.sandboxes).toHaveLength(1);
      expect(all.sandboxes[0].taskId).toBe('epic-1/task-1');

      // The question the hook actually asks: not "is this exact path leased"
      // but "would a command run here be judged", which a `cd` must not change.
      const scoped = JSON.parse(
        runCli(['sandbox', 'status', '--worktree', deep, '--lease-dir', leaseDir]).stdout,
      );
      expect(scoped.sandbox.worktreeDir).toBe(worktree);
    });

    it('reports no lease, rather than failing, for a worktree nobody is judging', () => {
      const leaseDir = path.join(scratchDir, 'leases-empty');
      const { stdout, status } = runCli([
        'sandbox',
        'status',
        '--worktree',
        worktreeAt('sandbox-unleased-wt'),
        '--lease-dir',
        leaseDir,
      ]);
      expect(status).toBe(0);
      expect(JSON.parse(stdout).sandbox).toBeNull();
    });

    it('closes a lease, and closing one that is already closed is not a failure', () => {
      // Cleanup runs after a judge that crashed just as much as after one that
      // finished; making "already closed" an error would turn tidying up into
      // a second failure to handle.
      const leaseDir = path.join(scratchDir, 'leases-close');
      const worktree = worktreeAt('sandbox-close-wt');
      runCli(openArgs(worktree, leaseDir));

      const first = runCli(['sandbox', 'close', worktree, '--lease-dir', leaseDir]);
      expect(first.status).toBe(0);
      expect(JSON.parse(first.stdout).closed).toBe(true);

      const second = runCli(['sandbox', 'close', worktree, '--lease-dir', leaseDir]);
      expect(second.status).toBe(0);
      expect(JSON.parse(second.stdout).closed).toBe(false);
    });
  });

  describe('policy check', () => {
    // The operator-facing half of the same rules the hook applies: it answers
    // "would this be refused, and why" without having to stage a judge and
    // trip the guard for real.
    it('reports a command that trips no rule as allowed', () => {
      const { stdout, status } = runCli(['policy', 'check', '--command', 'echo hi']);
      expect(status).toBe(0);
      expect(JSON.parse(stdout).allowed).toBe(true);
    });

    it('names the rule and exits 1 for a command a rule denies', () => {
      const { stdout, status } = runCli([
        'policy',
        'check',
        '--command',
        'wrangler deploy',
        '--branch',
        'feature',
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.allowed).toBe(false);
      expect(parsed.violations[0].ruleId).toBe('deploy-command');
    });

    it('applies the judge rules under a hypothetical --sandbox role, and not without one', () => {
      const denied = runCli([
        'policy',
        'check',
        '--command',
        'curl https://example.com',
        '--sandbox',
        'reviewer',
        '--branch',
        'feature',
      ]);
      expect(denied.status).toBe(1);
      const parsed = JSON.parse(denied.stdout);
      expect(parsed.violations[0].ruleId).toBe('judge-network');
      expect(parsed.violations[0].reason).toContain('reviewer');

      // The property that matters is not "a judge is refused" but "only a
      // judge is refused": the same command from a coder session is ordinary.
      const allowed = runCli([
        'policy',
        'check',
        '--command',
        'curl https://example.com',
        '--branch',
        'feature',
      ]);
      expect(allowed.status).toBe(0);
      expect(JSON.parse(allowed.stdout).allowed).toBe(true);
    });

    it('picks up a real lease over its own cwd from the lease directory', () => {
      // Without --sandbox the lease is resolved the way the hook resolves it,
      // so `policy check` from a judge's worktree answers what that judge would
      // actually be told. The test process stands at the repo root, so a lease
      // opened there is the one covering this call.
      const leaseDir = path.join(scratchDir, 'leases-policy-check');
      runCli([
        'sandbox',
        'open',
        REPO_ROOT,
        '--role',
        'verifier',
        '--task',
        'epic-1/task-9',
        '--session',
        'sess-9',
        '--lease-dir',
        leaseDir,
      ]);
      try {
        const { stdout, status } = runCli([
          'policy',
          'check',
          '--command',
          'git add -A',
          '--branch',
          'feature',
          '--lease-dir',
          leaseDir,
        ]);
        expect(status).toBe(1);
        const parsed = JSON.parse(stdout);
        expect(parsed.violations[0].ruleId).toBe('judge-write');
        expect(parsed.violations[0].reason).toContain('verifier');
      } finally {
        runCli(['sandbox', 'close', REPO_ROOT, '--lease-dir', leaseDir]);
      }
    });
  });

  describe('policy hook', () => {
    // `policy hook` is the CLI route to the decision `.claude/hooks/guard.sh`
    // makes on every PreToolUse call; the shim itself execs the leaner
    // `dist/policyHook.js`, and both call the same decideHookPayload, so this
    // pins the contract for both. That contract is exit-code-driven: exit 0
    // means a decision was reached, carrying a deny envelope on stdout or
    // nothing at all, and anything the shim must treat as "could not evaluate
    // this, fail closed" — a payload that does not even parse as JSON, here —
    // has to leave via a non-zero exit instead. This is the regression test for
    // that split: guard.sh's own predecessor (`extract_field`, BSD-sed-broken
    // — see guard.sh's header) read an unparseable/unmatched payload as "no
    // tool_name", which was indistinguishable from "nothing to inspect", and
    // silently allowed. This must never look like an allow again.
    it('fails the process, not the decision, on a payload that does not parse as JSON', () => {
      const { stdout, status } = runCli(['policy', 'hook'], undefined, 'not json at all');
      expect(status).not.toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.error).toBeDefined();
      expect(stdout).not.toContain('"permissionDecision"');
    });

    // An explicit `permissionDecision: "allow"` from a PreToolUse hook tells
    // Claude Code to skip the permission system for that call — it outranks
    // the operator's own `permissions.deny` globs and suppresses the approval
    // prompt. Emitting one for every command guardrails.yml does not match
    // would hand out a far wider grant than the hook this replaces ever had,
    // so "no rule fired" must leave stdout empty: the protocol's "no opinion,
    // use the normal permission flow". Asserted here rather than filtered in
    // guard.sh so a regression fails a test instead of being absorbed by
    // plumbing.
    it('stays silent, granting nothing, for a well-formed payload that trips no rule', () => {
      const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } });
      const { stdout, status } = runCli(['policy', 'hook'], undefined, payload);
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
    });

    // guard.sh always execs the MAIN clone's dist/cli.js, but the session
    // issuing the command is routinely inside a per-task git worktree on a
    // different branch. Resolving the branch from this binary's own checkout
    // would therefore judge the wrong ref — and the case that hurts is a real
    // one: the merge queue rebases from a worktree standing on
    // smith/<epic>/integration, a protected branch under rule 5, while the
    // main clone stands on something else entirely. The payload's `cwd` is
    // the answer; these two cases differ ONLY in it, so a regression to
    // checkout-relative detection makes the first one stop denying.
    // The commit is not incidental: `git rev-parse --abbrev-ref HEAD` fails on
    // an unborn branch, so a freshly-init'd repo resolves to '' and matches no
    // protected name — the deny case below would pass for the wrong reason.
    const initRepoOnBranch = (dir: string, branch: string): string => {
      mkdirSync(dir, { recursive: true });
      runOrThrow('git', ['init', '-q', '-b', branch, dir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: dir });
      runOrThrow('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
      return dir;
    };

    it('judges the branch from the payload cwd, not from its own checkout', () => {
      const dir = initRepoOnBranch(path.join(scratchDir, 'policy-cwd-protected'), 'main');
      const payload = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
        cwd: dir,
      });
      const { stdout, status } = runCli(['policy', 'hook'], undefined, payload);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('main');
    });

    it('leaves the same bare push alone when the payload cwd is on a side branch', () => {
      const dir = initRepoOnBranch(path.join(scratchDir, 'policy-cwd-side'), 'smith/e1/t1');
      const payload = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
        cwd: dir,
      });
      const { stdout, status } = runCli(['policy', 'hook'], undefined, payload);
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
    });

    it('returns a clean deny decision for a well-formed payload that trips a rule', () => {
      const payload = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
      });
      const { stdout, status } = runCli(['policy', 'hook'], undefined, payload);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('BLOCKED');
    });
  });
});
