import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The one src import in a file that otherwise drives only the built binary,
// and it is a policy READER rather than anything under test: an assertion
// about the coder cap that reads budgets.yml through the same loader the
// binary uses cannot drift away from the file when the cap is retuned.
import { loadBudgetPolicy } from '../src/budgets.js';
import { assertExited, runOrThrow, runProcess } from './helpers/process.js';

// cli.ts is thin argv->module wiring (excluded from the coverage floor, like
// UI glue per stack.md); it is verified end-to-end here as a built binary,
// the way it actually runs (`smith <ns> <action> ...`).
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');

// `status` stays a number for the assertions below, but a child killed by a
// signal never reaches them: it throws first, naming the signal. The previous
// `e.status ?? 1` turned a SIGSEGV into a plain exit 1, so a segfaulting
// runtime read as three ordinary assertion failures about `0` and cost a full
// false diagnosis (D-47).
// `stdin` is third rather than folded into a single opts bag so the dozens of
// existing `runCli(args, envOverrides)` callers keep their shape; only the
// verbs that read fd 0 (`prompt wrap -`, `prompt record -`) pass it.
function runCli(
  args: string[],
  envOverrides?: Record<string, string>,
  stdin?: string,
): { stdout: string; stderr: string; status: number } {
  const run = runProcess('node', [CLI_PATH, ...args], {
    ...(envOverrides ? { env: { ...process.env, ...envOverrides } } : {}),
    ...(stdin === undefined ? {} : { input: stdin }),
  });
  assertExited(run, `smith ${args.join(' ')}`);
  return { stdout: run.stdout, stderr: run.stderr, status: run.status as number };
}

