import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_SETTINGS_REVISION } from '../src/workroot.js';
import { CLI_PATH, REPO_ROOT, runCli, sandboxFor } from './helpers/cliHarness.js';
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

  describe('crossfind request / reconcile / run (B1)', () => {
    const JUDGE_CLI = path.join(import.meta.dirname, 'fixtures', 'fake-judge-cli.mjs');
    const DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-const x = 0;\n+const x = 1;\n';

    /**
     * A crosscheck.yml whose `codex` is the fake CLI judge. Written per test
     * rather than shared, because the two switches these tests are about —
     * `independent_finder.mode` and the provider's own `mode` — are exactly
     * what each case varies.
     */
    async function writePolicy(
      name: string,
      opts: { mode: 'shadow' | 'active'; answerPath?: string },
    ): Promise<string> {
      const file = path.join(scratchDir, name);
      const args = JSON.stringify([JUDGE_CLI, 'echo-prompt', opts.answerPath ?? '/dev/null']);
      await writeFile(
        file,
        [
          'providers:',
          '  claude: { kind: native, enabled: true }',
          '  codex:',
          '    kind: api',
          '    transport: cli',
          '    command: node',
          `    args: ${args}`,
          '    model_tier: mid',
          '    enabled: true',
          `    mode: ${opts.mode}`,
          'independent_finder:',
          '  enabled: true',
          `  mode: ${opts.mode}`,
          '  providers: [codex]',
          '  send_diff: true',
          '  severity_resolution: highest-wins',
          '',
        ].join('\n'),
      );
      return file;
    }

    async function writeJson(name: string, value: unknown): Promise<string> {
      const file = path.join(scratchDir, name);
      await writeFile(file, JSON.stringify(value));
      return file;
    }

    function evidence(overrides: Record<string, unknown> = {}) {
      return {
        file_path: 'src/b.ts',
        finding_category: 'correctness',
        severity: 'S2-major',
        summary: 'the retry loop runs one fewer time than the criterion asks',
        failure_scenario: { inputs: 'n=3', expected: '3 retries', actual: '2 retries' },
        ...overrides,
      };
    }

    /** One native finding, on a different file from `evidence()` above, so the two never co-locate. */
    const NATIVE = [
      {
        finding_id: 'f-native-1',
        fingerprint: 'fp-native-1',
        file_path: 'src/a.ts',
        finding_category: 'correctness',
        severity: 'S3-minor',
        summary: 'the native reviewer saw this one and the finder did not',
      },
    ];

    it('request prints exactly what would leave the machine, and sends nothing', async () => {
      const policy = await writePolicy('cf-request.yml', { mode: 'shadow' });
      const diffPath = path.join(scratchDir, 'cf-request.diff');
      await writeFile(diffPath, DIFF);

      const { stdout, status } = runCli([
        'crossfind',
        'request',
        '--task',
        'epic-1/task-1',
        '--diff',
        diffPath,
        '--diff-ref',
        'smith/epic-1/integration...task-1',
        '--criterion',
        'retries exactly three times',
        '--criterion',
        'never retries a 4xx',
        '--policy',
        policy,
      ]);

      expect(status).toBe(0);
      const request = JSON.parse(stdout);
      expect(request.kind).toBe('review');
      expect(request.schemaName).toBe('finding-evidence');
      expect(request.inputRefs.diff_ref).toBe('smith/epic-1/integration...task-1');
      // The diff IS the request: a finder with no code invents findings.
      expect(request.prompt).toContain('+const x = 1;');
      // Repeated --criterion accumulates (args.ts `repeated`), in order.
      expect(request.prompt).toContain('retries exactly three times');
      expect(request.prompt).toContain('never retries a 4xx');
    });

    it('request narrows the judge budget from the command line, with a floor at 1', async () => {
      const policy = await writePolicy('cf-budget.yml', { mode: 'shadow' });
      const diffPath = path.join(scratchDir, 'cf-budget.diff');
      await writeFile(diffPath, DIFF);
      const base = [
        'crossfind',
        'request',
        '--task',
        'epic-1/task-1',
        '--diff',
        diffPath,
        '--diff-ref',
        'ref',
        '--policy',
        policy,
      ];

      const narrowed = runCli([...base, '--timeout-ms', '5000', '--max-output-bytes', '4096']);
      expect(narrowed.status).toBe(0);
      expect(JSON.parse(narrowed.stdout).budget).toEqual({
        timeout_ms: 5000,
        max_output_bytes: 4096,
      });

      // A zero timeout would make every call fail as a timeout and read as a
      // provider that refuses to answer; a zero byte cap would truncate every
      // verdict to nothing and read as a provider that answered with silence.
      // Those are the two failures this repo works hardest to keep apart.
      const zero = runCli([...base, '--timeout-ms', '0']);
      expect(zero.status).toBe(1);
      expect(JSON.parse(zero.stdout).error.code).toBe('cli.invalid-flag');
    });

    it('request refuses under the shipped policy rather than sending source', async () => {
      const diffPath = path.join(scratchDir, 'cf-shipped.diff');
      await writeFile(diffPath, DIFF);

      const { stdout, status } = runCli([
        'crossfind',
        'request',
        '--task',
        'epic-1/task-1',
        '--diff',
        diffPath,
        '--diff-ref',
        'ref',
      ]);

      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('crossfind.diff-not-authorized');
      expect(parsed.error.message).toContain('send_diff');
    });

    it('reconcile works offline and exits 1 when the result would change a gate', async () => {
      const policy = await writePolicy('cf-reconcile-active.yml', { mode: 'active' });
      const nativePath = await writeJson('cf-native.json', NATIVE);
      const independentPath = await writeJson('cf-independent.json', [
        { provider: 'codex', mode: 'active', evidence: [evidence()] },
      ]);

      const { stdout, status } = runCli([
        'crossfind',
        'reconcile',
        '--task',
        'epic-1/task-1',
        '--native',
        nativePath,
        '--independent',
        independentPath,
        '--policy',
        policy,
      ]);

      expect(status).toBe(1);
      const report = JSON.parse(stdout);
      expect(report.mode).toBe('active');
      expect(report.gates).toBe(true);
      expect(report.counts).toMatchObject({ 'independent-only': 1, 'native-only': 1 });
      expect(report.mintable).toHaveLength(1);
      // Rule 1: silence is not a refutation. The native finding the finder
      // never mentioned is recorded untouched, not subtracted.
      const nativeOnly = report.entries.find(
        (e: { outcome: string }) => e.outcome === 'native-only',
      );
      expect(nativeOnly).toMatchObject({ effect: 'none', applied: false });
    });

    it('reconcile in shadow mode exits 0: the same finding, gating nothing', async () => {
      const policy = await writePolicy('cf-reconcile-shadow.yml', { mode: 'shadow' });
      const nativePath = await writeJson('cf-native.json', NATIVE);
      const independentPath = await writeJson('cf-independent-shadow.json', [
        { provider: 'codex', mode: 'shadow', evidence: [evidence()] },
      ]);

      const { stdout, status } = runCli([
        'crossfind',
        'reconcile',
        '--task',
        'epic-1/task-1',
        '--native',
        nativePath,
        '--independent',
        independentPath,
        '--policy',
        policy,
      ]);

      expect(status).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.mode).toBe('shadow');
      expect(report.gates).toBe(false);
      expect(report.counts['independent-only']).toBe(1);
      expect(report.mintable).toEqual([]);
    });

    it('run dispatches the finder, records the reconciliation, and prints what to raise', async () => {
      const sessionId = `cli-crossfind-run-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'crossfind-events');
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
      const parent = JSON.parse(start.stdout).event_id as string;

      const answerPath = await writeJson('cf-answer.json', [evidence()]);
      const policy = await writePolicy('cf-run.yml', { mode: 'active', answerPath });
      const diffPath = path.join(scratchDir, 'cf-run.diff');
      await writeFile(diffPath, DIFF);

      // test/setup.ts sets SMITH_CROSSCHECK_OFFLINE for the whole suite, and
      // the CLI runs as a subprocess that inherits it. Cleared here alone:
      // this judge is a node fixture on the local disk, so honouring the
      // switch would test the switch, not the verb. The test below is the one
      // that tests the switch.
      const { stdout, status } = runCli(
        [
          'crossfind',
          'run',
          '--task',
          'epic-1/task-1',
          '--diff',
          diffPath,
          '--diff-ref',
          'smith/epic-1/integration...task-1',
          '--session',
          sessionId,
          '--causal-parent',
          parent,
          '--state-dir',
          eventsDir,
          '--policy',
          policy,
        ],
        { SMITH_CROSSCHECK_OFFLINE: '' },
      );

      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.native_considered).toBe(0);
      expect(parsed.report.counts['independent-only']).toBe(1);
      expect(parsed.runs).toHaveLength(1);
      expect(parsed.runs[0].provider).toBe('codex');
      // Printed, never minted: which findings enter a gate is the operator's
      // call, and `smith findings raise` is where they make it.
      expect(parsed.raise).toHaveLength(1);
      expect(parsed.raise[0].finding.summary).toBe(evidence().summary);
      expect(parsed.raise[0].finding.found_by_provider).toBe('codex');
      expect(parsed.raise[0].filePath).toBe('src/b.ts');

      const log = readFileSync(path.join(eventsDir, `${sessionId}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(log.map((e) => e.event_type)).toContain('cross-finding-reconciled');
      expect(log.map((e) => e.event_type)).toContain('judge-verdict');
      expect(parsed.reconciled_event_id).toBe(`${sessionId}#${log.length - 1}`);
    });

    it('run refuses under the offline switch instead of finding nothing quietly', async () => {
      // SMITH_CROSSCHECK_OFFLINE is inherited from test/setup.ts here -- this
      // is the one test in the block that wants it. A skipped provider that
      // left no trace would read exactly like a finder that found nothing, so
      // the contract is that the verb fails and names who was skipped.
      const sessionId = `cli-crossfind-offline-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'crossfind-offline-events');
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

      const answerPath = await writeJson('cf-offline-answer.json', [evidence()]);
      const policy = await writePolicy('cf-offline.yml', { mode: 'active', answerPath });
      const diffPath = path.join(scratchDir, 'cf-offline.diff');
      await writeFile(diffPath, DIFF);

      const { stdout, status } = runCli([
        'crossfind',
        'run',
        '--task',
        'epic-1/task-1',
        '--diff',
        diffPath,
        '--diff-ref',
        'smith/epic-1/integration...task-1',
        '--session',
        sessionId,
        '--causal-parent',
        JSON.parse(start.stdout).event_id as string,
        '--state-dir',
        eventsDir,
        '--policy',
        policy,
      ]);

      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('crossfind.no-providers');
      expect(parsed.error.details.skipped).toEqual(['codex']);
    });

    it("run --project: reads the project overlay's provider over the policy file", async () => {
      // Same proof shape as `judge preflight --project` above, but for the
      // one crossfind subcommand an overlay can ever move: `request` and
      // `reconcile` only ever read `policy.independentFinder`, which
      // loadProjectProviderOverlay is structurally forbidden to touch (it
      // may only merge `providers`) -- only `run` hands runIndependentFinder
      // the full policy, `providers` included.
      const sessionId = `cli-crossfind-project-${Date.now()}`;
      const eventsDir = path.join(scratchDir, 'crossfind-project-events');
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
      const parent = JSON.parse(start.stdout).event_id as string;

      // The base policy's codex is disabled outright, same failure signature
      // as the offline-switch test above (`crossfind.no-providers`, `skipped:
      // ['codex']`) -- but this time nothing about the switch is involved.
      const answerPath = await writeJson('cf-project-answer.json', [evidence()]);
      const args = JSON.stringify([JUDGE_CLI, 'echo-prompt', answerPath]);
      const policy = path.join(scratchDir, 'cf-project.yml');
      await writeFile(
        policy,
        [
          'providers:',
          '  claude: { kind: native, enabled: true }',
          '  codex:',
          '    kind: api',
          '    transport: cli',
          '    command: node',
          `    args: ${args}`,
          '    model_tier: mid',
          '    enabled: false',
          '    mode: active',
          'independent_finder:',
          '  enabled: true',
          '  mode: active',
          '  providers: [codex]',
          '  send_diff: true',
          '  severity_resolution: highest-wins',
          '',
        ].join('\n'),
      );
      const diffPath = path.join(scratchDir, 'cf-project.diff');
      await writeFile(diffPath, DIFF);

      const baseArgs = [
        'crossfind',
        'run',
        '--task',
        'epic-1/task-1',
        '--diff',
        diffPath,
        '--diff-ref',
        'smith/epic-1/integration...task-1',
        '--session',
        sessionId,
        '--causal-parent',
        parent,
        '--state-dir',
        eventsDir,
        '--policy',
        policy,
      ];

      // No --project: codex stays disabled, same as the base policy says.
      const withoutProject = runCli(baseArgs, { SMITH_CROSSCHECK_OFFLINE: '' });
      expect(withoutProject.status).toBe(1);
      const withoutProjectParsed = JSON.parse(withoutProject.stdout);
      expect(withoutProjectParsed.error.code).toBe('crossfind.no-providers');
      expect(withoutProjectParsed.error.details.skipped).toEqual(['codex']);

      // --project points at an overlay that re-enables codex. Proves the CLI
      // reads --project and hands it to loadCrosscheckPolicy(), not just
      // that loadCrosscheckPolicy() itself supports a projectDir.
      const projectDir = path.join(scratchDir, 'cf-project-overlay');
      await mkdir(path.join(projectDir, '.blacksmith'), { recursive: true });
      await writeFile(
        path.join(projectDir, '.blacksmith', 'crosscheck.yml'),
        ['providers:', '  codex:', '    enabled: true', ''].join('\n'),
      );

      const withProject = runCli([...baseArgs, '--project', projectDir], {
        SMITH_CROSSCHECK_OFFLINE: '',
      });
      expect(withProject.status).toBe(1); // gates: true, same as the plain run test above
      const withProjectParsed = JSON.parse(withProject.stdout);
      expect(withProjectParsed.native_considered).toBe(0);
      expect(withProjectParsed.runs).toHaveLength(1);
      expect(withProjectParsed.runs[0].provider).toBe('codex');
      expect(withProjectParsed.raise).toHaveLength(1);
      expect(withProjectParsed.raise[0].finding.found_by_provider).toBe('codex');
    });

    it('run names a session that does not exist instead of reconciling against nothing', async () => {
      const policy = await writePolicy('cf-missing.yml', { mode: 'shadow' });
      const diffPath = path.join(scratchDir, 'cf-missing.diff');
      await writeFile(diffPath, DIFF);

      const { stdout, status } = runCli([
        'crossfind',
        'run',
        '--task',
        'epic-1/task-1',
        '--diff',
        diffPath,
        '--diff-ref',
        'ref',
        '--session',
        'no-such-session',
        '--causal-parent',
        'no-such-session#0',
        '--state-dir',
        path.join(scratchDir, 'crossfind-events'),
        '--policy',
        policy,
      ]);

      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('events.unknown-session');
    });
  });

  // Phase 10's watcher, driven the way an operator drives it. The unit tests
  // in daemon.test.ts own the folds; what is only true out here is the argv
  // wiring, the exit codes a health check reads, and the fact that a detached
  // `start` really does end up holding the lock.
  describe('daemon', () => {
    let daemonRoot: string;
    let n = 0;

    beforeAll(async () => {
      daemonRoot = await mkdtemp(path.join(tmpdir(), 'smith-cli-daemon-'));
    });

    afterAll(async () => {
      if (daemonRoot) await rm(daemonRoot, { recursive: true, force: true });
    });

    /** A fresh dir pair plus one session log, so a tick has something to read. */
    function fixture(): { dir: string; stateDir: string } {
      n += 1;
      const dir = path.join(daemonRoot, `d${n}`);
      const stateDir = path.join(daemonRoot, `e${n}`);
      mkdirSync(dir, { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        path.join(stateDir, 'sess-cli.jsonl'),
        `${JSON.stringify({
          event_id: 'sess-cli#0',
          record: {
            event_id: 'sess-cli#0',
            session_id: 'sess-cli',
            ts: '2026-08-20T00:00:00.000Z',
            event_type: 'session-start',
            actor: 'operator',
            causal_parent: null,
            payload: {},
          },
        })}\n`,
        'utf8',
      );
      return { dir, stateDir };
    }

    async function waitFor(predicate: () => boolean, ms = 10_000): Promise<boolean> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return predicate();
    }

    it('runs one tick, publishes it, and holds no lock afterwards', () => {
      const { dir, stateDir } = fixture();
      const { stdout, status } = runCli([
        'daemon',
        'run',
        '--once',
        '--dir',
        dir,
        '--state-dir',
        stateDir,
        '--no-db',
      ]);

      expect(status).toBe(0);
      const out = JSON.parse(stdout);
      expect(out.ticks).toBe(1);
      expect(out.last.sessions).toEqual(['sess-cli']);
      expect(JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8')).sessions).toEqual([
        'sess-cli',
      ]);
      // The invariant a --once run shares with a killed loop: the lock is the
      // daemon's, and a daemon that has exited does not have one.
      expect(existsSync(path.join(dir, 'daemon.pid'))).toBe(false);
    });

    // The loop used to answer only when it ended: one document, at exit, for a
    // process whose point is that it does not exit. So `daemon run` in the
    // foreground was blank for as long as it ran, and `daemon.log` -- which is
    // that same stdout, detached -- held nothing a `tail -f` could show.
    it('prints one report per tick as it runs, and a count with no report at the end', async () => {
      const { dir, stateDir } = fixture();
      const run = startProcess('node', [
        CLI_PATH,
        'daemon',
        'run',
        '--dir',
        dir,
        '--state-dir',
        stateDir,
        '--no-db',
        '--interval',
        '1',
      ]);
      try {
        // Two lines means two ticks, each one a whole TickReport: the first
        // lands before the first sleep, not after it.
        const ticks = await run.waitForLines(2);
        for (const line of ticks) expect(JSON.parse(line).sessions).toEqual(['sess-cli']);

        // `smith daemon stop` is SIGTERM. The lock goes with the process.
        const ended = await run.stop('SIGTERM');
        expect(ended.status).toBe(0);
        expect(ended.stderr).toBe('');
        expect(existsSync(path.join(dir, 'daemon.pid'))).toBe(false);

        // The closing line counts what was printed and repeats none of it:
        // `last` is the --once shape, where nothing else carried the report.
        const lines = run.lines();
        const closing = JSON.parse(lines[lines.length - 1] as string);
        expect(closing).toEqual({ ticks: lines.length - 1, dir });
      } finally {
        await run.stop('SIGKILL');
      }
    });

    // The behaviour the union rule ships: an operator who typed no --project
    // at all used to get an `unwatched-project` finding naming this clone
    // (the whole point of the fix); now they get none, restating nothing the
    // process did not already know.
    it('is in the pass by default, so an omitted --project raises no unwatched-project for it', () => {
      const { dir, stateDir } = fixture();
      const { status, stdout } = runCli([
        'daemon',
        'run',
        '--once',
        '--dir',
        dir,
        '--state-dir',
        stateDir,
        '--no-db',
      ]);
      expect(status).toBe(0);
      const findings = JSON.parse(stdout).last.findings as Array<{ kind: string; subject: string }>;
      expect(
        findings.filter((f) => f.kind === 'unwatched-project' && f.subject === REPO_ROOT),
      ).toEqual([]);
    });

    // `--no-self` accepted and honoured: excluding this clone still raises no
    // finding for it (suppressed, not merely uncounted).
    it('--no-self excludes this clone and still raises no finding for it', () => {
      const { dir, stateDir } = fixture();
      const { status, stdout } = runCli([
        'daemon',
        'run',
        '--once',
        '--dir',
        dir,
        '--state-dir',
        stateDir,
        '--no-db',
        '--no-self',
      ]);
      expect(status).toBe(0);
      const findings = JSON.parse(stdout).last.findings as Array<{ kind: string; subject: string }>;
      expect(
        findings.filter((f) => f.kind === 'unwatched-project' && f.subject === REPO_ROOT),
      ).toEqual([]);
    });

    it('exits 1 from `status` when nobody is watching, last tick and all', () => {
      const { dir, stateDir } = fixture();
      runOrThrow('node', [
        CLI_PATH,
        'daemon',
        'run',
        '--once',
        '--dir',
        dir,
        '--state-dir',
        stateDir,
        '--no-db',
      ]);

      const { stdout, status } = runCli(['daemon', 'status', '--dir', dir]);
      // Exit 1 is the contract a health check reads, so `smith daemon status
      // >/dev/null` is the whole probe -- no JSON parsing in a shell script.
      expect(status).toBe(1);
      const out = JSON.parse(stdout);
      expect(out.running).toBe(false);
      expect(out.lock).toBeNull();
      expect(out.lastTick.sessions).toEqual(['sess-cli']);
    });

    it('prints the unreadable-state error, not a report, over a corrupt lock', () => {
      const { dir } = fixture();
      const lockFile = path.join(dir, 'daemon.pid');
      writeFileSync(lockFile, '{ not json', 'utf8');

      const { stdout, status } = runCli(['daemon', 'status', '--dir', dir]);
      // Exit 1 either way -- "no daemon" exits 1 too -- so the exit code does
      // not tell the two apart. The output does: an error object naming the
      // file, never a `running: false` report.
      expect(status).toBe(1);
      const out = JSON.parse(stdout);
      expect(out.running).toBeUndefined();
      expect(out.error.code).toBe('daemon.unreadable-state');
      expect(out.error.details.path).toBe(lockFile);
    });

    it('fails the health check for a daemon that holds the lock and has gone quiet', () => {
      const { dir } = fixture();
      // This test process is, definitionally, a live pid -- so `running` is
      // true and `kill -0` says nothing is wrong. Nothing has ever ticked and
      // the lock is dated hours back, which is what a watcher wedged mid-tick
      // looks like from outside: up, holding its lock, and silent.
      writeFileSync(
        path.join(dir, 'daemon.pid'),
        `${JSON.stringify({
          pid: process.pid,
          startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
          intervalSeconds: 300,
        })}\n`,
        'utf8',
      );

      const { stdout, status } = runCli(['daemon', 'status', '--dir', dir]);
      const out = JSON.parse(stdout);
      expect(out.running).toBe(true);
      expect(out.stale).toBe(true);
      // The point of the whole change: `smith daemon status >/dev/null` was a
      // health check that passed for a watcher which had reported nothing
      // since Tuesday.
      expect(status).toBe(1);
    });

    it('starts a detached daemon that takes the lock, and stops it again', async () => {
      const { dir, stateDir } = fixture();
      const started = JSON.parse(
        runOrThrow('node', [
          CLI_PATH,
          'daemon',
          'start',
          '--dir',
          dir,
          '--state-dir',
          stateDir,
          '--no-db',
          '--interval',
          '3600',
        ]).stdout,
      );
      expect(started.started).toBe(true);
      expect(typeof started.pid).toBe('number');

      const lockFile = path.join(dir, 'daemon.pid');
      expect(await waitFor(() => existsSync(lockFile))).toBe(true);

      const live = JSON.parse(
        runOrThrow('node', [CLI_PATH, 'daemon', 'status', '--dir', dir]).stdout,
      );
      expect(live.running).toBe(true);
      // The child writes the lock under its own pid, which is the one `start`
      // reported -- `spawn` returns the process it made, not a shell's.
      expect(live.lock.pid).toBe(started.pid);

      const stopped = JSON.parse(
        runOrThrow('node', [CLI_PATH, 'daemon', 'stop', '--dir', dir]).stdout,
      );
      expect(stopped).toMatchObject({ stopped: true, pid: started.pid });
      expect(existsSync(lockFile)).toBe(false);
    });

    it('refuses a second daemon while one is alive', () => {
      const { dir, stateDir } = fixture();
      // This test process is, definitionally, a live pid.
      writeFileSync(
        path.join(dir, 'daemon.pid'),
        `${JSON.stringify({
          pid: process.pid,
          startedAt: '2026-08-20T00:00:00.000Z',
          intervalSeconds: 300,
        })}\n`,
        'utf8',
      );

      const { stdout, status } = runCli([
        'daemon',
        'start',
        '--dir',
        dir,
        '--state-dir',
        stateDir,
        '--no-db',
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('daemon.already-running');
    });

    it('clears the lock a crash left behind, without claiming it stopped anything', () => {
      const { dir } = fixture();
      // pid 2^22 is above every configured pid_max; nothing is there.
      writeFileSync(
        path.join(dir, 'daemon.pid'),
        `${JSON.stringify({
          pid: 4_194_304,
          startedAt: '2026-08-20T00:00:00.000Z',
          intervalSeconds: 300,
        })}\n`,
        'utf8',
      );

      const { stdout, status } = runCli(['daemon', 'stop', '--dir', dir]);
      expect(status).toBe(0);
      // `stopped: false` with a pid is the honest answer: the lock was stale,
      // and the operator learns the daemon was already gone rather than being
      // told this call is what ended it.
      expect(JSON.parse(stdout)).toEqual({ stopped: false, pid: 4_194_304 });
      expect(existsSync(path.join(dir, 'daemon.pid'))).toBe(false);
    });

    it('refuses an interval that is not a positive whole number of seconds', () => {
      const { dir } = fixture();
      const { stdout, status } = runCli([
        'daemon',
        'run',
        '--once',
        '--dir',
        dir,
        '--interval',
        '0',
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('cli.invalid-flag');
    });

    // A non-EPIPE stdout error (ENOSPC, say) is not innocuous like EPIPE, but
    // this process is not the only listener on it either: `daemon run`
    // registers its own `process.stdout.on('error', requestStop)` (cli.ts
    // ~2150) precisely so a write failure stops the loop instead of leaving
    // the lock behind for a process that is dying anyway. The global handler
    // (cli.ts ~4617) is registered before that one, at the top of the file's
    // entry point -- so if it rethrows every non-EPIPE error itself, its
    // throw fires first and `requestStop` never runs at all: an uncaught
    // exception outside `runDaemon`'s own try/finally (daemon.ts:1385-1397),
    // which skips the finally and strands the lock under a pid that is
    // already gone.
    //
    // A regular file opened read-only reproduces the real scenario
    // deterministically: `daemon start` (cli.ts ~2191) gives its detached
    // child's stdout a real file fd, exactly this stream type -- `process
    // .stdout` backed by a regular file writes through node's synchronous
    // `SyncWriteStream`, so a write a read-only fd cannot satisfy fails with
    // EBADF the same shape ENOSPC would, through the same code path, rather
    // than racing real disk exhaustion.
    it('a non-EPIPE stdout error during the loop stops it and releases the lock, instead of crashing', async () => {
      const { dir, stateDir } = fixture();
      const roFile = path.join(dir, 'readonly.log');
      writeFileSync(roFile, '', 'utf8');
      const fileFd = openSync(roFile, 'r');
      const child = spawn(
        'node',
        [
          CLI_PATH,
          'daemon',
          'run',
          '--dir',
          dir,
          '--state-dir',
          stateDir,
          '--no-db',
          '--interval',
          '1',
        ],
        { stdio: ['ignore', fileFd, 'pipe'] },
      );
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      try {
        const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
          (resolve) => {
            child.once('close', (code, sig) => resolve([code, sig]));
          },
        );

        expect(signal).toBeNull();
        expect(stderr).not.toMatch(/Uncaught|EBADF/);
        expect(code).toBe(0);
        // The invariant a killed loop shares with a `--once` run: the lock is
        // the daemon's, and a daemon that has exited does not have one.
        expect(existsSync(path.join(dir, 'daemon.pid'))).toBe(false);
      } finally {
        closeSync(fileFd);
      }
    }, 15000);
  });
});

