import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { SmithError } from './errors.js';

export class TestGateError extends SmithError {}

export interface CheckCommand {
  name: string;
  cmd: string;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  exitCode: number;
  /**
   * The end of the check's combined stdout+stderr: at most `TAIL_LINES` lines
   * and at most `TAIL_MAX_CHARS` characters, whichever bites first. When
   * anything was dropped the tail says so on its first line — a fragment that
   * does not admit it is a fragment gets read as the whole run.
   */
  tail: string;
}

export interface RunOptions {
  cwd: string;
  /** Per-command timeout; default 5 minutes. */
  timeoutMs?: number;
  /** Run every check even after a failure. Default false (short-circuit). */
  runAll?: boolean;
}

export interface RunResult {
  results: CheckResult[];
  pass: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const TAIL_LINES = 50;
/**
 * How much of a check's output survives, in UTF-16 code units.
 *
 * `TAIL_LINES` bounds lines, and a bound on lines is not a bound on size: one
 * `--reporter=json` run, one minified bundle, one long `set -x` trace with no
 * newline in it is a single "line", so the line bound returns the whole thing
 * (D-189). Two things then have no ceiling. The `tail` goes verbatim into the
 * `testgate-result` event, and the event log is append-only — an unbounded
 * field there is written once and kept forever. And the output is accumulated
 * in the orchestrator's own heap while the check runs, which the per-command
 * timeout does not bound: a check that floods fills memory long before five
 * minutes are up, and an orchestrator that dies of it writes no gate event at
 * all. Generous on purpose — 50 lines of real test output fit inside this with
 * room to spare, and output that does not was never going to be read as lines.
 */
const TAIL_MAX_CHARS = 64 * 1024;
const DROPPED_NOTE = '[testgate] earlier output dropped — this is the tail, not the whole run';
const TIMEOUT_EXIT_CODE = -1;

function tailLines(text: string, n: number): string {
  // Drop one trailing newline first so a command's final real line doesn't
  // show up as a spurious empty "line" that pushes real content out of the tail.
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = trimmed.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/**
 * Name the signal a check died from, if it died from one.
 *
 * Two shapes reach us, because checks run through a shell (`shell: true`):
 * the shell itself signalled gives `signal` directly, while a signalled
 * *grandchild* is reported by the shell as exit code 128+N. Both used to land
 * in the results as a bare number with an empty tail, which reads as "the
 * tests failed" and sends the reader to the wrong subsystem entirely — the
 * mistake D-47 records. A crash is not a test failure and must not look like one.
 *
 * The 128+N branch is an inference, not an observation: a command free to pick
 * its own exit codes may return 137 meaning something of its own, and nothing
 * in the exit status distinguishes that from a shell reporting SIGKILL. The
 * shell throws that information away before we see it. So the note for that
 * branch is worded as the reading it is, and the caller keeps the raw code.
 */
function signalNote(code: number | null, signal: NodeJS.Signals | null): string | null {
  if (signal !== null) {
    return `[testgate] the check process was killed by ${signal} — it crashed, it did not fail`;
  }
  if (code !== null && code > 128 && code < 128 + 65) {
    const number = code - 128;
    const name = Object.entries(osConstants.signals).find(([, n]) => n === number)?.[0];
    if (name !== undefined) {
      return (
        `[testgate] exit code ${code} is the shell's convention for a command killed by ` +
        `${name} (128+${number}) — read it as a crash, not a test failure, unless this check ` +
        'is known to use that exit code itself'
      );
    }
  }
  return null;
}

/**
 * Run one check command in its own process group (POSIX `setsid`, via
 * `detached: true`) so a timeout can kill the WHOLE group — `process.kill`
 * with a negative pid signals every process in that group, not just the
 * immediate shell child. A plain per-child kill (e.g. execFileSync's
 * built-in `timeout`) leaves grandchildren the shell spawned (background
 * jobs, long-lived children) running as orphans after the parent shell
 * dies — a real leak in a 24/7 factory (reproduced: manual kill -9 needed).
 */
function runOne(check: CheckCommand, cwd: string, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn(check.cmd, {
      cwd,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let dropped = false;
    let timedOut = false;

    /**
     * Keep the last `TAIL_MAX_CHARS` and drop the rest as it arrives. Trimming
     * at the end would bound the field and not the buffer, and the buffer is
     * the half that can take the orchestrator down with it.
     */
    const absorb = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > TAIL_MAX_CHARS) {
        output = output.slice(-TAIL_MAX_CHARS);
        dropped = true;
      }
    };

    /** The reported tail, admitting the drop when there was one. */
    const tailOf = (text: string): string => {
      const kept = tailLines(text, TAIL_LINES);
      return dropped ? `${DROPPED_NOTE}\n${kept}` : kept;
    };

    child.stdout?.on('data', absorb);
    child.stderr?.on('data', absorb);

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL'); // negative pid -> whole process group
        } catch {
          // Group already gone (command finished between the timer firing and here) — fine.
        }
      }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        name: check.name,
        pass: false,
        exitCode: 1,
        tail: tailOf(err.message),
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        const timeoutNote = `[testgate] "${check.name}" timed out after ${timeoutMs}ms — process group killed`;
        resolve({
          name: check.name,
          pass: false,
          exitCode: TIMEOUT_EXIT_CODE,
          tail: tailOf(output ? `${output}\n${timeoutNote}` : timeoutNote),
        });
        return;
      }
      const exitCode = code !== null ? code : signal ? -1 : 1;
      const note = signalNote(code, signal);
      const annotated = note === null ? output : output ? `${output}\n${note}` : note;
      resolve({
        name: check.name,
        pass: exitCode === 0,
        exitCode,
        tail: tailOf(annotated),
      });
    });
  });
}

/**
 * Run configured check commands (test/typecheck/lint/coverage/…) sequentially
 * in a worktree, one process per command, with a per-command timeout. First
 * failure short-circuits the remaining checks unless `runAll` is set. Thin —
 * no test-output parsing beyond the process exit code.
 */
export async function run(checks: CheckCommand[], opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: CheckResult[] = [];

  for (const check of checks) {
    const result = await runOne(check, opts.cwd, timeoutMs);
    results.push(result);
    if (!result.pass && !opts.runAll) break;
  }

  return { results, pass: results.length > 0 ? results.every((r) => r.pass) : true };
}

/**
 * Cumulative regression gate (architecture §11): the epic's single test
 * command, standing in for "every previously merged task's tests in the
 * epic" — the caller is responsible for pointing `epicTestCmd` at whatever
 * aggregate command covers that (e.g. the epic's full suite), this module
 * has no opinion on what's inside it. A thin wrapper over `run`, not a
 * separate code path.
 */
export async function runCumulative(epicTestCmd: string, opts: RunOptions): Promise<RunResult> {
  return run([{ name: 'cumulative', cmd: epicTestCmd }], opts);
}