describe('cli.ts (built binary)', () => {
  let scratchDir: string;

  // dist/ is built once for the whole run by test/globalSetup.ts, not here:
  // guardHook.test.ts execs the same binary, and two parallel vitest workers
  // emitting into one dist/ while a third reads it is a race.
  beforeAll(async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), 'smith-cli-'));
  });

  afterAll(async () => {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  /**
   * A worktree the gate will actually score: on its own task branch, one
   * commit ahead of the base, nothing uncommitted. Since D-30/P9-8 the gate
   * certifies the commit before it runs a single check, so a bare scratch
   * directory now blocks every gate run with `not-committed` — every describe
   * that shells out to `gate run` needs this, not just P9-8's own tests.
   */
  async function committedWorktree(name: string): Promise<string> {
    const dir = path.join(scratchDir, 'wt', name);
    await mkdir(dir, { recursive: true });
    const git = (args: string[]) => runOrThrow('git', args, { cwd: dir });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await writeFile(path.join(dir, 'README.md'), '# repo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    git(['checkout', '-q', '-b', `smith/epic-1/${name}`]);
    await writeFile(path.join(dir, 'src.ts'), 'export const x = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'task work']);
    return dir;
  }

  it('plan validate: exits 0 and reports valid:true for a good plan', async () => {
    const planPath = path.join(scratchDir, 'plan.json');
    await writeFile(
      planPath,
      JSON.stringify({
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [
          {
            task_id: 'epic-1/task-1',
            epic_id: 'epic-1',
            plan_version: 1,
            objective: 'Do the thing.',
            output_schema_ref: 'result.schema.json',
            acceptance_criteria: ['it works'],
            claims: ['src/foo/**'],
            budget: { tokens: 1000, diff_lines: 100 },
            contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
            case: 'feature',
            origin: 'user',
            task_status: 'todo',
          },
        ],
        edges: [],
      }),
    );

    const { stdout, status } = runCli(['plan', 'validate', planPath]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ valid: true });
  });

  it('plan validate: exits 1 and reports errors for a bad plan', async () => {
    const planPath = path.join(scratchDir, 'bad-plan.json');
    await writeFile(
      planPath,
      JSON.stringify({ epic_id: 'epic-1', version: 1, status: 'active', tasks: [{}], edges: [] }),
    );

    const { stdout, status } = runCli(['plan', 'validate', planPath]);
    expect(status).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it('unknown command exits 1 with an error envelope', () => {
    const { stdout, status } = runCli(['not', 'a-command']);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).error.message).toContain('Unknown command');
  });

  // P9-21: `smith` and `smith --help` both answered `{"error":{"message":
  // "Unknown command: "}}`, so every command's argument shape had to be read
  // out of cli.ts or SKILL.md.
  describe('usage', () => {
    it('--help exits 0 and prints the command list on stdout', () => {
      const { stdout, status } = runCli(['--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('smith plan validate <plan.json>');
      expect(stdout).toContain('gate run');
      expect(stdout).toContain('stats providers');
    });

    it('bare `smith` exits 1 with the same text, on stderr', () => {
      const help = runCli(['--help']);
      const bare = runCli([]);
      expect(bare.status).toBe(1);
      expect(bare.stderr).toBe(help.stdout);
    });

    it('an unknown command prints usage on stderr and keeps the JSON envelope on stdout', () => {
      // Prose on stderr so a human sees it; stdout stays parseable for the
      // callers that already read the error envelope.
      const { stdout, stderr, status } = runCli(['not', 'a-command']);
      expect(status).toBe(1);
      expect(stderr).toContain('smith plan validate <plan.json>');
      expect(JSON.parse(stdout).error.message).toContain('Unknown command: not a-command');
    });

    it('an unknown action under a real namespace names that namespace', () => {
      const { stdout, stderr, status } = runCli(['plan', 'teleport']);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.message).toContain('Unknown command: plan teleport');
      expect(stderr).toContain('plan validate');
      expect(stderr).not.toContain('gate run');
    });

    it('`smith <ns> --help` lists only that namespace, exit 0', () => {
      const { stdout, status } = runCli(['plan', '--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('plan quorum');
      expect(stdout).not.toContain('gate run');
    });

    it('`smith help` is the same as `smith --help`', () => {
      expect(runCli(['help']).stdout).toBe(runCli(['--help']).stdout);
    });

    it('--help on a real command shows that command, not the whole list', () => {
      const { stdout, status } = runCli(['gate', 'run', '--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('smith gate run');
      expect(stdout).not.toContain('plan validate');
    });

    it('a missing positional names the argument and prints the line that would have worked', () => {
      const { stdout, status } = runCli(['plan', 'validate']);
      expect(status).toBe(1);
      const err = JSON.parse(stdout).error;
      expect(err.code).toBe('cli.missing-positional');
      expect(err.message).toContain('<plan.json>');
      expect(err.message).toContain('smith plan validate <plan.json>');
    });
  });

  it('plan quorum: rejects an unparseable --confidence instead of failing open', () => {
    // NaN < threshold is false, so a typo'd confidence would silently disable
    // plan_quorum's third trigger rather than firing it (planQuorum.ts).
    const { stdout, status } = runCli([
      'plan',
      'quorum',
      '--epic',
      'epic-1',
      '--plan-version',
      '1',
      '--confidence',
      '0,7',
    ]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).error.message).toContain('--confidence must be a number');
  });

  it('plan quorum: critiques the plan version it logs, not a second reading of the flag', () => {
    // D-211. `plan quorum` read --plan-version twice with two parsers that
    // disagree: Number.parseInt chose the plan FILE, boundedIntFlag (via
    // eventContextFromFlags) chose the plan_version stamped on every event the
    // command appends. D-210's rule for the same notation is asserted below in
    // the --round block -- "1e2 is an unambiguous numeric literal for 100" --
    // so `--plan-version 1e2` critiqued v1 while the log said v100, and nothing
    // errored. The file it goes looking for is the observable half.
    const { stdout, status } = runCli([
      'plan',
      'quorum',
      '--epic',
      'epic-no-such-plan',
      '--plan-version',
      '1e2',
      '--session',
      'cli-plan-quorum-version',
      '--causal-parent',
      'root',
    ]);
    expect(status).toBe(1);
    const err = JSON.parse(stdout).error;
    expect(err.code).toBe('plan.not-found');
    expect(err.details.version).toBe(100);
    expect(err.message).toContain('plan-v100.json');
  });

  // P9-28: `cli.ts` validated flags with requireFlag and positionals not at
  // all — `positional[0] as string` is a cast, not a check. The worst of it was
  // `event tail` with no session id: it printed `[]` and exited 0, so *you
  // forgot the argument*, *no such session* and *the session is empty* were one
  // observable state, and it was the success one. The verb an operator reaches
  // for when unsure what the log holds answered "your log is empty".
  describe('a missing argument must fail, not succeed empty (P9-28)', () => {
    it('event tail with no session id names the argument instead of printing []', () => {
      const { stdout, status } = runCli(['event', 'tail']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.message).toContain('session-id');
      expect(parsed.error.message).toContain('smith event tail');
    });

    it('event tail on a session that has no log is an error, not an empty array', () => {
      const eventsDir = path.join(scratchDir, 'events');
      const { stdout, status } = runCli([
        'event',
        'tail',
        'no-such-session-p9-28',
        '--state-dir',
        eventsDir,
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('events.unknown-session');
      expect(parsed.error.message).toContain('no-such-session-p9-28');
    });

    it('plan validate with no plan file reports the usage, not a filesystem error', () => {
      const { stdout, status } = runCli(['plan', 'validate']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.message).toContain('plan.json');
    });

    it('worktree stale names the one positional that is missing, not both', () => {
      const { stdout, status } = runCli(['worktree', 'stale', '/tmp/some-project']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      // The usage line names both, as it should; what must name only the
      // missing one is the error itself.
      expect(parsed.error.details.missing).toEqual(['epic']);
      expect(parsed.error.message).toContain('smith worktree stale <project-dir> <epic>');
    });

    it('findings transition reports the missing positional before the missing flag', () => {
      // Argument order is the reading order: a usage error should name the
      // first thing wrong on the line, and the positionals come first.
      const { stdout, status } = runCli(['findings', 'transition', 'F-1']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.message).toContain('status');
      expect(parsed.error.details.missing).toEqual(['status']);
      // --session is missing too, and since P9-21 the usage line names it —
      // which is the point of printing the flags. What must not happen is
      // reporting the flag as THE error while a positional is still absent.
      expect(parsed.error.message).not.toContain('Missing required flag');
    });

    // D-136. Both amendment edges need an argument the command line has no way
    // to carry — `amendsTaskIds` for one, `amendsSatisfiedBy` for the other —
    // so every invocation naming them failed five guards deep, with a message
    // about task ids the operator was never offered a way to name. It read as
    // a bug in the command rather than as a command that cannot do this.
    describe('findings transition: the amendment edges are not typeable (D-136)', () => {
      it('refuses amend-pending by naming the command that can take it', () => {
        const { stdout, status } = runCli(['findings', 'transition', 'F-1', 'amend-pending']);
        expect(status).toBe(1);
        const parsed = JSON.parse(stdout);
        expect(parsed.error.code).toBe('cli.amendment-edge-unreachable');
        expect(parsed.error.message).toContain('smith plan amend');
        expect(parsed.error.details.status).toBe('amend-pending');
      });

      it('refuses amended by naming the command that can take it', () => {
        const { stdout, status } = runCli(['findings', 'transition', 'F-1', 'amended']);
        expect(status).toBe(1);
        const parsed = JSON.parse(stdout);
        expect(parsed.error.code).toBe('cli.amendment-edge-unreachable');
        expect(parsed.error.message).toContain('smith epic close');
      });

      it('refuses before it reads the log, and writes nothing', () => {
        // A full, well-formed command line against a real session. The refusal
        // is about the command, not about the finding — which is why it fires
        // for a finding id no log contains, and why the log is untouched after.
        const sessionId = `cli-d136-${Date.now()}`;
        const eventsDir = path.join(scratchDir, 'events-d136');
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

        const { stdout, status } = runCli([
          'findings',
          'transition',
          'no-such-finding',
          'amend-pending',
          '--session',
          sessionId,
          '--causal-parent',
          parent,
          '--state-dir',
          eventsDir,
        ]);
        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('cli.amendment-edge-unreachable');

        const tail = runCli(['event', 'tail', sessionId, '--state-dir', eventsDir]);
        expect(JSON.parse(tail.stdout)).toHaveLength(1);
      });

      it('still moves a finding along an edge the command line CAN carry', () => {
        // The refusal is scoped to the two amendment edges; the rest of the
        // transition table stays reachable, or this fix would be a regression
        // dressed as a correction.
        const sessionId = `cli-d136-ok-${Date.now()}`;
        const eventsDir = path.join(scratchDir, 'events-d136-ok');
        const append = (event: Record<string, unknown>): string => {
          const run = runCli(['event', 'append', JSON.stringify(event), '--state-dir', eventsDir]);
          expect(run.status, run.stdout).toBe(0);
          return JSON.parse(run.stdout).event_id as string;
        };
        const parent = append({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        });
        append({
          session_id: sessionId,
          actor: 'reviewer',
          event_type: 'finding-raised',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: parent,
          payload: {
            finding_id: 'f-d136',
            fingerprint: 'fp-d136',
            task_id: 'epic-1/task-1',
            file_path: 'src/foo.ts',
            severity: 'S2-major',
            finding_category: 'correctness',
            finding_status: 'raised',
            summary: 'a finding on the ordinary path',
            failure_scenario: {
              inputs: 'foo("")',
              expected: 'a parse error',
              actual: 'undefined',
            },
            found_by: 'reviewer',
          },
        });

        const { stdout, status } = runCli([
          'findings',
          'transition',
          'f-d136',
          'confirmed',
          '--session',
          sessionId,
          '--causal-parent',
          parent,
          '--state-dir',
          eventsDir,
        ]);
        expect(status, stdout).toBe(0);
        expect(JSON.parse(stdout).finding_status).toBe('confirmed');
      });
    });

    // D-21 Part 4: the CLI wiring for repairObligation -- a fresh session
    // built the same way the D-136 fixture above is, so this exercises the
    // real dispatch (namespace/action, flag parsing) rather than the library
    // function directly.
    describe('findings repair-obligation (D-21 Part 4)', () => {
      function appendVia(eventsDir: string) {
        return (event: Record<string, unknown>): string => {
          const run = runCli(['event', 'append', JSON.stringify(event), '--state-dir', eventsDir]);
          expect(run.status, run.stdout).toBe(0);
          return JSON.parse(run.stdout).event_id as string;
        };
      }

      it('repairs a malformed obligation and prints the corrected finding', () => {
        const sessionId = `cli-repair-${Date.now()}`;
        const eventsDir = path.join(scratchDir, 'events-repair-ok');
        const append = appendVia(eventsDir);
        const root = append({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        });
        append({
          session_id: sessionId,
          actor: 'reviewer',
          event_type: 'finding-raised',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: {
            finding_id: 'f-repair-cli',
            fingerprint: 'fp-repair-cli',
            task_id: 'epic-1/task-1',
            file_path: 'src/foo.ts',
            severity: 'S2-major',
            finding_category: 'correctness',
            finding_status: 'raised',
            finding_scope: 'spec',
            summary: 'plan v1 asked for the wrong thing',
            failure_scenario: { inputs: 'n/a', expected: 'n/a', actual: 'n/a' },
            found_by: 'reviewer',
          },
        });
        const pending = append({
          session_id: sessionId,
          actor: 'operator',
          event_type: 'finding-transitioned',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: {
            finding_id: 'f-repair-cli',
            fingerprint: 'fp-repair-cli',
            from_status: 'raised',
            to_status: 'amend-pending',
            amends_task_ids: [null, 'epic-1/task-2'],
            amends_plan_version: 2,
          },
        });

        const { stdout, status } = runCli([
          'findings',
          'repair-obligation',
          'f-repair-cli',
          '--replace-with',
          'epic-1/task-2',
          '--reason',
          'dropped the null entry a malformed plan amend wrote',
          '--session',
          sessionId,
          '--causal-parent',
          pending,
          '--state-dir',
          eventsDir,
        ]);
        expect(status, stdout).toBe(0);
        const finding = JSON.parse(stdout);
        expect(finding.amends_task_ids).toEqual(['epic-1/task-2']);
        expect(finding.obligation_repair_reason).toBe(
          'dropped the null entry a malformed plan amend wrote',
        );
      });

      it('reports a guard refusal (repair-would-empty) rather than a raw stack', () => {
        const sessionId = `cli-repair-empty-${Date.now()}`;
        const eventsDir = path.join(scratchDir, 'events-repair-empty');
        const append = appendVia(eventsDir);
        const root = append({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        });
        append({
          session_id: sessionId,
          actor: 'reviewer',
          event_type: 'finding-raised',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: {
            finding_id: 'f-repair-empty',
            fingerprint: 'fp-repair-empty',
            task_id: 'epic-1/task-1',
            file_path: 'src/foo.ts',
            severity: 'S2-major',
            finding_category: 'correctness',
            finding_status: 'raised',
            finding_scope: 'spec',
            summary: 'plan v1 asked for the wrong thing',
            failure_scenario: { inputs: 'n/a', expected: 'n/a', actual: 'n/a' },
            found_by: 'reviewer',
          },
        });
        const pending = append({
          session_id: sessionId,
          actor: 'operator',
          event_type: 'finding-transitioned',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: {
            finding_id: 'f-repair-empty',
            fingerprint: 'fp-repair-empty',
            from_status: 'raised',
            to_status: 'amend-pending',
            amends_task_ids: [null, 'epic-1/task-2'],
            amends_plan_version: 2,
          },
        });

        const { stdout, status } = runCli([
          'findings',
          'repair-obligation',
          'f-repair-empty',
          '--replace-with',
          '',
          '--reason',
          'valid reason',
          '--session',
          sessionId,
          '--causal-parent',
          pending,
          '--state-dir',
          eventsDir,
        ]);
        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('findings.repair-would-empty');
      });

      // D-21 Part 4 review finding (S4 behavioral-drift): the CLI's
      // --replace-with parser used to comma-split, trim, AND filter out
      // empty tokens before ever calling repairObligation -- so guard 6
      // ("every replacement id is a non-empty string") was implemented and
      // unit-tested but unreachable through the shipped interface. An
      // operator typing "a,,b" (a stray double comma) got silent filtering
      // to ['a', 'b'] instead of the named refusal. This goes through the
      // real CLI dispatch, not repairObligation directly -- a function-level
      // test is exactly what already existed and exactly what missed this.
      it('lets guard 6 see a stray empty entry from a double comma, rather than silently filtering it', () => {
        const sessionId = `cli-repair-doublecomma-${Date.now()}`;
        const eventsDir = path.join(scratchDir, 'events-repair-doublecomma');
        const append = appendVia(eventsDir);
        const root = append({
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        });
        append({
          session_id: sessionId,
          actor: 'reviewer',
          event_type: 'finding-raised',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: {
            finding_id: 'f-repair-doublecomma',
            fingerprint: 'fp-repair-doublecomma',
            task_id: 'epic-1/task-1',
            file_path: 'src/foo.ts',
            severity: 'S2-major',
            finding_category: 'correctness',
            finding_status: 'raised',
            finding_scope: 'spec',
            summary: 'plan v1 asked for the wrong thing',
            failure_scenario: { inputs: 'n/a', expected: 'n/a', actual: 'n/a' },
            found_by: 'reviewer',
          },
        });
        const pending = append({
          session_id: sessionId,
          actor: 'operator',
          event_type: 'finding-transitioned',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: root,
          payload: {
            finding_id: 'f-repair-doublecomma',
            fingerprint: 'fp-repair-doublecomma',
            from_status: 'raised',
            to_status: 'amend-pending',
            amends_task_ids: [null, 'epic-1/task-2'],
            amends_plan_version: 2,
          },
        });

        const { stdout, status } = runCli([
          'findings',
          'repair-obligation',
          'f-repair-doublecomma',
          '--replace-with',
          'epic-1/task-2,,',
          '--reason',
          'valid reason',
          '--session',
          sessionId,
          '--causal-parent',
          pending,
          '--state-dir',
          eventsDir,
        ]);
        expect(status).toBe(1);
        expect(JSON.parse(stdout).error.code).toBe('findings.repair-replacement-not-string');
      });
    });

    it('an empty argument is missing, not present — an unset shell variable is a typo too', () => {
      const { stdout, status } = runCli(['gate', 'run', '']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.details.missing).toEqual(['task-id']);
    });

    it('smith new with no project name reports a missing argument, not a missing flag', () => {
      const { stdout, status } = runCli(['new']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.details.missing).toEqual(['project']);
    });

    it('smith mcp init with no project name reports a missing argument', () => {
      const { stdout, status } = runCli(['mcp', 'init']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.details.missing).toEqual(['project']);
    });

    // "Your surface is broken" and "you have no surface" are different answers.
    // Reporting the second as a red would let `smith mcp init` be skipped and
    // then waived away as just another violation.
    it('smith mcp check on a project with no surface refuses rather than reporting a red', () => {
      const targetDir = path.join(scratchDir, 'wt', 'cli-mcp-unscaffolded');
      const { stdout, status } = runCli([
        'mcp',
        'check',
        'cli-mcp-unscaffolded',
        '--target-dir',
        targetDir,
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('mcp.no-surface');
    });

    it('db rebuild --session on a session with no log refuses instead of building an empty db', () => {
      const { stdout, status } = runCli([
        'db',
        'rebuild',
        '--db',
        path.join(scratchDir, 'p9-28-rebuild.sqlite'),
        '--session',
        'no-such-session-p9-28',
        '--state-dir',
        path.join(scratchDir, 'events'),
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('events.unknown-session');
    });

    it('queue run without --project refuses instead of running git in an undefined directory', () => {
      const { stdout, status } = runCli(['queue', 'run', 'epic-1']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-flag');
      expect(parsed.error.message).toContain('--project');
    });
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
  // `--input-tokens`/`--output-tokens` go through requireIntFlag.
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
      expect(second.stderr).toContain('smith session start');
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
      expect(parsed.error.details.usage).toContain('smith event tail');
      expect(parsed.error.details.usage).toContain('--lineage');
    });

    it('still prints help for a command carrying a bad flag', () => {
      const { status, stdout } = runCli(['event', 'tail', '--help', '--nonsense']);
      expect(status).toBe(0);
      expect(stdout).toContain('smith event tail');
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
      expect(parsed.error.details.usage).toContain('smith event tail');
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
      expect(stdout).toContain('smith event tail');
    });

    // D-139 itself: the documented invocation must not fail on a flag the
    // usage line never mentioned.
    it('documents every flag epic spec-review requires', () => {
      const { stdout, status } = runCli(['epic', 'spec-review', '--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('--reviewed-by');
    });
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
      expect(parsed.error.message).toContain('smith dispatch check');
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

    const append2 = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'planner',
        event_type: 'dispatch_decision',
        task_id: 'epic-9/task-1',
        plan_version: 1,
        causal_parent: rootId,
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
      eventsApplied: 2,
      skippedFindings: [],
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
    // Both appended events, and no task-added — this session never had one.
    // The old assertion here was `toHaveLength(1)`: session-start was written
    // as the root of the log and then dropped by timeline()'s eventType
    // filter, so the CLI's own smoke test recorded the log's first event as
    // invisible. Asserting the types rather than the count says which two.
    expect(
      (JSON.parse(timelineResult.stdout) as { eventType: string }[]).map((e) => e.eventType),
    ).toEqual(['session-start', 'dispatch_decision']);

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
    // The task id carries its epic, so `--epic epic-9` finds this task even
    // though no `task-added` ever named the epic in a payload (D-49/P9-10).
    // Before that, a dispatched task showed up in `stats overview` as a live
    // agent and in `stats kanban --epic` as nothing at all.
    const kanban = JSON.parse(kanbanResult.stdout) as Array<{
      taskStatus: string;
      tasks: Array<{ taskId: string }>;
    }>;
    expect(kanban).toHaveLength(1);
    expect(kanban[0]?.taskStatus).toBe('in-progress');
    expect(kanban[0]?.tasks.map((t) => t.taskId)).toEqual(['epic-9/task-1']);

    // dispatch_decision alone (no task-added) still touches a minimal task
    // row (task_status "in-progress"), just without case/origin/claims.
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
    expect(JSON.parse(lessonsResult.stdout)).toEqual({ pending: [], approved: [], closed: [] });

    const errorsResult = runCli(['stats', 'errors', '--db', dbPath, '--session', sessionId]);
    expect(errorsResult.status).toBe(0);
    expect(JSON.parse(errorsResult.stdout)).toEqual({ byClass: [], byDay: [] });

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
      eventsApplied: 2,
      skippedFindings: [],
    });
  });

  /**
   * Both db verbs rebuild the ENTIRE milestones table from a roadmap file
   * (projector.ts's projectMilestones deletes and re-inserts), and
   * dbOptsFromFlags dropped `--roadmap-path` — so `db rebuild --db
   * <other-project>.db` replaced that project's milestones with black-smith's
   * own factory/specs/roadmap.md. Same defect `ui serve` had on the read path;
   * this is the write path, and here the wrong rows are persisted.
   */
  it('db rebuild --roadmap-path projects that roadmap, never black-smith own', () => {
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

    const candidatesResult = runCli([
      'lessons',
      'candidates',
      '--db',
      dbPath,
      '--session',
      sessionId,
    ]);
    expect(candidatesResult.status).toBe(0);
    const candidates = JSON.parse(candidatesResult.stdout);
    expect(candidates.map((c: { lessonId: string }) => c.lessonId)).toEqual([lessonId]);

    // Approve it with the operator's own verb (P9-1) — the same mechanism
    // the UI's approve route uses, minus the hand-assembled envelope.
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
    expect(JSON.parse(compileResult.stdout)).toEqual({ outPath: lessonsOut, lessonsCompiled: 1 });
    expect(readFileSync(lessonsOut, 'utf8')).toContain(lessonId);

    // ...and out the far end: the approved, compiled lesson reaches a prompt
    // (P9-2). A gate-block checkpoint compiles as `stack-wide`, which the
    // scribe template declares, so this closes candidate -> approve ->
    // compile -> dispatch in one run.
    const dispatchResult = runCli(['lessons', 'for-dispatch', 'scribe', '--lessons', lessonsOut]);
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

  // D-46/P9-29: a task's life must be readable off the log alone. These two
  // verbs close the last gaps — `plan ingest` is where a task starts
  // existing, and `wave check` is where one becomes ready — and both mint
  // ids from the plan rather than from whatever was typed at them.
  describe('task-status producers (D-46/P9-29)', () => {
    const PLAN = {
      epic_id: 'epic-1',
      version: 1,
      status: 'active',
      tasks: [
        {
          task_id: 'epic-1/task-1',
          epic_id: 'epic-1',
          plan_version: 1,
          objective: 'Do the thing.',
          output_schema_ref: 'result.schema.json',
          acceptance_criteria: ['it works'],
          // Narrow claims on purpose: a `src/foo/**` claim could contain a
          // pnpm-lock.yaml, so worktree.yml's serialize-always rule would
          // (correctly) refuse to run these two concurrently, and this test
          // is about the event, not about admissibility.
          claims: ['src/foo/*.ts'],
          budget: { tokens: 1000, diff_lines: 100 },
          contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
        },
        {
          task_id: 'epic-1/task-2',
          epic_id: 'epic-1',
          plan_version: 1,
          objective: 'Do the other thing.',
          output_schema_ref: 'result.schema.json',
          acceptance_criteria: ['it works'],
          claims: ['src/bar/*.ts'],
          budget: { tokens: 1000, diff_lines: 100 },
          contract: { functional_clauses: ['do it'], nonfunctional_clauses: [] },
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
        },
      ],
      edges: [],
    };

    async function session(): Promise<{ sessionId: string; eventsDir: string; planPath: string }> {
      const sessionId = `cli-p9-29-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const eventsDir = path.join(scratchDir, `${sessionId}-events`);
      const planPath = path.join(scratchDir, `${sessionId}-plan.json`);
      await writeFile(planPath, JSON.stringify(PLAN));
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
      return { sessionId, eventsDir, planPath };
    }

    function tail(
      sessionId: string,
      eventsDir: string,
    ): {
      event_type: string;
      task_id?: string;
      edge?: { edge_type: string; edge_provenance: string };
      payload: Record<string, unknown>;
    }[] {
      const result = runCli(['event', 'tail', sessionId, '--n', '100', '--state-dir', eventsDir]);
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout).map((e: { record: Record<string, unknown> }) => e.record);
    }

    it('plan ingest: writes a task-added per task, and says so; re-running adds nothing', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const ingest = runCli([
        'plan',
        'ingest',
        planPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(ingest.status).toBe(0);
      expect(JSON.parse(ingest.stdout)).toMatchObject({ added: 2, skipped: 0 });

      const added = tail(sessionId, eventsDir).filter((r) => r.event_type === 'task-added');
      expect(added.map((r) => r.task_id)).toEqual(['epic-1/task-1', 'epic-1/task-2']);

      const again = runCli([
        'plan',
        'ingest',
        planPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(again.status).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ added: 0, skipped: 2 });
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'task-added')).toHaveLength(
        2,
      );
    });

    // D-254. The plan declares a DAG; before this the ingest wrote its nodes
    // and dropped its arrows, leaving the db's `edges` table empty in every
    // real session and the Flow page drawing a graph with no dependencies.
    it('plan ingest: writes an edge-recorded per declared edge; re-running adds none', async () => {
      const { sessionId, eventsDir } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-dag.json`);
      await writeFile(
        planPath,
        JSON.stringify({
          ...PLAN,
          edges: [
            {
              task: 'epic-1/task-2',
              dependsOn: 'epic-1/task-1',
              edge_type: 'artifact',
              edge_provenance: 'declared',
            },
          ],
        }),
      );
      const args = [
        'plan',
        'ingest',
        planPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ];

      const ingest = runCli(args);
      expect(ingest.status).toBe(0);
      expect(JSON.parse(ingest.stdout)).toMatchObject({ added: 2, edges: 1 });

      const recorded = tail(sessionId, eventsDir).filter((r) => r.event_type === 'edge-recorded');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.task_id).toBe('epic-1/task-2');
      expect(recorded[0]?.payload.depends_on).toBe('epic-1/task-1');
      expect(recorded[0]?.edge).toEqual({ edge_type: 'artifact', edge_provenance: 'declared' });

      const again = runCli(args);
      expect(again.status).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ added: 0, edges: 0 });
      expect(
        tail(sessionId, eventsDir).filter((r) => r.event_type === 'edge-recorded'),
      ).toHaveLength(1);
    });

    it('wave check: logs wave-admitted under the plan spelling of a bare task id', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const result = runCli([
        'wave',
        'check',
        planPath,
        'task-1',
        'task-2',
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).valid).toBe(true);

      const admitted = tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted');
      expect(admitted).toHaveLength(1);
      expect(admitted[0]?.payload.task_ids).toEqual(['epic-1/task-1', 'epic-1/task-2']);
    });

    // The other half of the same claim. `wave check` says two tasks *may* run
    // at once; nothing until now said whether they *did*. A dispatcher that
    // admits a wave of two and then runs them one after the other reports the
    // same green as one that ran them together, and the log already held the
    // difference — this reads it back. The events go through the CLI rather
    // than a fixture so the producer's payload and the reader's expectations
    // are checked against each other.
    it('wave audit: separates a wave that ran wide from one that ran one at a time', async () => {
      async function ran(order: string[]): Promise<{ sessionId: string; eventsDir: string }> {
        const { sessionId, eventsDir, planPath } = await session();
        const admit = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(admit.status).toBe(0);

        for (const step of order) {
          const [kind, task] = step.split(' ');
          const appended = runCli([
            'event',
            'append',
            JSON.stringify({
              session_id: sessionId,
              actor: 'system',
              plan_version: 1,
              causal_parent: `${sessionId}#0`,
              task_id: `epic-1/${task}`,
              ...(kind === 'dispatch'
                ? {
                    event_type: 'dispatch_decision',
                    payload: {
                      agent_role: 'coder',
                      provider: 'claude',
                      model_tier: 'mid',
                      model: 'claude-sonnet-5',
                    },
                  }
                : {
                    event_type: 'task-result-recorded',
                    payload: { agent: 'coder' },
                  }),
            }),
            '--state-dir',
            eventsDir,
          ]);
          expect(appended.status).toBe(0);
        }
        return { sessionId, eventsDir };
      }

      const audit = (sessionId: string, eventsDir: string, ...rest: string[]) =>
        runCli(['wave', 'audit', '--session', sessionId, '--state-dir', eventsDir, ...rest]);

      // Admitted, and not one dispatch under it. "Ran narrow" and "cannot
      // tell" are different facts, so they get different exit codes.
      const blind = await ran([]);
      const nothing = audit(blind.sessionId, blind.eventsDir);
      expect(nothing.status).toBe(2);
      const nothingSummary = JSON.parse(nothing.stdout);
      expect(nothingSummary.unobserved).toEqual(['epic-1']);
      expect(nothingSummary.serialized).toEqual([]);
      expect(nothingSummary.hint).toContain('dispatch_decision');

      // One task dispatched, finished, and only then the next.
      const serial = await ran([
        'dispatch task-1',
        'result task-1',
        'dispatch task-2',
        'result task-2',
      ]);
      const serialised = audit(serial.sessionId, serial.eventsDir);
      expect(serialised.status).toBe(1);
      const serialSummary = JSON.parse(serialised.stdout);
      expect(serialSummary.serialized).toEqual(['epic-1']);
      expect(serialSummary.widest).toEqual({ declared: 2, observed: 1 });
      expect(serialSummary.waves[0].verdict).toBe('serialized');
      expect(serialSummary.waves[0].declared).toEqual(['epic-1/task-1', 'epic-1/task-2']);

      // Both in flight before either finished: the shape the factory is for.
      const wide = await ran([
        'dispatch task-1',
        'dispatch task-2',
        'result task-1',
        'result task-2',
      ]);
      const parallel = audit(wide.sessionId, wide.eventsDir);
      expect(parallel.status).toBe(0);
      const wideSummary = JSON.parse(parallel.stdout);
      expect(wideSummary.serialized).toEqual([]);
      expect(wideSummary.waves[0].verdict).toBe('parallel');
      expect(wideSummary.widest).toEqual({ declared: 2, observed: 2 });

      // --epic narrows to one epic's waves; an epic with none is not a failure.
      const narrowed = audit(wide.sessionId, wide.eventsDir, '--epic', 'epic-9');
      expect(narrowed.status).toBe(0);
      expect(JSON.parse(narrowed.stdout).waves).toEqual([]);
    });

    // The fourth bracket, and the only one that is not about a session. The
    // three above all answer "the log I am standing in"; this one answers "this
    // workshop", and the flag semantics ARE the feature — so they are checked
    // through the real CLI against a state dir holding two unrelated lineages,
    // which is the only place the difference between the two scopes exists.
    it('epic width: folds every session by default, and one lineage under --session', () => {
      const eventsDir = path.join(
        scratchDir,
        `epic-width-${Math.random().toString(36).slice(2, 8)}`,
      );

      function closed(sessionId: string, epicId: string, concurrency: unknown): void {
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

        const close = runCli([
          'event',
          'append',
          JSON.stringify({
            session_id: sessionId,
            actor: 'system',
            event_type: 'epic-closed',
            plan_version: 1,
            causal_parent: `${sessionId}#0`,
            payload: {
              epic_id: epicId,
              closed_by: 'verdict',
              machine_verdict: 'ready',
              summary: { concurrency },
            },
          }),
          '--state-dir',
          eventsDir,
        ]);
        expect(close.status).toBe(0);
      }

      const width = (...rest: string[]) =>
        runCli(['epic', 'width', '--state-dir', eventsDir, ...rest]);

      const counts = (over: Partial<Record<string, number>>) => ({
        parallel: 0,
        partial: 0,
        serialized: 0,
        single: 0,
        unobserved: 0,
        ...over,
      });

      closed('cli-width-wide', 'epic-wide', {
        waves: 1,
        verdicts: counts({ parallel: 1 }),
        widest: { declared: 3, observed: 3 },
        unobserved: [],
        problem: null,
      });
      closed('cli-width-narrow', 'epic-narrow', {
        waves: 1,
        verdicts: counts({ serialized: 1 }),
        widest: { declared: 2, observed: 1 },
        unobserved: [],
        problem: null,
      });

      // No --session: both lineages, and the narrow one still fails the run.
      // A default scoped to one session would have reported this workshop as
      // healthy or as broken depending on which terminal the operator was in.
      const all = width();
      expect(all.status).toBe(1);
      const allSummary = JSON.parse(all.stdout);
      expect(allSummary.epics.map((e: { epicId: string }) => e.epicId).sort()).toEqual([
        'epic-narrow',
        'epic-wide',
      ]);
      expect(allSummary.serialized).toEqual(['epic-narrow']);
      expect(allSummary.widest).toEqual({ declared: 3, observed: 3 });

      // --session narrows to one lineage, which is how an operator asks the
      // old question. The wide session alone passes; the narrow one alone
      // still fails, so the scope changes what is counted and not the rule.
      const wide = width('--session', 'cli-width-wide');
      expect(wide.status).toBe(0);
      expect(JSON.parse(wide.stdout).epics.map((e: { epicId: string }) => e.epicId)).toEqual([
        'epic-wide',
      ]);

      const narrow = width('--session', 'cli-width-narrow');
      expect(narrow.status).toBe(1);
      expect(JSON.parse(narrow.stdout).serialized).toEqual(['epic-narrow']);

      // An unknown session is a typo, not an empty factory: reported as the
      // error it is rather than folded into a confident "nothing here". Checked
      // on the error code and not on the exit status, because a missing session
      // and a serialized epic both leave 1 — the envelope is what tells them
      // apart, and an operator scripting this reads the same field.
      const missing = width('--session', 'cli-width-nobody');
      expect(missing.status).not.toBe(0);
      expect(JSON.parse(missing.stdout).error.code).toBe('events.unknown-session');
    });

    // The third bracket on parallelism, driven through the real CLI. `wave
    // check` certifies a wave someone already picked; `wave audit` reads the
    // log back afterwards. Neither can say whether the plan could EVER have
    // run wide, which is the only one of the three questions that is still
    // answerable in time to change the plan.
    it('wave schedule: reports a plan that runs in one wide round, and exits 0', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const result = runCli([
        'wave',
        'schedule',
        planPath,
        // The symbol graph is read from here rather than the checkout: these
        // claims name no file in this repo, and scanning it would price a
        // question the fixture does not ask.
        '--repo',
        scratchDir,
        '--session',
        sessionId,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(0);
      const schedule = JSON.parse(result.stdout);
      expect(schedule.epicId).toBe('epic-1');
      expect(schedule.rounds).toHaveLength(1);
      expect(schedule.rounds[0].tasks).toEqual(['epic-1/task-1', 'epic-1/task-2']);
      expect(schedule.depth).toBe(1);
      expect(schedule.widest).toBe(2);
      expect(schedule.scheduled).toBe(2);
      expect(schedule.stalled).toEqual([]);
      expect(schedule.constraints).toEqual([]);
      expect(schedule.hint).toBe('');
    });

    // Same two tasks, same dependency graph — nothing changed but where the
    // planner drew the claims, and the plan lost half its width. This is the
    // finding the command exists to make, and it is invisible to every other
    // gate: each wave of one is admitted, and each runs faithfully.
    it('wave schedule: exits 2 and names the pair when claim geometry costs the width', async () => {
      const { sessionId } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-overlap.json`);
      await writeFile(
        planPath,
        JSON.stringify({
          ...PLAN,
          tasks: PLAN.tasks.map((task, index) => ({
            ...task,
            claims: index === 0 ? ['src/foo/**'] : ['src/foo/deep/*.ts'],
          })),
        }),
      );

      const result = runCli(['wave', 'schedule', planPath, '--repo', scratchDir]);
      expect(result.status).toBe(2);
      const schedule = JSON.parse(result.stdout);
      expect(schedule.depth).toBe(2);
      expect(schedule.widest).toBe(1);
      expect(schedule.rounds[0].avoidable[0].taskId).toBe('epic-1/task-2');
      expect(schedule.constraints).toHaveLength(1);
      expect(schedule.constraints[0].reason).toBe('claim-overlap');
      expect(schedule.constraints[0].tasks).toEqual(['epic-1/task-2']);
      expect(schedule.constraints[0].blockedBy).toEqual(['epic-1/task-1']);
      expect(schedule.hint).toContain('claim-overlap');
    });

    // The bug the old filter hid: `taskIds.includes(t.task_id)` matched
    // nothing when the ids were spelled differently, validateWave([]) said
    // "valid", and an empty wave sailed through as if it had been checked.
    it('wave check: refuses a task id the plan does not contain instead of validating an empty wave', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const result = runCli(['wave', 'check', planPath, 'task-9']);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error.message).toContain('no task "task-9"');
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
        [],
      );
    });

    it('wave check: --dry checks admissibility without writing anything', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const result = runCli(['wave', 'check', planPath, 'task-1', '--dry']);
      expect(result.status).toBe(0);
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
        [],
      );
    });

    // D-212: `factory/policies/worktree.yml` is the file this verb loads, and
    // it says what a dependency edge means — "tasks with overlapping claims
    // are never scheduled concurrently; they get a dependency edge (edge_type:
    // claim-order) and run serially instead". Cutting that edge is also what
    // narrows the claims, so a planner that took the advice hands this gate a
    // wave whose claims are disjoint and whose tasks may not run together.
    // The plan was in hand from the first line of the verb; `plan.edges` was
    // never read, and the wave was admitted.
    it('wave check: refuses a wave whose plan orders one of its tasks after another', async () => {
      const { sessionId, eventsDir } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-ordered.json`);
      await writeFile(
        planPath,
        JSON.stringify({
          ...PLAN,
          edges: [
            {
              task: 'epic-1/task-2',
              dependsOn: 'epic-1/task-1',
              edge_type: 'claim-order',
              edge_provenance: 'declared',
            },
          ],
        }),
      );

      const result = runCli([
        'wave',
        'check',
        planPath,
        'task-1',
        'task-2',
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout);
      // Named apart, as in the D-48 block below: exit 1 here must mean
      // "checked, and these two are ordered", not "could not resolve an id".
      expect(parsed.error).toBeUndefined();
      expect(parsed.valid).toBe(false);
      expect(parsed.dependencyViolations).toEqual([
        {
          task: 'epic-1/task-2',
          dependsOn: 'epic-1/task-1',
          chain: ['epic-1/task-2', 'epic-1/task-1'],
        },
      ]);
      // `wave-admitted` is what moves a task to `ready`; a refused wave moves
      // nothing.
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
        [],
      );
    });

    // The plan is read here with a bare `JSON.parse(...) as PlanFile`, and
    // `validatePlan` is reached from `smith plan validate` alone — so the only
    // thing between a misshapen claims field and the disjointness comparison
    // is the comparison itself, which cannot tell. Written as a list these two
    // tasks are refused for overlap; written with one of them as a bare string
    // the same wave was ADMITTED, because iterating a string yields its
    // characters and 's' overlaps no path. Two tasks then went into parallel
    // worktrees both allowed to edit src/foo/a.ts, to collide at merge.
    it('wave check: refuses a claim written as a bare string instead of admitting the wave', async () => {
      const { sessionId, eventsDir } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-string-claims.json`);
      const plan = {
        ...PLAN,
        tasks: PLAN.tasks.map((task, index) => ({
          ...task,
          claims: index === 0 ? 'src/foo/**' : ['src/foo/a.ts'],
        })),
      };
      await writeFile(planPath, JSON.stringify(plan));

      const result = runCli(['wave', 'check', planPath, 'task-1', 'task-2']);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: 'claims.unreadable-claims',
        details: { task_id: 'epic-1/task-1', received: 'string' },
      });
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
        [],
      );
    });

    // Disjoint claims, no declared edge, and still not parallelisable: the
    // conflict lives on the import edge between the two claimed files, which
    // is exactly what a glob comparison cannot see (P9-3).
    it('wave check: refuses two tasks joined by an import edge their claims do not show', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const coupledRepo = await mkdtemp(path.join(tmpdir(), 'smith-wave-symbols-'));
      try {
        await mkdir(path.join(coupledRepo, 'src', 'foo'), { recursive: true });
        await mkdir(path.join(coupledRepo, 'src', 'bar'), { recursive: true });
        await writeFile(
          path.join(coupledRepo, 'src/foo/a.ts'),
          'export function parse(x: string) { return x; }\n',
        );
        await writeFile(
          path.join(coupledRepo, 'src/bar/b.ts'),
          "import { parse } from '../foo/a.js';\nexport const b = parse('x');\n",
        );
        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--repo',
          coupledRepo,
          '--session',
          sessionId,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stdout);
        // Named apart from the claim check: these claims ARE disjoint.
        expect(parsed.valid).toBe(true);
        expect(parsed.symbolImpact.status).toBe('coupled');
        expect(parsed.symbolImpact.crossings).toEqual([
          {
            producer: 'epic-1/task-1',
            consumer: 'epic-1/task-2',
            exportedBy: 'src/foo/a.ts',
            importedBy: 'src/bar/b.ts',
            symbols: ['parse'],
            typeOnly: false,
            dynamic: false,
          },
        ]);
        // A refused wave moves nothing to `ready`.
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      } finally {
        await rm(coupledRepo, { recursive: true, force: true });
      }
    });

    it('wave check: admits the same wave when the two claimed trees share no edge', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const looseRepo = await mkdtemp(path.join(tmpdir(), 'smith-wave-symbols-ok-'));
      try {
        await mkdir(path.join(looseRepo, 'src', 'foo'), { recursive: true });
        await mkdir(path.join(looseRepo, 'src', 'bar'), { recursive: true });
        await writeFile(path.join(looseRepo, 'src/foo/a.ts'), 'export const a = 1;\n');
        await writeFile(path.join(looseRepo, 'src/bar/b.ts'), 'export const b = 2;\n');
        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--repo',
          looseRepo,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.symbolImpact.status).toBe('clean');
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted'),
        ).toHaveLength(1);
      } finally {
        await rm(looseRepo, { recursive: true, force: true });
      }
    });

    // The log is the other register, and it used to substitute `[]` for a
    // claims value it could not read — which is the one claim set that
    // overlaps nothing, so the wave was admitted rather than questioned.
    it('wave check: refuses a follow-up whose logged claims the register cannot read', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const append = runCli([
        'event',
        'append',
        JSON.stringify({
          session_id: sessionId,
          actor: 'system',
          event_type: 'task-added',
          task_id: 'epic-1/followup-ab12',
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: { epic_id: 'epic-1', claims: 'src/foo/a.ts' },
        }),
        '--state-dir',
        eventsDir,
      ]);
      expect(append.status).toBe(0);

      const result = runCli([
        'wave',
        'check',
        planPath,
        'task-1',
        'epic-1/followup-ab12',
        '--session',
        sessionId,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: 'claims.unreadable-claims',
        details: { task_id: 'epic-1/followup-ab12', received: 'string' },
      });
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
        [],
      );
    });

    // The epic token cap has been declared in budgets.yml since 2026-08-11 and
    // read since P9-33 — by planQuorum's budget trigger and by `smith budget
    // alarm`, both of which stand downstream of the spend they report and can
    // only describe a bill after it is run up. `wave check` is the one moment
    // upstream of it: before any task in the wave has been dispatched, when
    // there is nothing in flight for a refusal to distort (D-29 draws exactly
    // this line for the task cap). budgets.yml's own comment on
    // `max_in_flight_tasks` already told its reader that "setting it makes
    // `smith wave check` refuse to admit a wave" — and until these tests,
    // nothing in the CLI called checkWaveBudget at all, so that sentence
    // described a gate that did not exist.
    describe('wave check: the epic budget gate', () => {
      /** A budgets.yml with only the fields this gate reads; the rest default. */
      async function policyFile(
        name: string,
        epic: { cap_tokens: number; max_in_flight_tasks?: number },
      ): Promise<string> {
        const policyPath = path.join(scratchDir, `${name}-budgets.yml`);
        const maxInFlight = epic.max_in_flight_tasks ?? null;
        await writeFile(
          policyPath,
          `epic:\n  cap_tokens: ${epic.cap_tokens}\n  alarm_ratio: 0.7\n` +
            `  max_in_flight_tasks: ${maxInFlight === null ? 'null' : maxInFlight}\n`,
        );
        return policyPath;
      }

      /** The two-task fixture plan, repriced so its declared cost is the variable. */
      async function pricedPlan(name: string, tokens: number): Promise<string> {
        const planPath = path.join(scratchDir, `${name}-priced.json`);
        await writeFile(
          planPath,
          JSON.stringify({
            ...PLAN,
            tasks: PLAN.tasks.map((task) => ({ ...task, budget: { tokens, diff_lines: 100 } })),
          }),
        );
        return planPath;
      }

      it('refuses a wave whose own declared cost would cross the epic cap', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = await pricedPlan(sessionId, 3000);
        const budgetPolicy = await policyFile(sessionId, { cap_tokens: 5000 });

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          '--budget-policy',
          budgetPolicy,
        ]);

        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stdout);
        // Named apart from an id failure, as the dependency-order test above
        // is: exit 1 here means "checked, and it does not fit".
        expect(parsed.error).toBeUndefined();
        expect(parsed.valid).toBe(true);
        expect(parsed.budget).toMatchObject({
          status: 'refused',
          capTokens: 5000,
          waveTokens: 6000,
          waveTaskCount: 2,
        });
        expect(parsed.budget.detail).toContain('5,000');
        // The whole point of refusing at admission: nothing moves to ready.
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      // Same shape as `epic close` (D-43/P9-27): a machine refusal a human may
      // override, and the log then carries the machine's verdict AND the
      // human's reason — not a silently admitted wave that reads afterward as
      // if it had been within budget all along.
      it('admits a refused wave under --override-rationale and logs both', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = await pricedPlan(sessionId, 3000);
        const budgetPolicy = await policyFile(sessionId, { cap_tokens: 5000 });

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          '--budget-policy',
          budgetPolicy,
          '--override-rationale',
          'Operator: the cap moves next epic; this wave finishes the migration.',
        ]);

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).budget.status).toBe('refused');

        const admitted = tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted');
        expect(admitted).toHaveLength(1);
        expect(admitted[0]?.payload.budget).toMatchObject({
          status: 'refused',
          cap_tokens: 5000,
          wave_tokens: 6000,
          override_rationale:
            'Operator: the cap moves next epic; this wave finishes the migration.',
        });
      });

      it('refuses a blank --override-rationale rather than recording an empty reason', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = await pricedPlan(sessionId, 3000);
        const budgetPolicy = await policyFile(sessionId, { cap_tokens: 5000 });

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          '--budget-policy',
          budgetPolicy,
          '--override-rationale',
          '   ',
        ]);

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.blank-override-rationale');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      // `epic.max_in_flight_tasks` reached budgets.yml as the operator's own
      // wall-clock/rate-limit bound — null by default, because fan-out is
      // bounded by the claim graph and cost by the token cap. Set, it has to
      // mean something.
      it('refuses a wave that would put more tasks in flight than the fan-out cap allows', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = await pricedPlan(sessionId, 1000);
        const budgetPolicy = await policyFile(sessionId, {
          cap_tokens: 4_000_000,
          max_in_flight_tasks: 1,
        });

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          '--budget-policy',
          budgetPolicy,
        ]);

        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.valid).toBe(true);
        expect(parsed.budget).toMatchObject({
          status: 'over-fan-out',
          inFlightTasks: 0,
          maxInFlightTasks: 1,
          waveTaskCount: 2,
        });
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      /** Put a log-only task in the register, the way `findings raise` does. */
      async function logOnlyTask(sessionId: string, eventsDir: string, taskId: string) {
        const append = runCli([
          'event',
          'append',
          JSON.stringify({
            session_id: sessionId,
            actor: 'system',
            event_type: 'task-added',
            task_id: taskId,
            plan_version: 1,
            causal_parent: `${sessionId}#0`,
            payload: { epic_id: 'epic-1', claims: ['src/baz/*.ts'] },
          }),
          '--state-dir',
          eventsDir,
        ]);
        expect(append.status).toBe(0);
      }

      // Two silences that look alike in a sum and are not alike at all, so the
      // pair is asserted together: what the plan left blank, and what no plan
      // ever had a field for.

      // D-48/P9-31: a follow-up minted by `findings raise` exists only in the
      // log, and the log records its claims, never its budget — there was no
      // field to leave blank. Refusing it would make the factory's own repair
      // path reachable only by hand-editing the plan the follow-up exists to
      // avoid, which is guard.sh's deny-on-unavailable trap again: not safe,
      // stuck. The policy prices it at the coder cap instead — the most it may
      // spend — so the cap is enforced against a real number.
      it('prices a log-only follow-up at the coder cap rather than refusing it', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        await logOnlyTask(sessionId, eventsDir, 'epic-1/followup-cd34');

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'epic-1/followup-cd34',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);

        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.valid).toBe(true);
        expect(parsed.budget.status).toBe('ok');
        expect(parsed.budget.unpricedTasks).toEqual([]);
        // 1000 from the fixture plan's task-1, plus the coder cap for the one
        // nothing declared. Read off the policy so the assertion cannot drift
        // from budgets.yml, but pinned as a sum so a silent 0 would fail.
        const coderCap = loadBudgetPolicy().task.coder.capTokens;
        expect(parsed.budget.waveTokens).toBe(1000 + coderCap);
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted'),
        ).toHaveLength(1);
      });

      // The same wave, against a cap the coder-cap price cannot fit under: the
      // pricing above is a real charge, not a way past the gate.
      it('refuses that same follow-up when the coder cap will not fit under the epic cap', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        await logOnlyTask(sessionId, eventsDir, 'epic-1/followup-cd34');
        const budgetPolicy = await policyFile(sessionId, { cap_tokens: 5000 });

        const result = runCli([
          'wave',
          'check',
          planPath,
          'epic-1/followup-cd34',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          '--budget-policy',
          budgetPolicy,
        ]);

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).budget.status).toBe('refused');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      // The other silence. `task-spec.schema.json` requires `budget.tokens`,
      // so a plan reaching this gate without one never passed `smith plan
      // validate` — and `wave check` reads its plan with a bare cast rather
      // than re-validating it. An unpriced spec is a plan defect one edit
      // fixes, so refusing names it where it can be acted on.
      it('refuses a wave whose plan declares a task with no budget at all', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = path.join(scratchDir, `${sessionId}-unpriced.json`);
        const [first, second] = PLAN.tasks;
        await writeFile(
          planPath,
          JSON.stringify({
            ...PLAN,
            tasks: [first, { ...second, budget: { diff_lines: 100 } }],
          }),
        );

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);

        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.error).toBeUndefined();
        expect(parsed.valid).toBe(true);
        expect(parsed.budget.status).toBe('unverifiable');
        expect(parsed.budget.unpricedTasks).toEqual(['epic-1/task-2']);
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      // F0's lesson, applied to this gate: one silent yes for both "checked,
      // and it fits" and "could not check" is the failure mode, not the
      // convenience. Without --session there is no log to read the epic's
      // spend from, so `ok` would be an answer the gate never reached.
      it('reports a session-less check as unchecked rather than ok', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const result = runCli(['wave', 'check', planPath, 'task-1', '--dry']);

        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.valid).toBe(true);
        expect(parsed.budget.status).toBe('unchecked');
        expect(parsed.budget.detail).toMatch(/--session/);
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });

      // An admission that passed the gate has to be as readable afterward as
      // one that was overridden — otherwise the log records only refusals,
      // and "was this ever checked?" has no answer for the waves that were.
      it('records what the gate saw on an admission that fits', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = await pricedPlan(sessionId, 1000);
        const budgetPolicy = await policyFile(sessionId, { cap_tokens: 4_000_000 });

        const result = runCli([
          'wave',
          'check',
          planPath,
          'task-1',
          'task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          '--budget-policy',
          budgetPolicy,
        ]);

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).budget.status).toBe('ok');

        const admitted = tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted');
        expect(admitted).toHaveLength(1);
        expect(admitted[0]?.payload.budget).toEqual({
          status: 'ok',
          cap_tokens: 4_000_000,
          projected_tokens: 0,
          wave_tokens: 2000,
          headroom_tokens: 4_000_000,
        });
      });
    });

    // The last id-minting hole: `--tasks` is a hand-written file, so a bare
    // id in it would have made queue.ts write `wave-merged` under a spelling
    // the plan never used — the exact divergence (D-14) that left the epic
    // with one folded task instead of six.
    it('queue run: refuses to log a merge under an id the plan does not contain', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const tasksPath = path.join(scratchDir, `${sessionId}-tasks.json`);
      await writeFile(
        tasksPath,
        JSON.stringify([{ taskId: 'task-9', branch: 'b', worktreeDir: scratchDir }]),
      );
      const result = runCli([
        'queue',
        'run',
        'epic-1',
        '--project',
        scratchDir,
        '--test-cmd',
        'true',
        '--tasks',
        tasksPath,
        '--plan',
        planPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error.message).toContain('no task "task-9"');
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-merged')).toEqual([]);
    });

    it('queue run: refuses to log at all without a plan to mint ids from', async () => {
      const { sessionId, eventsDir } = await session();
      const tasksPath = path.join(scratchDir, `${sessionId}-noplan-tasks.json`);
      await writeFile(
        tasksPath,
        JSON.stringify([{ taskId: 'task-1', branch: 'b', worktreeDir: scratchDir }]),
      );
      const result = runCli([
        'queue',
        'run',
        'epic-1',
        '--project',
        scratchDir,
        '--test-cmd',
        'true',
        '--tasks',
        tasksPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error.message).toContain('--plan');
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-merged')).toEqual([]);
    });

    // D-186: `queue.ts` exports `admit()` — "Admission order for a serial merge
    // queue: topological by dependency edges" — and nothing calls it. `queue run`
    // walks the hand-written `--tasks` array in the order it was typed, so a task
    // can be rebased and merged before the task it declares `depends_on`, and the
    // epic's cumulative regression gate runs against an integration branch that
    // does not have the prerequisite on it yet.
    it('queue run: merges in dependency order, not the order the tasks file lists', async () => {
      const { sessionId } = await session();
      const planPath = path.join(scratchDir, `${sessionId}-dep-plan.json`);
      await writeFile(
        planPath,
        JSON.stringify({
          ...PLAN,
          edges: [
            {
              task: 'epic-1/task-1',
              dependsOn: 'epic-1/task-2',
              edge_type: 'artifact',
              edge_provenance: 'declared',
            },
          ],
        }),
      );

      const originDir = path.join(scratchDir, `${sessionId}-dep-origin.git`);
      const projectDir = path.join(scratchDir, `${sessionId}-dep-project`);
      runOrThrow('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
      runOrThrow('git', ['clone', '-q', originDir, projectDir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
      await writeFile(path.join(projectDir, 'seed.txt'), 'seed\n');
      runOrThrow('git', ['add', '.'], { cwd: projectDir });
      runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
      runOrThrow('git', ['push', '-q', 'origin', 'main'], { cwd: projectDir });

      const made: Array<{ taskId: string; branch: string; worktreeDir: string }> = [];
      for (const id of ['task-1', 'task-2']) {
        const created = runCli(['worktree', 'create', projectDir, 'epic-1', id]);
        expect(created.status).toBe(0);
        const { worktreeDir, branch } = JSON.parse(created.stdout);
        await writeFile(path.join(worktreeDir, `${id}.txt`), `${id}\n`);
        runOrThrow('git', ['add', '.'], { cwd: worktreeDir });
        runOrThrow('git', ['commit', '-q', '-m', `add ${id}`], { cwd: worktreeDir });
        made.push({ taskId: id, branch, worktreeDir });
      }

      // The dependent listed first — exactly what a hand-written tasks file may say.
      const tasksPath = path.join(scratchDir, `${sessionId}-dep-tasks.json`);
      await writeFile(tasksPath, JSON.stringify(made));

      const queued = runCli([
        'queue',
        'run',
        'epic-1',
        '--project',
        projectDir,
        '--test-cmd',
        'true',
        '--tasks',
        tasksPath,
        '--plan',
        planPath,
      ]);
      expect(queued.status).toBe(0);
      expect(JSON.parse(queued.stdout).map((o: { taskId: string }) => o.taskId)).toEqual([
        'epic-1/task-2',
        'epic-1/task-1',
      ]);
    });

    /**
     * D-137: the other side of the guard above. Refusing to log a merge the
     * queue did not make is right; leaving no way to record one is what turned
     * `envkit-mcp-followup` — merged by hand, four tasks on its integration
     * branch — into an epic that could only be closed by hand-appending the
     * `wave-merged` its log was missing. A repaired hole one verb wide.
     */
    async function handMergedProject(
      sessionId: string,
    ): Promise<{ projectDir: string; branch: string; sha: string }> {
      const originDir = path.join(scratchDir, `${sessionId}-adopt-origin.git`);
      const projectDir = path.join(scratchDir, `${sessionId}-adopt-project`);
      runOrThrow('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
      runOrThrow('git', ['clone', '-q', originDir, projectDir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
      await writeFile(path.join(projectDir, 'a.txt'), 'a\n');
      runOrThrow('git', ['add', '.'], { cwd: projectDir });
      runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
      runOrThrow('git', ['push', '-q', 'origin', 'main'], { cwd: projectDir });

      const worktree = runCli(['worktree', 'create', projectDir, 'epic-1', 'task-1']);
      expect(worktree.status).toBe(0);
      const { worktreeDir, branch } = JSON.parse(worktree.stdout);
      await writeFile(path.join(worktreeDir, 'a.txt'), 'a-edited\n');
      runOrThrow('git', ['commit', '-q', '-am', 'edit a'], { cwd: worktreeDir });

      // Merged with no queue anywhere near it — the case this verb is for.
      runOrThrow('git', ['checkout', '-q', 'smith/epic-1/integration'], { cwd: projectDir });
      runOrThrow('git', ['merge', '--no-ff', branch, '-m', 'merged by hand'], { cwd: projectDir });
      const sha = runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: projectDir }).stdout.trim();
      return { projectDir, branch, sha };
    }

    it('queue adopt: logs wave-merged for a verified hand-merge, under the plan’s id', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const { projectDir, sha } = await handMergedProject(sessionId);

      // Typed bare, as a human would; the log has to hold the qualified id.
      const adopted = runCli([
        'queue',
        'adopt',
        'task-1',
        '--project',
        projectDir,
        '--merge-commit',
        sha,
        '--plan',
        planPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(adopted.status).toBe(0);
      expect(JSON.parse(adopted.stdout)).toEqual({
        outcome: 'adopted',
        taskId: 'epic-1/task-1',
        mergeCommit: sha,
        filesChanged: ['a.txt'],
      });

      const merged = tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-merged');
      expect(merged).toHaveLength(1);
      expect(merged[0]?.task_id).toBe('epic-1/task-1');
      expect(merged[0]?.payload.files_changed).toEqual(['a.txt']);
    });

    // The claim is checked against the repository, not accepted: a real merge
    // of the real branch, made somewhere the epic does not assemble, landed
    // nothing for the epic and cannot be adopted into it.
    it('queue adopt: refuses a commit the integration branch does not contain', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const { projectDir, branch } = await handMergedProject(sessionId);
      runOrThrow('git', ['checkout', '-q', '-b', 'somewhere-else', 'main'], { cwd: projectDir });
      runOrThrow('git', ['merge', '--no-ff', branch, '-m', 'merged somewhere else'], {
        cwd: projectDir,
      });
      const elsewhere = runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: projectDir }).stdout.trim();

      const adopted = runCli([
        'queue',
        'adopt',
        'task-1',
        '--project',
        projectDir,
        '--merge-commit',
        elsewhere,
        '--plan',
        planPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(adopted.status).toBe(1);
      expect(JSON.parse(adopted.stdout).error.code).toBe('queue.adopt-not-on-integration');
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-merged')).toEqual([]);
    });

    it('queue adopt: refuses a task id the plan does not contain', async () => {
      const { sessionId, eventsDir, planPath } = await session();
      const { projectDir, sha } = await handMergedProject(sessionId);

      const adopted = runCli([
        'queue',
        'adopt',
        'task-9',
        '--project',
        projectDir,
        '--merge-commit',
        sha,
        '--plan',
        planPath,
        '--session',
        sessionId,
        '--causal-parent',
        `${sessionId}#0`,
        '--state-dir',
        eventsDir,
      ]);
      expect(adopted.status).toBe(1);
      expect(JSON.parse(adopted.stdout).error.message).toContain('no task "task-9"');
      expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-merged')).toEqual([]);
    });

    // D-43/P9-27: `epic verdict` stays the free read-only probe; `epic close`
    // is the verb that writes the fact down. The dogfood epic was closed by a
    // human overriding a hold, and the log recorded nothing at all.
    //
    // Nested inside the block above to reuse its PLAN/session()/tail()
    // fixtures — an epic can only be closed once it has tasks, and `plan
    // ingest` is what puts them on the log.
    describe('epic close (D-43/P9-27)', () => {
      async function heldEpic() {
        const { sessionId, eventsDir, planPath } = await session();
        // Ingested, never dispatched: task-added with status todo is exactly
        // the non-terminal state an override closes over.
        const ingest = runCli([
          'plan',
          'ingest',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(ingest.status).toBe(0);
        return { sessionId, eventsDir };
      }

      it('refuses to close a held epic without a rationale, and writes nothing', async () => {
        const { sessionId, eventsDir } = await heldEpic();
        const result = runCli([
          'epic',
          'close',
          '--epic',
          'epic-1',
          '--project',
          scratchDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('epic.close-refused');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'epic-closed')).toEqual(
          [],
        );
      });

      it('records an operator override, naming the machine verdict it overrode', async () => {
        const { sessionId, eventsDir } = await heldEpic();
        const result = runCli([
          'epic',
          'close',
          '--epic',
          'epic-1',
          '--project',
          scratchDir,
          '--override-rationale',
          'Carry-forward defects only; tracked as D-99.',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          epicId: 'epic-1',
          closedBy: 'operator-override',
          machineVerdict: 'hold',
        });

        const closed = tail(sessionId, eventsDir).filter((r) => r.event_type === 'epic-closed');
        expect(closed).toHaveLength(1);
        expect(closed[0]?.task_id).toBe('epic-1/integration');
        expect(closed[0]?.payload.override_rationale).toBe(
          'Carry-forward defects only; tracked as D-99.',
        );
      });

      // `event tail` used to answer a typo'd session with [] and exit 0
      // (D-45; fixed under P9-28, which is why the check below is now the
      // refusal rather than an empty array). Closing must not inherit it: the
      // only thing worse than an unrecorded close is a recorded one in a log
      // nobody is reading.
      it('refuses an unknown session instead of starting a log with a close in it', async () => {
        const { eventsDir } = await heldEpic();
        const result = runCli([
          'epic',
          'close',
          '--epic',
          'epic-1',
          '--project',
          scratchDir,
          '--override-rationale',
          'ship it',
          '--session',
          'no-such-session',
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        const tailed = runCli(['event', 'tail', 'no-such-session', '--state-dir', eventsDir]);
        expect(tailed.status).toBe(1);
        expect(JSON.parse(tailed.stdout).error.code).toBe('events.unknown-session');
      });
    });

    // D-41/P9-24: a finding is about a file, and a file has an owner. Until
    // now the only way to raise one was `gate run`, which meant the finding
    // was born owned by whoever happened to be at the gate.
    describe('findings raise (D-41/P9-24)', () => {
      const EVIDENCE = [
        {
          file_path: 'src/bar/thing.ts',
          finding_category: 'correctness',
          severity: 'S2-major',
          summary: 'off-by-one in loop bound',
          failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
        },
      ];

      async function evidenceFile(name: string, evidence: unknown = EVIDENCE): Promise<string> {
        const filePath = path.join(scratchDir, `${name}.json`);
        await writeFile(filePath, JSON.stringify(evidence));
        return filePath;
      }

      it('raises a finding with no gate run at all, on the task named by --task', async () => {
        const { sessionId, eventsDir } = await session();
        const evidence = await evidenceFile('raise-plain');

        const result = runCli([
          'findings',
          'raise',
          '--evidence',
          evidence,
          '--found-by',
          'reviewer',
          '--task',
          'epic-1/task-1',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject([
          { taskId: 'epic-1/task-1', attribution: 'gated', suppressed: false },
        ]);

        const raised = tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised');
        expect(raised).toHaveLength(1);
        expect(raised[0]?.task_id).toBe('epic-1/task-1');
      });

      it('routes the finding to whoever claims the file, not to --task', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const evidence = await evidenceFile('raise-owned');

        const result = runCli([
          'findings',
          'raise',
          '--evidence',
          evidence,
          '--found-by',
          'reviewer',
          '--task',
          'epic-1/task-1',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject([
          { taskId: 'epic-1/task-2', attribution: 'reassigned', suppressed: false },
        ]);

        const records = tail(sessionId, eventsDir);
        const raised = records.filter((r) => r.event_type === 'finding-raised');
        expect(raised).toHaveLength(1);
        expect(raised[0]?.task_id).toBe('epic-1/task-2');

        const moved = records.filter((r) => r.event_type === 'finding-reattributed');
        expect(moved).toHaveLength(1);
        expect(moved[0]?.payload).toMatchObject({
          from_task_id: 'epic-1/task-1',
          to_task_id: 'epic-1/task-2',
          attribution: 'reassigned',
          file_path: 'src/bar/thing.ts',
        });
      });

      it('opens a follow-up against the epic when no task claims the file', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        // Nothing in PLAN claims scripts/, and no --task is given: the epic is
        // the only thing left that can own it.
        const evidence = await evidenceFile('raise-unclaimed', [
          { ...EVIDENCE[0], file_path: 'scripts/release.sh' },
        ]);

        const result = runCli([
          'findings',
          'raise',
          '--evidence',
          evidence,
          '--found-by',
          'reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        const [routed] = JSON.parse(result.stdout);
        expect(routed).toMatchObject({ attribution: 'follow-up', suppressed: false });
        expect(routed.taskId).toMatch(/^epic-1\/followup-/);

        const records = tail(sessionId, eventsDir);
        const added = records.filter((r) => r.event_type === 'task-added');
        expect(added).toHaveLength(1);
        expect(added[0]?.task_id).toBe(routed.taskId);
        expect(added[0]?.payload).toMatchObject({
          epic_id: 'epic-1',
          task_status: 'todo',
          claims: ['scripts/release.sh'],
        });
      });

      it('refuses to raise a finding with neither --task nor --plan to own it', async () => {
        const { sessionId, eventsDir } = await session();
        const evidence = await evidenceFile('raise-ownerless');

        const result = runCli([
          'findings',
          'raise',
          '--evidence',
          evidence,
          '--found-by',
          'reviewer',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.missing-flag');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised')).toEqual(
          [],
        );
      });
    });

    // P9-15: an open finding in a file you are about to edit is worth knowing
    // and is not a task. The CLI is where that reaches a dispatch prompt.
    describe('findings for-dispatch / reverify (P9-15)', () => {
      /** An S3 in src/foo/thing.ts — task-1's claim — owned by task-2. */
      async function openFinding(sessionId: string, eventsDir: string): Promise<string> {
        const evidence = path.join(scratchDir, `${sessionId}-p9-15-evidence.json`);
        await writeFile(
          evidence,
          JSON.stringify([
            {
              file_path: 'src/foo/thing.ts',
              finding_category: 'maintainability',
              severity: 'S3-minor',
              summary: 'duplicated parse branch',
              failure_scenario: { inputs: 'any', expected: 'one branch', actual: 'two' },
            },
          ]),
        );
        const raised = runCli([
          'findings',
          'raise',
          '--evidence',
          evidence,
          '--found-by',
          'reviewer',
          '--task',
          'epic-1/task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(raised.status).toBe(0);
        return JSON.parse(raised.stdout)[0].findingId as string;
      }

      it('hands the dispatching task the open findings its own claims cover', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        await openFinding(sessionId, eventsDir);

        const forTask1 = runCli([
          'findings',
          'for-dispatch',
          '--session',
          sessionId,
          '--plan',
          planPath,
          '--task',
          'epic-1/task-1',
          '--state-dir',
          eventsDir,
        ]);
        expect(forTask1.status).toBe(0);
        const block = JSON.parse(forTask1.stdout);
        expect(block.findings.map((f: { file_path: string }) => f.file_path)).toEqual([
          'src/foo/thing.ts',
        ]);
        expect(block.text).toContain('CONTEXT, NOT SCOPE');
        expect(block.text).toContain('duplicated parse branch');

        // task-2 claims src/bar/*.ts and owns this finding besides: neither the
        // claims join nor the own-findings rule lets it through.
        const forTask2 = runCli([
          'findings',
          'for-dispatch',
          '--session',
          sessionId,
          '--plan',
          planPath,
          '--task',
          'epic-1/task-2',
          '--state-dir',
          eventsDir,
        ]);
        expect(forTask2.status).toBe(0);
        expect(JSON.parse(forTask2.stdout).findings).toEqual([]);
      });

      it('reverify records that a human re-read the finding, without moving its status', async () => {
        const { sessionId, eventsDir } = await session();
        const findingId = await openFinding(sessionId, eventsDir);

        const result = runCli([
          'findings',
          'reverify',
          findingId,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--note',
          'still reproduces on the new parser',
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);

        const reverified = tail(sessionId, eventsDir).filter(
          (r) => r.event_type === 'finding-reverified',
        );
        expect(reverified).toHaveLength(1);
        expect(reverified[0]?.payload).toMatchObject({
          finding_id: findingId,
          file_path: 'src/foo/thing.ts',
          note: 'still reproduces on the new parser',
        });

        const listed = runCli([
          'findings',
          'list',
          '--session',
          sessionId,
          '--state-dir',
          eventsDir,
        ]);
        expect(listed.status).toBe(0);
        expect(JSON.parse(listed.stdout)[0].finding_status).toBe('raised');
      });

      it('refuses to reverify a finding the log never raised', async () => {
        const { sessionId, eventsDir } = await session();
        const result = runCli([
          'findings',
          'reverify',
          'finding-nope',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('findings.unknown-finding');
      });
    });

    // D-33/P9-9: every judge in this factory returned findings against a diff,
    // and every finding against a diff blocked the diff. The dogfood epic
    // deadlocked on that: a wave-3 spec defect, correctly found, recorded as a
    // coder failure, bounced back to a coder whose diff could not legally
    // contain the fix — because the fix was a new plan version. These are the
    // two verbs that route it the other way instead.
    describe('spec findings and plan amendment (D-33/P9-9)', () => {
      // Anchored to a file task-2 claims, on purpose: the whole question is
      // whether scope beats ownership. A diff finding on this path is
      // reassigned to epic-1/task-2 (the test above proves it); a spec finding
      // on the same path must not be.
      const SPEC_EVIDENCE = [
        {
          file_path: 'src/bar/thing.ts',
          finding_category: 'correctness',
          severity: 'S2-major',
          criterion_ref: 'epic-1/task-2:criterion-1',
          summary: 'criterion says "it works" but never says against which input',
          failure_scenario: {
            inputs: 'any',
            expected: 'a checkable clause',
            actual: 'nothing a gate can decide',
          },
        },
      ];

      async function specEvidenceFile(name: string, evidence: unknown = SPEC_EVIDENCE) {
        const filePath = path.join(scratchDir, `${name}.json`);
        await writeFile(filePath, JSON.stringify(evidence));
        return filePath;
      }

      /** Raise the spec finding these tests amend against, and return its id. */
      async function raiseSpec(
        name: string,
        sessionId: string,
        eventsDir: string,
        planPath: string,
      ): Promise<string> {
        const result = runCli([
          'findings',
          'raise',
          '--scope',
          'spec',
          '--evidence',
          await specEvidenceFile(name),
          '--found-by',
          'spec-reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        return JSON.parse(result.stdout)[0].findingId;
      }

      it('raises a spec finding against the epic, not against whoever claims the file', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'findings',
          'raise',
          '--scope',
          'spec',
          '--evidence',
          await specEvidenceFile('spec-raise'),
          '--found-by',
          'spec-reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject([
          { taskId: 'epic-1/integration', attribution: 'spec', suppressed: false },
        ]);

        const records = tail(sessionId, eventsDir);
        const raised = records.filter((r) => r.event_type === 'finding-raised');
        expect(raised).toHaveLength(1);
        expect(raised[0]?.task_id).toBe('epic-1/integration');
        expect(raised[0]?.payload).toMatchObject({
          finding_scope: 'spec',
          spec_ref: { plan_version: 1, criterion_ref: 'epic-1/task-2:criterion-1' },
        });
        // The two halves of the divert: no task was told to fix it, and no
        // task was told it now owns it. A plan defect has no owner but the
        // plan.
        expect(records.filter((r) => r.event_type === 'finding-reattributed')).toEqual([]);
        expect(records.filter((r) => r.event_type === 'task-added')).toEqual([]);
      });

      it('refuses a spec raise with no --plan: the version reviewed is read, never typed', async () => {
        const { sessionId, eventsDir } = await session();

        const result = runCli([
          'findings',
          'raise',
          '--scope',
          'spec',
          '--evidence',
          await specEvidenceFile('spec-noplan'),
          '--found-by',
          'spec-reviewer',
          '--task',
          'epic-1/task-1',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.missing-flag');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised')).toEqual(
          [],
        );
      });

      it('rejects a --scope it does not know rather than defaulting it to diff', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'findings',
          'raise',
          '--scope',
          'plan',
          '--evidence',
          await specEvidenceFile('spec-badscope'),
          '--found-by',
          'spec-reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.invalid-flag');
      });

      it('amends the plan, cuts v2, and puts the finding that forced it on the amendment path', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const findingId = await raiseSpec('spec-amend', sessionId, eventsDir, planPath);
        const specsDir = path.join(scratchDir, `${sessionId}-specs`);
        // D-127: the amendment has to move the task whose criterion the
        // finding names, or there is nothing for the finding to wait on.
        const changesPath = path.join(scratchDir, `${sessionId}-changes.json`);
        await writeFile(
          changesPath,
          JSON.stringify({
            supersede: {
              'epic-1/task-2': {
                ...PLAN.tasks[1],
                acceptance_criteria: ['parses `A="x\\ny"` into a single entry'],
              },
            },
          }),
        );

        const result = runCli([
          'plan',
          'amend',
          '--plan',
          planPath,
          '--findings',
          findingId,
          '--rationale',
          'criterion-1 was unfalsifiable; v2 names the input it is checked against',
          '--sites',
          'src/bar/thing.ts,src/elsewhere/same-shape.ts',
          '--changes',
          changesPath,
          '--specs-dir',
          specsDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          epic: 'epic-1',
          version: 2,
          previousVersion: 1,
          findingIds: [findingId],
          // D-123: both sites are named; only the one an obligated task claims
          // (task-2 claims src/bar/*.ts) has work behind it. The other is
          // reported back to the operator rather than refused.
          sites: ['src/bar/thing.ts', 'src/elsewhere/same-shape.ts'],
          sitesUnclaimed: ['src/elsewhere/same-shape.ts'],
        });

        // The version exists on disk, and the log says why it was cut.
        const written = JSON.parse(
          await readFile(path.join(specsDir, 'epic-1', 'plan-v2.json'), 'utf8'),
        ) as { version: number; tasks: { task_id: string; plan_version: number }[] };
        expect(written.version).toBe(2);
        // Three records: task-1 carried, task-2's dead copy, task-2's replacement.
        expect(written.tasks.map((t) => t.plan_version)).toEqual([2, 2, 2]);

        const records = tail(sessionId, eventsDir);
        const cut = records.filter((r) => r.event_type === 'plan-version-created');
        expect(cut).toHaveLength(1);
        expect(cut[0]?.payload).toMatchObject({
          epic_id: 'epic-1',
          version: 2,
          previous_version: 1,
          amends: [{ finding_id: findingId, criterion_ref: 'epic-1/task-2:criterion-1' }],
        });

        // The one exit an unwaivable spec finding has — opened, not walked
        // through. `amended` is what the superseded task landing earns (D-127).
        const transitioned = records.filter((r) => r.event_type === 'finding-transitioned');
        expect(transitioned).toHaveLength(1);
        expect(transitioned[0]?.payload).toMatchObject({
          finding_id: findingId,
          to_status: 'amend-pending',
          amends_task_ids: ['epic-1/task-2'],
          amends_plan_version: 2,
        });
      });

      it('refuses an amendment that cites no finding: a version cut on request is a mutable plan', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const specsDir = path.join(scratchDir, `${sessionId}-nofinding-specs`);

        const result = runCli([
          'plan',
          'amend',
          '--plan',
          planPath,
          '--findings',
          '',
          '--rationale',
          'because I said so',
          '--sites',
          'src/bar/thing.ts',
          '--specs-dir',
          specsDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('plan.amendment-without-finding');
        expect(existsSync(path.join(specsDir, 'epic-1', 'plan-v2.json'))).toBe(false);
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === 'plan-version-created'),
        ).toEqual([]);
      });

      // D-123: the flag is required at the CLI too, so the shorter invocation
      // is a usage error rather than an amendment whose scope nobody stated.
      it('refuses an amendment that names no sites (D-123)', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const specsDir = path.join(scratchDir, `${sessionId}-nosites-specs`);

        const result = runCli([
          'plan',
          'amend',
          '--plan',
          planPath,
          '--findings',
          'finding-whatever',
          '--rationale',
          'the shape moved',
          '--specs-dir',
          specsDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('sites');
        expect(existsSync(path.join(specsDir, 'epic-1', 'plan-v2.json'))).toBe(false);
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === 'plan-version-created'),
        ).toEqual([]);
      });

      it('refuses to amend against a diff finding: that says the code is wrong', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const specsDir = path.join(scratchDir, `${sessionId}-diff-specs`);
        const diffEvidence = await specEvidenceFile('amend-diff-evidence', [
          {
            file_path: 'src/bar/thing.ts',
            finding_category: 'correctness',
            severity: 'S2-major',
            summary: 'off-by-one in loop bound',
            failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
          },
        ]);
        const raise = runCli([
          'findings',
          'raise',
          '--evidence',
          diffEvidence,
          '--found-by',
          'reviewer',
          '--task',
          'epic-1/task-2',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(raise.status).toBe(0);

        const result = runCli([
          'plan',
          'amend',
          '--plan',
          planPath,
          '--findings',
          JSON.parse(raise.stdout)[0].findingId,
          '--rationale',
          'trying to fix code with a plan version',
          '--sites',
          'src/bar/thing.ts',
          '--specs-dir',
          specsDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('plan.amendment-not-spec-scoped');
        expect(existsSync(path.join(specsDir, 'epic-1', 'plan-v2.json'))).toBe(false);
      });

      it('refuses a closing spec review it cannot pin to an integration head', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'epic',
          'spec-review',
          '--epic',
          'epic-1',
          // A scratch dir, not a checkout: there is no smith/epic-1/integration
          // here, so there is nothing the review could be shown to cover.
          '--project',
          scratchDir,
          '--plan',
          planPath,
          '--reviewed-by',
          'spec-reviewer',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.no-integration-branch');
        expect(
          tail(sessionId, eventsDir).filter((r) => r.event_type === 'spec-review-recorded'),
        ).toEqual([]);
      });
    });

    // The other side of the same wall. `plan amend` above is the operator's
    // exit from a spec defect; these four verbs are the worker's way of
    // reaching it. A coder cannot emit an event and cannot mint a spec-scoped
    // finding, so it returns the request and the dispatcher records it.
    describe('living spec: worker-proposed amendments', () => {
      const CRITERION = 'epic-1/task-2:criterion-1';

      /** The diff a worker would propose: task-2's criterion, restated. */
      function proposedChanges() {
        return {
          supersede: {
            'epic-1/task-2': {
              ...PLAN.tasks[1],
              acceptance_criteria: ['parses `A="x\\ny"` into a single entry'],
            },
          },
        };
      }

      async function requestFile(
        name: string,
        overrides: Record<string, unknown> = {},
      ): Promise<string> {
        const filePath = path.join(scratchDir, `${name}-request.json`);
        await writeFile(
          filePath,
          JSON.stringify({
            criterion_ref: CRITERION,
            assumption: 'a .env value never spans two physical lines',
            evidence: 'src/bar/thing.ts:41 reads line by line and never rewinds',
            changes: proposedChanges(),
            sites: ['src/bar/thing.ts', 'src/elsewhere/same-shape.ts'],
            blocking: true,
            ...overrides,
          }),
        );
        return filePath;
      }

      async function propose(
        name: string,
        s: { sessionId: string; eventsDir: string; planPath: string },
        specsDir: string,
        overrides: Record<string, unknown> = {},
      ) {
        return runCli([
          'plan',
          'propose',
          '--plan',
          s.planPath,
          '--task',
          'epic-1/task-2',
          '--proposed-by',
          'coder',
          '--request',
          await requestFile(name, overrides),
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
      }

      it('records a proposal, raises the finding that anchors it, and cuts no version', async () => {
        const s = await session();
        const specsDir = path.join(scratchDir, `${s.sessionId}-propose-specs`);

        const result = await propose('cli-propose', s, specsDir);
        expect(result.status).toBe(0);
        const proposal = JSON.parse(result.stdout);
        expect(proposal).toMatchObject({
          epicId: 'epic-1',
          taskId: 'epic-1/task-2',
          baseVersion: 1,
          proposedBy: 'coder',
          criterionRef: CRITERION,
          blocking: true,
          status: 'open',
          decision: null,
          // Defaulted above the waivable band (D-196), so a standing waiver
          // cannot swallow the finding the amendment would have to cite.
          severity: 'S2-major',
          diff: { superseded: ['epic-1/task-2'] },
        });
        expect(proposal.proposalId).toBeTruthy();
        expect(proposal.findingId).toBeTruthy();

        const records = tail(s.sessionId, s.eventsDir);
        expect(records.filter((r) => r.event_type === 'spec-change-proposed')).toHaveLength(1);
        // A proposal is data, not a command: the finding exists so the
        // amendment has something to cite, and nothing else has moved.
        expect(records.filter((r) => r.event_type === 'finding-raised')).toHaveLength(1);
        expect(records.filter((r) => r.event_type === 'plan-version-created')).toEqual([]);
        expect(existsSync(path.join(specsDir, 'epic-1', 'plan-v2.json'))).toBe(false);
      });

      it('refuses a diff that could never be applied, while the worker is still there to be told', async () => {
        const s = await session();
        const specsDir = path.join(scratchDir, `${s.sessionId}-badpropose-specs`);

        const result = await propose('cli-propose-bad', s, specsDir, {
          changes: {
            supersede: { 'epic-1/task-2': { ...PLAN.tasks[1], case: 'not-a-real-case' } },
          },
        });
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('spec-change.proposal-invalid-draft');
        // Refused before the anchor is minted: an unappliable proposal must
        // not leave a finding behind waiting on an amendment nobody can cut.
        expect(
          tail(s.sessionId, s.eventsDir).filter((r) => r.event_type === 'finding-raised'),
        ).toEqual([]);
      });

      it('lists open proposals with the diff the operator has to answer', async () => {
        const s = await session();
        const specsDir = path.join(scratchDir, `${s.sessionId}-list-specs`);
        expect((await propose('cli-list', s, specsDir)).status).toBe(0);

        const listed = runCli([
          'plan',
          'proposals',
          '--session',
          s.sessionId,
          '--status',
          'open',
          '--specs-dir',
          specsDir,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(listed.status).toBe(0);
        const open = JSON.parse(listed.stdout);
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({
          status: 'open',
          criterionRef: CRITERION,
          sites: ['src/bar/thing.ts', 'src/elsewhere/same-shape.ts'],
          diff: { superseded: ['epic-1/task-2'] },
        });
        // The whole diff, not a reference to it: the operator's next move is
        // yes or no on this object.
        expect(open[0].changes.supersede['epic-1/task-2']).toBeTruthy();

        const filtered = runCli([
          'plan',
          'proposals',
          '--session',
          s.sessionId,
          '--task',
          'epic-1/task-1',
          '--specs-dir',
          specsDir,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(filtered.status).toBe(0);
        expect(JSON.parse(filtered.stdout)).toEqual([]);
      });

      it('approves in one command: the amendment cites the finding and diff the worker recorded', async () => {
        const s = await session();
        const specsDir = path.join(scratchDir, `${s.sessionId}-approve-specs`);
        const proposed = await propose('cli-approve', s, specsDir);
        expect(proposed.status).toBe(0);
        const { proposalId, findingId } = JSON.parse(proposed.stdout);

        // No --changes, no --sites, no --rationale. That is the whole of
        // "approve it fast": everything `plan amend` demands was recorded by
        // the
        // worker that hit the wall, so approval supplies it rather than
        // asking the operator to reconstruct it.
        const result = runCli([
          'plan',
          'approve',
          proposalId,
          '--plan',
          s.planPath,
          '--decided-by',
          'operator',
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          proposalId,
          epic: 'epic-1',
          version: 2,
          previousVersion: 1,
          findingIds: [findingId],
          sites: ['src/bar/thing.ts', 'src/elsewhere/same-shape.ts'],
          sitesUnclaimed: ['src/elsewhere/same-shape.ts'],
        });

        // Immutable and on disk, cut by the one code path that cuts versions.
        const written = JSON.parse(
          await readFile(path.join(specsDir, 'epic-1', 'plan-v2.json'), 'utf8'),
        ) as { version: number };
        expect(written.version).toBe(2);

        const records = tail(s.sessionId, s.eventsDir);
        const cut = records.filter((r) => r.event_type === 'plan-version-created');
        expect(cut).toHaveLength(1);
        expect(cut[0]?.payload).toMatchObject({
          version: 2,
          amends: [{ finding_id: findingId, criterion_ref: CRITERION }],
        });
        // The rationale the operator never typed: the worker's own argument,
        // which is the thing they actually agreed with.
        expect(
          String((cut[0]?.payload as { rationale?: string } | undefined)?.rationale),
        ).toContain('a .env value never spans two physical lines');
        const decided = records.filter((r) => r.event_type === 'spec-change-decided');
        expect(decided).toHaveLength(1);
        expect(decided[0]?.payload).toMatchObject({
          proposal_id: proposalId,
          decision: 'approved',
          decided_by: 'operator',
          plan_version: 2,
        });

        // And it is answered: a second approval of the same proposal is not a
        // second version.
        const again = runCli([
          'plan',
          'approve',
          proposalId,
          '--plan',
          s.planPath,
          '--decided-by',
          'operator',
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(again.status).toBe(1);
        expect(JSON.parse(again.stdout).error.code).toBe('spec-change.already-decided');
      });

      it('refuses a proposal a newer version has already overtaken, and says which one', async () => {
        const s = await session();
        const specsDir = path.join(scratchDir, `${s.sessionId}-stale-specs`);
        const first = await propose('cli-stale-a', s, specsDir);
        const second = await propose('cli-stale-b', s, specsDir);
        expect(first.status).toBe(0);
        expect(second.status).toBe(0);

        // Approve one. The other was written against v1, which no longer
        // describes the plan its diff would be applied to.
        const approved = runCli([
          'plan',
          'approve',
          JSON.parse(first.stdout).proposalId,
          '--plan',
          s.planPath,
          '--decided-by',
          'operator',
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(approved.status).toBe(0);

        const stale = runCli([
          'plan',
          'approve',
          JSON.parse(second.stdout).proposalId,
          '--plan',
          s.planPath,
          '--decided-by',
          'operator',
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(stale.status).toBe(1);
        const error = JSON.parse(stale.stdout).error;
        expect(error.code).toBe('spec-change.approval-stale');
        // Named, not merely refused: the operator's next move is to re-propose
        // against v2, and the message is where they learn that.
        expect(error.message).toContain('v2');
        expect(existsSync(path.join(specsDir, 'epic-1', 'plan-v3.json'))).toBe(false);

        // And the listing agrees with the refusal rather than still offering it.
        const listed = runCli([
          'plan',
          'proposals',
          '--session',
          s.sessionId,
          '--status',
          'open',
          '--specs-dir',
          specsDir,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(listed.status).toBe(0);
        expect(JSON.parse(listed.stdout)).toEqual([]);
      });

      it('rejects a proposal: the anchor finding is refuted and no version is cut', async () => {
        const s = await session();
        const specsDir = path.join(scratchDir, `${s.sessionId}-reject-specs`);
        const proposed = await propose('cli-reject', s, specsDir);
        expect(proposed.status).toBe(0);
        const { proposalId, findingId } = JSON.parse(proposed.stdout);

        const bare = runCli([
          'plan',
          'reject',
          proposalId,
          '--decided-by',
          'operator',
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
        // Required, unlike on approve: the log already holds the case for.
        expect(bare.status).toBe(1);
        expect(bare.stdout).toContain('rationale');

        const result = runCli([
          'plan',
          'reject',
          proposalId,
          '--decided-by',
          'operator',
          '--rationale',
          'the reader is line-oriented by contract; multi-line values are out of scope for v1',
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          proposalId,
          status: 'rejected',
          decision: { decision: 'rejected', decidedBy: 'operator', planVersion: null },
        });

        const records = tail(s.sessionId, s.eventsDir);
        expect(records.filter((r) => r.event_type === 'plan-version-created')).toEqual([]);
        expect(existsSync(path.join(specsDir, 'epic-1', 'plan-v2.json'))).toBe(false);
        // The finding does not outlive the answer. Left raised, it would block
        // the epic gate over a criterion the operator has just said is fine.
        const transitioned = records.filter((r) => r.event_type === 'finding-transitioned');
        expect(transitioned).toHaveLength(1);
        expect(transitioned[0]?.payload).toMatchObject({
          finding_id: findingId,
          to_status: 'refuted',
        });
      });
    });

    // B3. Every gate before this one grades planner-authored text against
    // planner-authored text: the spec review reads the plan, the schema gate
    // reads the task's own output schema, the reviewer reads the criteria the
    // planner wrote. `epic goal-check` is the one that reads the roadmap goal
    // the operator wrote before planning began, so a plan that decomposes the
    // wrong problem has somewhere to fail.
    describe('the spec-vs-goal gate', () => {
      const GOAL = 'Load config from .env files. Reject unbalanced quotes.';
      const CLAUSES = ['Load config from .env files.', 'Reject unbalanced quotes.'];

      /** A roadmap whose one milestone owns epic-1. Pass null to drop the goal. */
      async function roadmap(name: string, goalLine: string | null = `- goal: ${GOAL}`) {
        const filePath = path.join(scratchDir, `${name}-roadmap.md`);
        await writeFile(
          filePath,
          [
            '## Phase 1 — Config',
            '- id: phase-1-config',
            '- status: in-progress',
            ...(goalLine === null ? [] : [goalLine]),
            '- epics: [epic-1]',
            '',
          ].join('\n'),
        );
        return filePath;
      }

      async function coverageFile(name: string, coverage: unknown) {
        const filePath = path.join(scratchDir, `${name}-coverage.json`);
        await writeFile(filePath, JSON.stringify(coverage));
        return filePath;
      }

      function checks(sessionId: string, eventsDir: string) {
        return tail(sessionId, eventsDir).filter((r) => r.event_type === 'goal-check-recorded');
      }

      it('prints the clause list a coverage map has to answer', async () => {
        const result = runCli([
          'epic',
          'goal',
          '--epic',
          'epic-1',
          '--roadmap-path',
          await roadmap('cli-goal-read'),
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          milestoneId: 'phase-1-config',
          goal: GOAL,
          clauses: CLAUSES,
          digest: expect.stringMatching(/^[0-9a-f]{16}$/),
        });
      });

      it('keeps `epic goal` read-only by declaring no flag a write would need', async () => {
        // The check that bites here is D-132's: a flag no usage line declares
        // is a refusal, so the day this command starts appending an event it
        // fails until someone declares --session and says why.
        const { sessionId } = await session();
        const result = runCli([
          'epic',
          'goal',
          '--epic',
          'epic-1',
          '--roadmap-path',
          await roadmap('cli-goal-readonly'),
          '--session',
          sessionId,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.unknown-flag');
      });

      it('records a plan checked clause by clause against the goal', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'epic',
          'goal-check',
          '--epic',
          'epic-1',
          '--plan',
          planPath,
          '--roadmap-path',
          await roadmap('cli-goal-ok'),
          '--coverage',
          await coverageFile('cli-goal-ok', [
            { clause: CLAUSES[0], verdict: 'covered', taskIds: ['epic-1/task-1'] },
            { clause: CLAUSES[1], verdict: 'covered', taskIds: ['epic-1/task-2'] },
          ]),
          '--checked-by',
          'spec-reviewer',
          '--checked-by-provider',
          'gemini',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          epicId: 'epic-1',
          milestoneId: 'phase-1-config',
          planVersion: 1,
          checkedBy: 'spec-reviewer',
          findingIds: [],
        });

        const recorded = checks(sessionId, eventsDir);
        expect(recorded).toHaveLength(1);
        // The check is epic-level work, so it is filed against the epic's
        // integration task rather than any one task it graded.
        expect(recorded[0]?.task_id).toBe('epic-1/integration');
        expect(recorded[0]?.payload).toMatchObject({
          epic_id: 'epic-1',
          milestone_id: 'phase-1-config',
          checked_by: 'spec-reviewer',
          checked_by_provider: 'gemini',
          clause_count: 2,
          uncovered_count: 0,
          out_of_scope_count: 0,
          finding_count: 0,
        });
      });

      it('turns an uncovered clause into a spec finding against the plan', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'epic',
          'goal-check',
          '--epic',
          'epic-1',
          '--plan',
          planPath,
          '--roadmap-path',
          await roadmap('cli-goal-gap'),
          '--coverage',
          await coverageFile('cli-goal-gap', [
            { clause: CLAUSES[0], verdict: 'covered', taskIds: ['epic-1/task-1'] },
            { clause: CLAUSES[1], verdict: 'uncovered' },
          ]),
          '--checked-by',
          'spec-reviewer',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        // Exit 0 for the reason `epic spec-review` exits 0 on a finding: the
        // check ran. What blocks the epic is the finding, and `plan amend` is
        // the verb that answers it.
        expect(result.status).toBe(0);
        const record = JSON.parse(result.stdout) as { findingIds: string[] };
        expect(record.findingIds).toHaveLength(1);

        const listed = JSON.parse(
          runCli([
            'findings',
            'list',
            '--session',
            sessionId,
            '--epic',
            'epic-1',
            '--state-dir',
            eventsDir,
          ]).stdout,
        ) as Record<string, unknown>[];
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
          finding_id: record.findingIds[0],
          severity: 'S2-major',
          finding_scope: 'spec',
          // Anchored to the plan file, not to any source file: the defect is
          // that the plan never promised the clause, so no diff can hold it.
          file_path: 'factory/specs/active/epic-1/plan-v1.json',
          spec_ref: { plan_version: 1, criterion_ref: 'goal:phase-1-config#2' },
        });
      });

      it('refuses to record a check against a milestone that states no goal', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'epic',
          'goal-check',
          '--epic',
          'epic-1',
          '--plan',
          planPath,
          '--roadmap-path',
          await roadmap('cli-goal-none', null),
          '--coverage',
          await coverageFile('cli-goal-none', []),
          '--checked-by',
          'spec-reviewer',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.no-epic-goal');
        // A recorded check against nothing would read, at the epic gate, as a
        // check that passed. The gate's own blocker is what has to fire here.
        expect(checks(sessionId, eventsDir)).toEqual([]);
      });

      it('refuses coverage credited to a task the plan does not have', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'epic',
          'goal-check',
          '--epic',
          'epic-1',
          '--plan',
          planPath,
          '--roadmap-path',
          await roadmap('cli-goal-phantom'),
          '--coverage',
          await coverageFile('cli-goal-phantom', [
            { clause: CLAUSES[0], verdict: 'covered', taskIds: ['epic-1/task-1'] },
            { clause: CLAUSES[1], verdict: 'covered', taskIds: ['epic-1/task-9'] },
          ]),
          '--checked-by',
          'spec-reviewer',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('goal-check.unknown-task');
        // Validate before acting: the first clause was answerable, and it
        // still leaves no half-written record behind.
        expect(checks(sessionId, eventsDir)).toEqual([]);
        expect(
          JSON.parse(
            runCli([
              'findings',
              'list',
              '--session',
              sessionId,
              '--epic',
              'epic-1',
              '--state-dir',
              eventsDir,
            ]).stdout,
          ),
        ).toEqual([]);
      });

      // Same shape as the D-139 check on `epic spec-review`: an undeclared
      // flag is a refusal, so the usage line is load-bearing.
      it('documents every flag epic goal-check requires', () => {
        const { stdout, status } = runCli(['epic', 'goal-check', '--help']);
        expect(status).toBe(0);
        expect(stdout).toContain('--coverage');
        expect(stdout).toContain('--checked-by');
        expect(stdout).toContain('--plan');
      });
    });

    // D-48/P9-31: P9-24 made the factory mint a follow-up task for a bug
    // nobody could own. It could not then execute one: every producer resolved
    // ids through the plan alone, and a plan cut before the finding existed
    // cannot name the follow-up. So the task the factory had just created was
    // refused by `wave check` and by `queue run`, and the only way out was to
    // hand-write the events with `smith event append` — which is how D-41's
    // own follow-up was actually driven to merged.
    describe('a minted follow-up is executable (D-48/P9-31)', () => {
      // Nothing in PLAN claims scripts/, so this finding has no owner and the
      // routing mints a task for it.
      const UNOWNED = [
        {
          file_path: 'scripts/release.sh',
          finding_category: 'correctness',
          severity: 'S2-major',
          summary: 'release script swallows a non-zero exit code',
          failure_scenario: { inputs: 'a failing step', expected: 'exit 1', actual: 'exit 0' },
        },
      ];

      /** Raise the unowned finding and return the follow-up id it minted. */
      async function mintFollowUp(
        sessionId: string,
        eventsDir: string,
        planPath: string,
      ): Promise<string> {
        const evidence = path.join(scratchDir, `${sessionId}-followup-evidence.json`);
        await writeFile(evidence, JSON.stringify(UNOWNED));
        const raised = runCli([
          'findings',
          'raise',
          '--evidence',
          evidence,
          '--found-by',
          'reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(raised.status).toBe(0);
        const [routed] = JSON.parse(raised.stdout);
        expect(routed.attribution).toBe('follow-up');
        return routed.taskId as string;
      }

      // The acceptance the punch list names: D-41's own follow-up, from the
      // finding that mints it to the merge that closes it, with `event append`
      // used exactly once — for `session-start`, which is where a session
      // begins. Every other event below is written by the verb that did the
      // work.
      it('runs from findings raise to wave-merged with no hand-appended event', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        // A real project: the queue merges branches, so there has to be one.
        const originDir = path.join(scratchDir, `${sessionId}-origin.git`);
        const projectDir = path.join(scratchDir, `${sessionId}-project`);
        runOrThrow('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
        runOrThrow('git', ['clone', '-q', originDir, projectDir]);
        runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
        runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
        await mkdir(path.join(projectDir, 'scripts'), { recursive: true });
        await writeFile(path.join(projectDir, 'scripts', 'release.sh'), 'run_steps\n');
        runOrThrow('git', ['add', '.'], { cwd: projectDir });
        runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
        runOrThrow('git', ['push', '-q', 'origin', 'main'], { cwd: projectDir });

        const followUpId = await mintFollowUp(sessionId, eventsDir, planPath);
        // Typed the short way from here on, exactly as a human would — the
        // whole point is that both spellings resolve to the one id the log
        // holds, for a task no plan declares.
        const bare = followUpId.slice('epic-1/'.length);

        const admitted = runCli([
          'wave',
          'check',
          planPath,
          bare,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(admitted.status).toBe(0);
        expect(JSON.parse(admitted.stdout).valid).toBe(true);

        const worktree = runCli(['worktree', 'create', projectDir, 'epic-1', bare]);
        expect(worktree.status).toBe(0);
        const { worktreeDir, branch } = JSON.parse(worktree.stdout);
        await writeFile(path.join(worktreeDir, 'scripts', 'release.sh'), 'run_steps || exit 1\n');
        runOrThrow('git', ['commit', '-q', '-am', 'fix release exit code'], { cwd: worktreeDir });

        const tasksPath = path.join(scratchDir, `${sessionId}-followup-tasks.json`);
        await writeFile(tasksPath, JSON.stringify([{ taskId: bare, branch, worktreeDir }]));
        const queued = runCli([
          'queue',
          'run',
          'epic-1',
          '--project',
          projectDir,
          '--test-cmd',
          'true',
          '--tasks',
          tasksPath,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(queued.status).toBe(0);
        expect(JSON.parse(queued.stdout)).toEqual([{ outcome: 'merged', taskId: followUpId }]);

        const records = tail(sessionId, eventsDir);
        expect(
          records.filter((r) => r.event_type === 'wave-admitted')[0]?.payload.task_ids,
        ).toEqual([followUpId]);
        const merged = records.filter((r) => r.event_type === 'wave-merged');
        expect(merged).toHaveLength(1);
        expect(merged[0]?.task_id).toBe(followUpId);
      });

      // The other half of the same bug: an id resolved out of the log with no
      // claims attached is a task allowed to touch nothing. Admissibility is
      // decided from claims, so an empty set makes every wave look disjoint —
      // the check passes and the first edit is what fails.
      it('gets the follow-up’s real claims from the log when checking a wave', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const followUpId = await mintFollowUp(sessionId, eventsDir, planPath);

        // A plan whose task claims the same tree the follow-up owns. If the
        // follow-up were admitted claimless, this wave would read as disjoint.
        const rivalPath = path.join(scratchDir, `${sessionId}-rival-plan.json`);
        await writeFile(
          rivalPath,
          JSON.stringify({
            ...PLAN,
            tasks: [{ ...PLAN.tasks[0], task_id: 'epic-1/task-3', claims: ['scripts/**'] }],
          }),
        );

        const result = runCli([
          'wave',
          'check',
          rivalPath,
          followUpId,
          'epic-1/task-3',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stdout);
        // Named apart on purpose: exit 1 here should mean "checked, and the
        // wave overlaps", not "could not resolve the id" — the two failures
        // share a status and say opposite things about whether this works.
        expect(parsed.error).toBeUndefined();
        expect(parsed.valid).toBe(false);
        expect(JSON.stringify(parsed)).toContain('scripts/release.sh');
      });

      it('still refuses an id neither the plan nor the log knows', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        await mintFollowUp(sessionId, eventsDir, planPath);

        const result = runCli([
          'wave',
          'check',
          planPath,
          'followup-deadbeef',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.message).toContain('no task "followup-deadbeef"');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });
    });

    // The same routing, reached the way the factory actually reaches it. Without
    // `--plan` wired through here, the ownership fix exists only in the library.
    /**
     * A committed task worktree, one commit ahead of `main`. Since P9-8 the gate
     * certifies the commit it is about to score, so a gate run needs a real
     * branch — a bare temp dir is exactly the thing it now refuses.
     */
    describe('gate run ownership (D-41/P9-24)', () => {
      it('does not block the gated task for a finding about another task’s file', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const worktreeDir = await committedWorktree('gate-ownership');
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        const evidencePath = path.join(scratchDir, `${sessionId}-evidence.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
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
        await writeFile(
          evidencePath,
          JSON.stringify([
            {
              file_path: 'src/bar/thing.ts',
              finding_category: 'correctness',
              severity: 'S2-major',
              summary: 'off-by-one in loop bound',
              failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
            },
          ]),
        );

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--evidence',
          evidencePath,
          '--found-by',
          'reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        // An S2 about src/bar/*.ts blocked task-1's diff before P9-24, and the
        // fix could not legally have been in that diff. Drop either half of the
        // wiring and this goes red: without --plan the finding stays on task-1
        // and blocks it, without the EventOpts the gate writes to the real
        // state/events/ instead of the dir the rest of the test reads.
        expect(result.status).toBe(0);
        const outcome = JSON.parse(result.stdout);
        expect(outcome.outcome).not.toBe('blocked');
        expect(outcome.reattributedFindings).toMatchObject([
          { taskId: 'epic-1/task-2', attribution: 'reassigned', filePath: 'src/bar/thing.ts' },
        ]);

        // --state-dir has to be honoured too, or the gate writes this run into
        // the real state/events/ log while the test reads an empty scratch dir.
        const records = tail(sessionId, eventsDir);
        expect(records.filter((r) => r.event_type === 'finding-raised')[0]?.task_id).toBe(
          'epic-1/task-2',
        );
        expect(records.filter((r) => r.event_type === 'finding-reattributed')).toHaveLength(1);
      });
    });

    // The ownership split reached the way the factory reaches it. Without these
    // flags wired through, `stampResultEnvelope` exists only in the library and
    // every real gate run still takes the agent's word for its own token count.
    describe('gate run --agent stamps the envelope (P9-17)', () => {
      /** What a worker is allowed to write once P9-17 lands: three keys. */
      const AGENT_HALF = {
        run_status: 'done',
        structured_output: {},
        artifacts: [],
      };

      async function gateRunWith(
        result: Record<string, unknown>,
        extraFlags: string[],
      ): Promise<{ stdout: string; status: number }> {
        const { sessionId, eventsDir } = await session();
        // A committed worktree, not the scratch dir: since P9-8 the gate
        // certifies the commit before it scores anything, so a bare directory
        // blocks on `not-committed` and never reaches the envelope (D-30).
        const worktreeDir = await committedWorktree(`p9-17-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(resultPath, JSON.stringify(result));
        return runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--base',
          'main',
          '--checks',
          checksPath,
          '--result',
          resultPath,
          ...extraFlags,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
      }

      const ENVELOPE_FLAGS = [
        '--agent',
        'coder',
        '--provider',
        'claude',
        '--model-tier',
        'mid',
        '--input-tokens',
        '19264',
        '--output-tokens',
        '4118',
      ];

      it('accepts a result file holding only the agent\u2019s three keys', async () => {
        const result = await gateRunWith(AGENT_HALF, ENVELOPE_FLAGS);
        expect(result.status).toBe(0);
        // Before P9-17 this file was rejected by result.schema.json for the
        // five fields it does not carry — the agent was obliged to invent them.
        expect(JSON.parse(result.stdout).outcome).not.toBe('blocked');
      });

      it('refuses a result whose agent wrote its own token_usage', async () => {
        const result = await gateRunWith(
          {
            ...AGENT_HALF,
            token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          },
          ENVELOPE_FLAGS,
        );
        expect(result.status).toBe(1);
        const { error } = JSON.parse(result.stdout);
        expect(error.code).toBe('results.agent-wrote-owned-field');
        expect(error.message).toContain('token_usage');
      });

      // The `--findings` half of the existing dual shape has a `--result`
      // twin: a replay hands over a complete document and nothing is stamped.
      it('leaves a complete result document alone when --agent is absent', async () => {
        const result = await gateRunWith(
          {
            ...AGENT_HALF,
            task_id: 'epic-1/task-1',
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          },
          [],
        );
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).outcome).not.toBe('blocked');
      });
    });

    describe('gate run budget (P9-18)', () => {
      async function budgetRun(opts: { withPlan: boolean }): Promise<{
        status: number;
        outcome: { budgetCheck?: Record<string, unknown> };
        records: ReturnType<typeof tail>;
      }> {
        const { sessionId, eventsDir } = await session();
        // A committed worktree, not the scratch dir: the P9-8 commit
        // certificate runs ahead of the budget check, so a bare directory
        // blocks on `not-committed` and never gets one. Its base branch does
        // not exist here, which is the point of the `unmeasurable` half — the
        // token cap is still read, and still overrun.
        const worktreeDir = await committedWorktree(`p9-18-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-b-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-b-result.json`);
        const planPath = path.join(scratchDir, `${sessionId}-b-plan.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
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
        // A cap the run has already blown, so a passing assertion can only mean
        // the number was read off this file and not defaulted from anywhere.
        await writeFile(
          planPath,
          JSON.stringify({
            ...PLAN,
            tasks: PLAN.tasks.map((t) => ({ ...t, budget: { tokens: 100, diff_lines: 100 } })),
          }),
        );

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          ...(opts.withPlan ? ['--plan', planPath] : []),
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        return {
          status: result.status,
          outcome: JSON.parse(result.stdout),
          records: tail(sessionId, eventsDir),
        };
      }

      it('checks the gated task’s declared caps against what the run actually spent', async () => {
        const { status, outcome, records } = await budgetRun({ withPlan: true });

        // Recorded, not blocking: an overrun is as often evidence the plan
        // under-estimated the task as evidence the task overran.
        expect(status).toBe(0);
        expect(outcome.budgetCheck).toMatchObject({
          tokensUsed: 150,
          overruns: [{ field: 'tokens', cap: 100, measured: 150 }],
        });

        const events = records.filter((r) => r.event_type === 'budget-check-result');
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toMatchObject({
          overruns: [{ field: 'tokens', cap: 100, measured: 150 }],
        });
      });

      it('says the budget was never declared rather than inventing one', async () => {
        const { status, outcome, records } = await budgetRun({ withPlan: false });

        expect(status).toBe(0);
        expect(outcome.budgetCheck).toMatchObject({ status: 'not-declared', overruns: [] });
        // Still emitted. A check that ran and found nothing to check is a
        // different fact from a check that never ran, and only one of them is
        // visible if the no-op stays silent (P9-23).
        expect(records.filter((r) => r.event_type === 'budget-check-result')).toHaveLength(1);
      });
    });

    // D-32/P9-13. A task normally has several judges, and `gate run` paired one
    // `--evidence` with one `--found-by`, so passing two judges' findings
    // through one gate meant concatenating them under a single attribution —
    // which makes at least one attribution false. Attribution feeds the
    // same-mistake quorum trigger, so a false one is a wrong decision later,
    // not a cosmetic label.
    describe('gate run multi-judge evidence (D-32/P9-13)', () => {
      function evidence(filePath: string, summary: string) {
        return [
          {
            file_path: filePath,
            finding_category: 'correctness',
            severity: 'S2-major',
            summary,
            failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
          },
        ];
      }

      /** The worktree and the two files a gate run needs before it will look at any evidence. */
      async function gateFixture(sessionId: string): Promise<[string, string, string]> {
        const worktreeDir = await committedWorktree(`p9-13-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
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
        return [worktreeDir, checksPath, resultPath];
      }

      async function evidenceFile(name: string, body: unknown): Promise<string> {
        const filePath = path.join(scratchDir, `${name}.json`);
        await writeFile(filePath, JSON.stringify(body));
        return filePath;
      }

      // Both findings are about src/bar/*.ts, which the plan gives to task-2:
      // the gate run being about task-1 is the point (this is how the real one
      // went), and it keeps the outcome unblocked so the assertions are about
      // attribution rather than about the testgate.
      it('mints each --evidence under the --found-by written after it', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(sessionId);
        const reviewer = await evidenceFile(
          `${sessionId}-reviewer`,
          evidence('src/bar/one.ts', 'off-by-one in loop bound'),
        );
        const security = await evidenceFile(
          `${sessionId}-security`,
          evidence('src/bar/two.ts', 'totality violation on the error branch'),
        );

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--evidence',
          reviewer,
          '--found-by',
          'reviewer',
          '--evidence',
          security,
          '--found-by',
          'security-reviewer',
          '--found-by-provider',
          'codex',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);

        const raised = tail(sessionId, eventsDir)
          .filter((r) => r.event_type === 'finding-raised')
          .map((r) => r.payload);
        // The finding carries the path only inside its fingerprint, so the
        // summary is what names which judge's evidence each record came from.
        expect(raised.map((f) => [f.summary, f.found_by, f.found_by_provider ?? null])).toEqual([
          ['off-by-one in loop bound', 'reviewer', null],
          ['totality violation on the error branch', 'security-reviewer', 'codex'],
        ]);
      });

      // The pre-P9-13 line — role before evidence — is what the skill, the docs
      // and every existing caller write. Flags were order-independent, so making
      // them positional must not turn a valid invocation into an error.
      it('still accepts the single-judge line with --found-by written first', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(sessionId);
        const only = await evidenceFile(
          `${sessionId}-legacy`,
          evidence('src/bar/one.ts', 'off-by-one in loop bound'),
        );

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--found-by',
          'reviewer',
          '--evidence',
          only,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);

        const raised = tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised');
        expect(raised).toHaveLength(1);
        expect(raised[0]?.payload.found_by).toBe('reviewer');
      });

      // The failure this item exists to prevent, in its cheapest form: an
      // evidence file with no role of its own and no leading default. Inheriting
      // the neighbouring judge's role is exactly the false attribution, so it
      // has to be an error that names the file — and it has to happen before any
      // finding is written, or the log carries half a gate run.
      it('refuses an --evidence with no --found-by, naming the file', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(sessionId);
        const reviewer = await evidenceFile(
          `${sessionId}-attributed`,
          evidence('src/bar/one.ts', 'off-by-one in loop bound'),
        );
        const orphan = await evidenceFile(
          `${sessionId}-orphan`,
          evidence('src/bar/two.ts', 'totality violation on the error branch'),
        );

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--evidence',
          reviewer,
          '--found-by',
          'reviewer',
          '--evidence',
          orphan,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        const error = JSON.parse(result.stdout).error;
        expect(error.code).toBe('cli.missing-flag');
        expect(error.message).toContain(orphan);
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised')).toEqual(
          [],
        );
      });

      // `findings raise` mints through the same helper and has the same judges.
      // Fixing one call site and not the other would leave the bug wherever the
      // operator happened to record the finding from.
      it('pairs the same way for findings raise', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const reviewer = await evidenceFile(
          `${sessionId}-raise-reviewer`,
          evidence('src/foo/one.ts', 'off-by-one in loop bound'),
        );
        const security = await evidenceFile(
          `${sessionId}-raise-security`,
          evidence('src/foo/two.ts', 'totality violation on the error branch'),
        );

        const result = runCli([
          'findings',
          'raise',
          '--evidence',
          reviewer,
          '--found-by',
          'reviewer',
          '--evidence',
          security,
          '--found-by',
          'security-reviewer',
          '--task',
          'epic-1/task-1',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);

        const raised = tail(sessionId, eventsDir)
          .filter((r) => r.event_type === 'finding-raised')
          .map((r) => r.payload);
        expect(raised.map((f) => f.found_by)).toEqual(['reviewer', 'security-reviewer']);
      });
    });

    // Same reason as the ownership block above: without `--grader` wired
    // through here, the grader gate exists only in the library, and the grader
    // file goes on being written and never read (D-34/P9-14).
    describe('gate run --grader (D-34/P9-14)', () => {
      async function gateFixtures(sessionId: string): Promise<{
        checksPath: string;
        resultPath: string;
        worktreeDir: string;
      }> {
        // Since D-30/P9-8 the commit certificate runs ahead of the rubric, so
        // these runs need a worktree that actually carries a commit — a bare
        // scratch dir blocks with `not-committed` before the grader is read.
        const worktreeDir = await committedWorktree(`p9-14-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
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
        return { checksPath, resultPath, worktreeDir };
      }

      function runGateWithGrader(
        sessionId: string,
        eventsDir: string,
        checksPath: string,
        resultPath: string,
        graderPath: string,
        worktreeDir: string,
      ) {
        return runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--grader',
          graderPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
      }

      it('blocks the gate, and exits 1, when the rubric says a criterion was not met', async () => {
        const { sessionId, eventsDir } = await session();
        const { checksPath, resultPath, worktreeDir } = await gateFixtures(sessionId);
        const graderPath = path.join(scratchDir, `${sessionId}-grader.json`);
        await writeFile(
          graderPath,
          JSON.stringify({
            run_status: 'done',
            structured_output: {
              round: 1,
              criteria: [
                {
                  criterion: 'a bare CR splits a line',
                  status: 'fail',
                  evidence: 'test/parse.test.ts:42 red',
                },
              ],
              overall: 'fail',
              gaps: ['the splitter still treats \\r as ordinary text'],
            },
            artifacts: [],
            token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
        );

        const result = runGateWithGrader(
          sessionId,
          eventsDir,
          checksPath,
          resultPath,
          graderPath,
          worktreeDir,
        );
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          outcome: 'blocked',
          reason: 'grader-fail',
        });

        const records = tail(sessionId, eventsDir);
        expect(records.filter((r) => r.event_type === 'grader-verdict')[0]?.payload).toMatchObject({
          verdict: 'not-met',
        });
        // The checks never ran: the rubric already decided this diff bounces.
        expect(records.filter((r) => r.event_type === 'testgate-result')).toEqual([]);
      });

      it('passes a met rubric through to the rest of the pipeline', async () => {
        const { sessionId, eventsDir } = await session();
        const { checksPath, resultPath, worktreeDir } = await gateFixtures(sessionId);
        const graderPath = path.join(scratchDir, `${sessionId}-grader.json`);
        await writeFile(
          graderPath,
          JSON.stringify({
            run_status: 'done',
            structured_output: {
              round: 2,
              criteria: [
                {
                  criterion: 'a bare CR splits a line',
                  status: 'pass',
                  evidence: 'test/parse.test.ts:42 green',
                },
              ],
              overall: 'pass',
            },
            artifacts: [],
            token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
        );

        const result = runGateWithGrader(
          sessionId,
          eventsDir,
          checksPath,
          resultPath,
          graderPath,
          worktreeDir,
        );
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).outcome).toBe('pass');

        const records = tail(sessionId, eventsDir);
        expect(records.filter((r) => r.event_type === 'grader-verdict')[0]?.payload).toMatchObject({
          verdict: 'met',
          round: 2,
        });
        expect(records.filter((r) => r.event_type === 'testgate-result')).toHaveLength(1);
      });
    });

    // D-30/P9-8: the gate scored a worktree while the queue merged a branch.
    // `--base` is what lets the CLI ask the second question the queue asks —
    // is this branch actually ahead of the integration head it was cut from.
    describe('gate run commit certification (D-30/P9-8)', () => {
      async function gateRunFixture(name: string) {
        const { sessionId, eventsDir } = await session();
        const worktreeDir = await committedWorktree(name);
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        // `touch ran-anyway.txt` rather than `true`: the certificate is only
        // worth anything if it lands before the checks spend a test run.
        await writeFile(
          checksPath,
          JSON.stringify([{ name: 'test', cmd: 'touch ran-anyway.txt' }]),
        );
        await writeFile(
          resultPath,
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
        const argv = (extra: string[]) => [
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          ...extra,
        ];
        return { sessionId, eventsDir, worktreeDir, argv };
      }

      it('exits 1 and names the uncommitted paths, before any check runs', async () => {
        const { worktreeDir, argv } = await gateRunFixture('gate-dirty');
        await writeFile(path.join(worktreeDir, 'src.ts'), 'export const x = 2;\n');

        const result = runCli(argv([]));

        expect(result.status).toBe(1);
        const outcome = JSON.parse(result.stdout);
        expect(outcome).toMatchObject({
          outcome: 'blocked',
          reason: 'not-committed',
          commitCheck: { certified: false, reason: 'uncommitted-work', dirty: ['src.ts'] },
        });
        expect(existsSync(path.join(worktreeDir, 'ran-anyway.txt'))).toBe(false);
      });

      it('--base refuses a branch head that still equals the base it was cut from', async () => {
        const { worktreeDir, argv, sessionId, eventsDir } = await gateRunFixture('gate-base');
        runOrThrow('git', ['checkout', '-q', '-b', 'smith/epic-1/task-9'], { cwd: worktreeDir });

        const result = runCli(argv(['--base', 'smith/epic-1/gate-base']));

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          outcome: 'blocked',
          reason: 'not-committed',
          commitCheck: { reason: 'branch-not-advanced', commitsAhead: 0 },
        });
        const check = tail(sessionId, eventsDir).find(
          (r) => r.event_type === 'commit-check-result',
        );
        expect(check?.payload).toMatchObject({
          certified: false,
          base_ref: 'smith/epic-1/gate-base',
          commits_ahead: 0,
        });
      });

      it('passes without --base rather than inventing a base to measure against', async () => {
        const { argv } = await gateRunFixture('gate-nobase');

        const result = runCli(argv([]));

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          outcome: 'pass',
          commitCheck: { certified: true, baseRef: null, commitsAhead: null },
        });
      });
    });
  });

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
    ): void {
      const dispatched = judgeCli('dispatch', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--role',
        role,
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

      // Exit 1, not 0: this is the re-poke signal. A wrapper that only reads
      // stdout still gets the list; a shell loop gets a status it can branch on.
      const outstanding = judgeCli('outstanding', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
      ]);
      expect(outstanding.status).toBe(1);
      expect(JSON.parse(outstanding.stdout)).toMatchObject([
        { role: 'security-reviewer', round: 1, declaredArtifact: artifact, reported: false },
      ]);
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
      expect(JSON.parse(outstanding.stdout)).toEqual([]);
    });

    it('report closes the turn and counts findings; outstanding then exits 0 on an empty list', async () => {
      const { sessionId, eventsDir, artifact } = await judgeSession();
      dispatchJudge(sessionId, eventsDir, 'reviewer', artifact);
      await writeFile(artifact, JSON.stringify([{ file_path: 'src/a.ts' }]));

      const reported = judgeCli('report', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
        '--role',
        'reviewer',
      ]);
      expect(reported.status).toBe(0);
      expect(JSON.parse(reported.stdout)).toMatchObject({
        role: 'reviewer',
        round: 1,
        artifactPath: artifact,
        findingCount: 1,
        attested: false,
      });

      const outstanding = judgeCli('outstanding', sessionId, eventsDir, [
        '--task',
        'epic-1/task-1',
      ]);
      expect(outstanding.status).toBe(0);
      expect(JSON.parse(outstanding.stdout)).toEqual([]);
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

  // The planner and the scribe write outside any worktree, so they have no
  // claims and no smith/<epic>/<task-id> branch — the check that used to exist
  // only for worktree agents now reaches them through --roots (P9-3).
  describe('claims check --roots (P9-3)', () => {
    let repoDir: string;

    beforeAll(async () => {
      repoDir = await mkdtemp(path.join(tmpdir(), 'smith-cli-roots-'));
      runOrThrow('git', ['init', '-q', '-b', 'main', repoDir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
      await writeFile(path.join(repoDir, 'README.md'), '# scratch\n');
      runOrThrow('git', ['add', '.'], { cwd: repoDir });
      runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
    });

    afterAll(async () => {
      if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    it('exits 0 on an ordinary branch when every write landed inside a root', async () => {
      await mkdir(path.join(repoDir, 'factory', 'specs', 'active', 'epic-1'), { recursive: true });
      await writeFile(path.join(repoDir, 'factory/specs/active/epic-1/plan-v1.json'), '{}\n');

      const { stdout, status } = runCli([
        'claims',
        'check',
        repoDir,
        '--roots',
        'factory/specs/active/epic-1/**',
      ]);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        inClaim: ['factory/specs/active/epic-1/plan-v1.json'],
        outOfClaim: [],
        violation: null,
      });
    });

    it('accumulates repeated --roots instead of keeping only the last one', async () => {
      await mkdir(path.join(repoDir, 'state', 'lessons'), { recursive: true });
      await writeFile(path.join(repoDir, 'state/lessons/epic-1.candidates.json'), '[]\n');

      // Last-wins on a repeated flag would drop the planner root and report the
      // plan file as a violation — the failure mode this test exists to catch.
      const { stdout, status } = runCli([
        'claims',
        'check',
        repoDir,
        '--roots',
        'factory/specs/active/epic-1/**',
        '--roots',
        'state/lessons/**',
      ]);
      expect(status).toBe(0);
      expect(JSON.parse(stdout).inClaim.sort()).toEqual([
        'factory/specs/active/epic-1/plan-v1.json',
        'state/lessons/epic-1.candidates.json',
      ]);
    });

    it('exits 1 and names the write-root violation when a role wrote outside its root', async () => {
      await writeFile(path.join(repoDir, 'README.md'), '# edited by a role that may not\n');

      const { stdout, status } = runCli([
        'claims',
        'check',
        repoDir,
        '--roots',
        'state/lessons/**',
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.violation).toEqual({
        error: 'contract.write-root-violation',
        files: expect.arrayContaining(['README.md']),
      });
    });

    it('with --since, also sees what the role committed itself (the planner holds Bash)', async () => {
      const since = runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).stdout.trim();
      await writeFile(path.join(repoDir, 'README.md'), '# committed by the role\n');
      runOrThrow('git', ['commit', '-q', '-am', 'role committed its own work'], { cwd: repoDir });

      // Working tree is clean for README.md now; without --since the check
      // would call this pass.
      const clean = runCli(['claims', 'check', repoDir, '--roots', 'state/lessons/**']);
      expect(JSON.parse(clean.stdout).outOfClaim).not.toContain('README.md');

      const { stdout, status } = runCli([
        'claims',
        'check',
        repoDir,
        '--roots',
        'state/lessons/**',
        '--since',
        since,
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).outOfClaim).toContain('README.md');
    });

    it('still requires a spec file when --roots is absent', () => {
      const { stdout, status } = runCli(['claims', 'check', repoDir]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.message).toContain('spec.json');
    });
  });

  // The blind spot `claims check` cannot see (P9-3): two disjoint claim lists
  // joined by an import edge.
  describe('claims impact', () => {
    let repoDir: string;
    let planPath: string;

    const IMPACT_PLAN = {
      epic_id: 'epic-1',
      version: 1,
      status: 'active',
      tasks: [
        {
          task_id: 'epic-1/task-a',
          epic_id: 'epic-1',
          plan_version: 1,
          objective: 'Own the producer.',
          output_schema_ref: 'result.schema.json',
          acceptance_criteria: ['it works'],
          claims: ['src/a.ts'],
          budget: { tokens: 1000, diff_lines: 100 },
          contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
        },
        {
          task_id: 'epic-1/task-b',
          epic_id: 'epic-1',
          plan_version: 1,
          objective: 'Own the consumer.',
          output_schema_ref: 'result.schema.json',
          acceptance_criteria: ['it works'],
          claims: ['src/b.ts'],
          budget: { tokens: 1000, diff_lines: 100 },
          contract: { functional_clauses: ['do it'], nonfunctional_clauses: [] },
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
        },
      ],
      edges: [],
    };

    beforeAll(async () => {
      repoDir = await mkdtemp(path.join(tmpdir(), 'smith-cli-impact-'));
      await mkdir(path.join(repoDir, 'src'), { recursive: true });
      await writeFile(
        path.join(repoDir, 'src/a.ts'),
        'export function parse(x: string) { return x; }\n',
      );
      await writeFile(
        path.join(repoDir, 'src/b.ts'),
        "import { parse } from './a.js';\nexport const b = parse('x');\n",
      );
      await writeFile(path.join(repoDir, 'src/c.ts'), 'export const c = 1;\n');
      planPath = path.join(repoDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(IMPACT_PLAN));
    });

    afterAll(async () => {
      if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    it('exits 1 and names the crossing when one task imports what another exports', () => {
      const { stdout, status } = runCli([
        'claims',
        'impact',
        '--plan',
        planPath,
        '--repo',
        repoDir,
        'epic-1/task-a',
        'epic-1/task-b',
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe('coupled');
      expect(parsed.crossings).toEqual([
        {
          producer: 'epic-1/task-a',
          consumer: 'epic-1/task-b',
          exportedBy: 'src/a.ts',
          importedBy: 'src/b.ts',
          symbols: ['parse'],
          typeOnly: false,
          dynamic: false,
        },
      ]);
    });

    it('exits 0 when no task in the wave imports what another one exports', async () => {
      const disjoint = {
        ...IMPACT_PLAN,
        tasks: IMPACT_PLAN.tasks.map((task, index) =>
          index === 1 ? { ...task, claims: ['src/c.ts'] } : task,
        ),
      };
      const disjointPath = path.join(repoDir, 'plan-disjoint.json');
      await writeFile(disjointPath, JSON.stringify(disjoint));

      const { stdout, status } = runCli([
        'claims',
        'impact',
        '--plan',
        disjointPath,
        '--repo',
        repoDir,
        'epic-1/task-a',
        'epic-1/task-b',
      ]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe('clean');
      expect(parsed.crossings).toEqual([]);
      // src/b.ts still imports src/a.ts, and nobody in this wave claims it.
      expect(parsed.exposure).toEqual([
        {
          producer: 'epic-1/task-a',
          exportedBy: 'src/a.ts',
          importedBy: 'src/b.ts',
          symbols: ['parse'],
        },
      ]);
    });

    it('refuses a wave with no task ids rather than pronouncing the empty set clean', () => {
      const { stdout, status } = runCli([
        'claims',
        'impact',
        '--plan',
        planPath,
        '--repo',
        repoDir,
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('cli.empty-wave');
    });

    describe('post-run, against a task branch', () => {
      let worktree: string;
      let specPath: string;

      beforeAll(async () => {
        worktree = await mkdtemp(path.join(tmpdir(), 'smith-cli-impact-run-'));
        runOrThrow('git', ['init', '-q', '-b', 'smith/epic-1/integration', worktree]);
        runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: worktree });
        runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: worktree });
        await mkdir(path.join(worktree, 'src'), { recursive: true });
        await writeFile(
          path.join(worktree, 'src/a.ts'),
          'export const kept = 1;\nexport const gone = 2;\n',
        );
        await writeFile(
          path.join(worktree, 'src/theirs.ts'),
          "import { gone } from './a.js';\nexport const t = gone;\n",
        );
        runOrThrow('git', ['add', '.'], { cwd: worktree });
        runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: worktree });
        runOrThrow('git', ['checkout', '-q', '-b', 'smith/epic-1/task-1'], { cwd: worktree });
        await writeFile(path.join(worktree, 'src/a.ts'), 'export const kept = 1;\n');
        runOrThrow('git', ['commit', '-q', '-am', 'drop gone'], { cwd: worktree });
        specPath = path.join(worktree, 'spec.json');
        await writeFile(
          specPath,
          JSON.stringify({ task_id: 'epic-1/task-1', claims: ['src/a.ts'] }),
        );
      });

      afterAll(async () => {
        if (worktree) await rm(worktree, { recursive: true, force: true });
      });

      it('exits 1 when a removed export is still imported outside the claims', () => {
        const { stdout, status } = runCli(['claims', 'impact', worktree, specPath]);
        expect(status).toBe(1);
        const parsed = JSON.parse(stdout);
        expect(parsed.ok).toBe(false);
        expect(parsed.breaks).toEqual([
          {
            severity: 'proven',
            reason: 'removed',
            exportedBy: 'src/a.ts',
            importedBy: 'src/theirs.ts',
            symbols: ['gone'],
          },
        ]);
      });

      it('exits 0 when the claims already cover every importer', async () => {
        const widePath = path.join(worktree, 'spec-wide.json');
        await writeFile(widePath, JSON.stringify({ task_id: 'epic-1/task-1', claims: ['src/**'] }));

        const { stdout, status } = runCli(['claims', 'impact', worktree, widePath]);
        expect(status).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.ok).toBe(true);
        expect(parsed.breaks).toEqual([]);
      });
    });
  });

  // The security-reviewer's trigger used to fire only when the orchestrator
  // remembered to check the glob list by eye (P9-4).
  describe('effort show', () => {
    const task = (overrides: Record<string, unknown> = {}) => ({
      task_id: 'epic-1/task-1',
      epic_id: 'epic-1',
      plan_version: 1,
      objective: 'Do the thing.',
      output_schema_ref: 'result.schema.json',
      acceptance_criteria: ['it works'],
      claims: ['src/foo/**'],
      budget: { tokens: 100, diff_lines: 10, max_turns: 5 },
      contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
      case: 'feature',
      origin: 'user',
      task_status: 'todo',
      ...overrides,
    });

    async function writePlan(name: string, overrides: Record<string, unknown>): Promise<string> {
      const planPath = path.join(scratchDir, name);
      await writeFile(
        planPath,
        JSON.stringify({
          epic_id: 'epic-1',
          version: 1,
          status: 'active',
          tasks: [task()],
          edges: [],
          ...overrides,
        }),
      );
      return planPath;
    }

    it("answers from the plan's own tier and returns the profile that tier buys", async () => {
      const planPath = await writePlan('effort-small.json', { effort: 'small' });
      const { stdout, status } = runCli(['effort', 'show', '--plan', planPath]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.requestedFrom).toBe('plan');
      expect(parsed.effective).toBe('small');
      expect(parsed.profile.specReviewRounds).toBe('single-pass');
      expect(parsed.profile.verifierSeverities).toEqual(['S1-stop-the-line']);
      expect(parsed.invariants.length).toBeGreaterThan(0);
    });

    it('falls back to the policy default when the plan names no tier', async () => {
      const planPath = await writePlan('effort-none.json', {});
      const { stdout, status } = runCli(['effort', 'show', '--plan', planPath]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.requested).toBeNull();
      expect(parsed.requestedFrom).toBe('default');
      expect(parsed.effective).toBe(parsed.defaultTier);
    });

    it('lifts a small epic to the security floor on a case: infra task', async () => {
      const planPath = await writePlan('effort-infra.json', {
        effort: 'small',
        tasks: [task({ case: 'infra' })],
      });
      const { stdout, status } = runCli(['effort', 'show', '--plan', planPath]);
      expect(status).toBe(0); // a floored tier is a plan for the run, not a violation
      const parsed = JSON.parse(stdout);
      expect(parsed.effective).toBe('medium');
      expect(parsed.floorApplied).toBe(true);
      expect(parsed.securityFloorEvaluated).toBe(true);
      expect(parsed.securityTriggers[0]).toMatchObject({ kind: 'security', matchType: 'case' });
    });

    it('answers with no plan at all, and says the floor was not evaluated', async () => {
      const { stdout, status } = runCli(['effort', 'show', '--effort', 'huge']);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.requestedFrom).toBe('flag');
      expect(parsed.effective).toBe('huge');
      expect(parsed.securityFloorEvaluated).toBe(false);
      expect(parsed.reason).toMatch(/not evaluated/);
    });

    it('names the tier it cannot read instead of quietly running the default', async () => {
      const { stdout, status } = runCli(['effort', 'show', '--effort', 'tiny']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('effort.unknown-tier');
      expect(parsed.error.message).toMatch(/tiny/);
      expect(parsed.error.message).toMatch(/small, medium, huge/);
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
        'juzser/black-smith#12',
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
      expect(findings.filter((f) => f.kind === 'unwatched-project' && f.subject === REPO_ROOT)).toEqual(
        [],
      );
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
      expect(findings.filter((f) => f.kind === 'unwatched-project' && f.subject === REPO_ROOT)).toEqual(
        [],
      );
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
  });
});