// ---------------------------------------------------------------------------
// `smith init` -- the one verb that exists because installing is not cloning.
//
// It is the first command an operator who ran `npx @juzser/blacksmith` types,
// so a parse failure in it is the whole product failing on contact. Two things
// are worth an end-to-end test rather than a unit one: that a namespace with
// no action word reaches its arm at all, and that `--work-root` is a flag the
// argv splitter knows takes a value. Both are derived rather than declared --
// from `splitNamespaceAction` and from the usage table's flag string -- and
// neither is visible to a test of `initWorkRoot`, which never sees argv.
// ---------------------------------------------------------------------------

describe('smith init (built binary)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-init-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // The sandbox (project + isolated HOME) sits beside the work root it serves.
  const initIn = (workRoot: string, extraEnv: Record<string, string> = {}) => {
    const sandbox = sandboxFor(`${workRoot}-sandbox`);
    return runCli(
      ['init', '--work-root', workRoot],
      { ...sandbox.env, ...extraEnv },
      undefined,
      sandbox.project,
    );
  };

  it('prepares a work root, and says what it did to every file', () => {
    const workRoot = path.join(root, 'first');
    const { stdout, status } = initIn(workRoot);
    expect(status).toBe(0);

    const report = JSON.parse(stdout);
    expect(report.workRoot).toBe(workRoot);
    expect(report.inPlace).toBe(false);
    expect(report.gitignore).toBe('written');

    for (const rel of report.directories as string[]) {
      expect(existsSync(path.join(workRoot, rel)), `${rel} was reported and not created`).toBe(
        true,
      );
    }
    expect((report.files as { status: string }[]).length).toBeGreaterThan(1);
    for (const file of report.files as { personal: string; status: string }[]) {
      expect(file.status).toBe('seeded');
      expect(existsSync(file.personal)).toBe(true);
    }
  });

  it('is idempotent, and keeps an answer the operator already typed', () => {
    const workRoot = path.join(root, 'second');
    expect(initIn(workRoot).status).toBe(0);

    const answered = (
      JSON.parse(initIn(workRoot).stdout).files as {
        personal: string;
      }[]
    ).find((file) => file.personal.endsWith('stack.yml'));
    expect(answered).toBeDefined();
    writeFileSync((answered as { personal: string }).personal, 'language: rust\n', 'utf8');

    const { stdout, status } = initIn(workRoot);
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.gitignore).toBe('kept');
    for (const file of report.files as { status: string }[]) {
      expect(file.status).toBe('kept');
    }
    expect(readFileSync((answered as { personal: string }).personal, 'utf8')).toBe(
      'language: rust\n',
    );
  });

  describe('Claude Code settings hint on session start', () => {
    const HINT = 'Claude Code settings for this project are out of date';
    const sandboxes = new Map<string, ReturnType<typeof sandboxFor>>();
    const sandboxOf = (home: string) => {
      const sandbox = sandboxes.get(home) ?? sandboxFor(`${home}-sandbox`);
      sandboxes.set(home, sandbox);
      return sandbox;
    };
    // The hint is switched on explicitly (the helper switches it off), in a temp
    // project with an isolated HOME, so nothing real is read.
    const start = (home: string, id: string, cwd?: string) => {
      const sandbox = sandboxOf(home);
      return runCli(
        ['session', 'start', id, '--state-dir', path.join(home, 'events')],
        { ...sandbox.env, BS_HOME: home, BS_NO_SETTINGS_HINT: '' },
        undefined,
        cwd ?? sandbox.project,
      );
    };
    // The record sits in the project's own .claude/, as bs init leaves it.
    const recordFor = (home: string, revision: number, written: Record<string, unknown> = {}) => {
      const sandbox = sandboxOf(home);
      mkdirSync(path.join(sandbox.project, '.claude'), { recursive: true });
      writeFileSync(
        path.join(sandbox.project, '.claude', 'bs-settings-record.json'),
        JSON.stringify({ revision, written }),
      );
      return sandbox;
    };

    it('prints one stderr line when there is no record, and leaves stdout as the receipt', () => {
      const home = path.join(root, 'hint-none');
      const { stdout, stderr, status } = start(home, `hint-none-${Date.now()}`);

      expect(status).toBe(0);
      expect(stderr.split('\n').filter((line) => line.includes(HINT))).toHaveLength(1);
      expect(stderr).toContain('run `bs init` in');
      expect(JSON.parse(stdout).record.event_type).toBe('session-start');
    });

    it('prints nothing once this project is current, and again when it is older', () => {
      const home = path.join(root, 'hint-current');
      recordFor(home, CLAUDE_SETTINGS_REVISION);
      expect(start(home, `hint-cur-${Date.now()}`).stderr).not.toContain(HINT);

      recordFor(home, CLAUDE_SETTINGS_REVISION - 1);
      expect(start(home, `hint-old-${Date.now()}`).stderr).toContain(HINT);
    });

    it('names the package that holds the record and says to remove, then restart', () => {
      const home = path.join(root, 'hint-package');
      const sandbox = sandboxOf(home);
      const app = path.join(sandbox.project, 'packages', 'app');
      mkdirSync(path.join(app, '.claude'), { recursive: true });
      mkdirSync(path.join(app, 'src'));
      writeFileSync(
        path.join(app, '.claude', 'bs-settings-record.json'),
        JSON.stringify({ revision: CLAUDE_SETTINGS_REVISION - 1, written: {} }),
      );

      const { stderr } = start(home, `hint-pkg-${Date.now()}`, path.join(app, 'src'));

      expect(stderr).toContain(`run \`bs init\` in ${realpathSync(app)}, then restart Claude Code`);
    });

    it('is off by default in the shared helper, whatever the project holds', () => {
      const home = path.join(root, 'hint-off');
      const sandbox = sandboxOf(home);

      const { stderr } = runCli(
        ['session', 'start', `hint-off-${Date.now()}`, '--state-dir', path.join(home, 'events')],
        { ...sandbox.env, BS_HOME: home },
        undefined,
        sandbox.project,
      );

      expect(stderr).not.toContain(HINT);
    });

    it('stays quiet in a subdirectory of an initialised project, and names the root otherwise', () => {
      const home = path.join(root, 'hint-subdir');
      const sandbox = recordFor(home, CLAUDE_SETTINGS_REVISION);
      mkdirSync(path.join(sandbox.project, '.git'));
      const sub = path.join(sandbox.project, 'packages', 'a');
      mkdirSync(sub, { recursive: true });
      expect(start(home, `hint-sub-${Date.now()}`, sub).stderr).not.toContain(HINT);

      recordFor(home, CLAUDE_SETTINGS_REVISION - 1);
      const { stderr } = start(home, `hint-sub2-${Date.now()}`, sub);
      expect(stderr).toContain(HINT);
      expect(stderr).toContain(`run \`bs init\` in ${realpathSync(sandbox.project)}`);
    });

    it('says the user setting is overridden while bs lines and a user value coexist', () => {
      const home = path.join(root, 'hint-overridden');
      const sandbox = recordFor(home, CLAUDE_SETTINGS_REVISION, { autoCompactWindow: 633000 });
      writeFileSync(
        path.join(sandbox.project, '.claude', 'settings.local.json'),
        JSON.stringify({ autoCompactWindow: 633000 }),
      );
      mkdirSync(path.join(sandbox.env.HOME as string, '.claude'), { recursive: true });
      writeFileSync(
        path.join(sandbox.env.HOME as string, '.claude', 'settings.json'),
        JSON.stringify({ autoCompactWindow: 800000 }),
      );

      const { stdout, stderr, status } = start(home, `hint-over-${Date.now()}`);

      expect(status).toBe(0);
      expect(stderr).toContain('overridden');
      expect(stderr).not.toContain(HINT);
      expect(JSON.parse(stdout).record.event_type).toBe('session-start');
    });

    it('init reports the window outcome and writes the record, in the temp project only', () => {
      const home = path.join(root, 'hint-init');
      const { stdout } = initIn(home, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000' });

      const report = JSON.parse(stdout);
      expect(report.claudeWindow.status).toBe('skipped');
      expect(report.claudeWindow.settingsPath).toBe(
        path.join(
          realpathSync(path.join(`${home}-sandbox`, 'project')),
          '.claude',
          'settings.local.json',
        ),
      );
      expect(
        existsSync(path.join(`${home}-sandbox`, 'project', '.claude', 'bs-settings-record.json')),
      ).toBe(true);
      expect(existsSync(path.join(home, 'state', 'claude-settings.json'))).toBe(false);
    });

    it('init says on stderr when it could not write the window, and keeps the hint alive', () => {
      const home = path.join(root, 'hint-failed');
      const sandbox = sandboxFor(`${home}-sandbox`);
      writeFileSync(path.join(sandbox.project, '.claude'), 'not a directory');

      const result = initIn(home);

      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/could not write autoCompactWindow/);
      expect(start(home, `hint-failed-${Date.now()}`).stderr).toContain(HINT);
    });

    it('init says on stderr when the local settings are not a JSON object', () => {
      const home = path.join(root, 'hint-unreadable');
      const sandbox = sandboxFor(`${home}-sandbox`);
      mkdirSync(path.join(sandbox.project, '.claude'), { recursive: true });
      writeFileSync(path.join(sandbox.project, '.claude', 'settings.local.json'), '[]');

      const result = initIn(home);

      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/is not a JSON object/);
    });
  });

  it('is listed in the usage table it is dispatched from', () => {
    // Not just `init` -- `mcp init` would satisfy that. The flag is named
    // because a value-taking flag the splitter does not know about is how
    // `--work-root /tmp/x` silently becomes a work root of `--work-root`.
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('bs init [--work-root');
  });
});

// ---------------------------------------------------------------------------
// stdout closed early (EPIPE) -- `smith <verb> | head -c1` (or any reader
// that goes away before draining stdout) closes the pipe out from under a
// write that has already committed whatever the verb was reporting. Crashing
// on it after the fact is a false failure: an uncaught EPIPE prints a stack
// and exits non-zero, and a caller that retries a non-zero status
// double-appends the very event the write had already recorded.
//
// This closes the child's own stdout read end deterministically -- the
// instant the child is spawned, well before its Node startup even finishes,
// let alone reaches the `--help` write -- rather than racing a real `head`
// process over how many bytes it reads before exiting. Same condition a
// `| true` shell pipeline creates, without the byte-count race `head -c1`
// itself would add.
// ---------------------------------------------------------------------------

describe('cli.ts stdout closed early (EPIPE)', () => {
  it('exits clean, with no uncaught EPIPE stack on stderr, when the reader is already gone', async () => {
    const child = spawn('node', [CLI_PATH, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.destroy();

    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once('close', (code, sig) => resolve([code, sig]));
    });

    expect(signal).toBeNull();
    expect(stderr).not.toMatch(/EPIPE/);
    expect(code).toBe(0);
  });
});
