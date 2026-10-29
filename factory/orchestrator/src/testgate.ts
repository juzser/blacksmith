import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { BS_PREFIX, LEGACY_PREFIX } from './env.js';
import { SmithError } from './errors.js';
import { redactCredentials } from './git.js';
import { type HeavyLease, type HeavyLockOptions, withHeavyLock } from './heavyLock.js';

// No TestGateError: a command that fails, times out or is killed is a
// CheckResult with the exit code and the output in it. Throwing would lose
// exactly the evidence the gate exists to collect.

export interface CheckCommand {
  name: string;
  cmd: string;
  /**
   * Per-check override for the timeout every other check in the file shares
   * (`RunOptions.timeoutMs`, defaulting to `DEFAULT_TIMEOUT_MS`), in
   * milliseconds. A single check known to run long — this repo's own full
   * suite takes ~350s on a loaded machine, past the 5-minute default — used to
   * force every check in the same file onto a bigger shared number, or fail
   * closed with no way to say "just this one." Validated fail-closed at the
   * point the checks file is read (cli.ts's `readChecksFile`): a non-positive
   * or non-integer value is refused before it ever reaches `setTimeout`.
   */
  timeout_ms?: number;
  /**
   * Explicit heavy-check marker (epic bs-optimize criterion 10): `true` takes
   * the machine-wide heavy lock, `false` never does. Absent, `isHeavyCheck`
   * decides from the name.
   */
  heavy?: boolean;
}

/**
 * Whether a check runs under the heavy lock: an explicit boolean `heavy`
 * wins, else the name is `unit` or `coverage` or starts with `test` or `e2e`.
 * Serves epic bs-optimize criterion 10 (gate rules).
 */
export function isHeavyCheck(check: Pick<CheckCommand, 'name' | 'heavy'>): boolean {
  if (typeof check.heavy === 'boolean') return check.heavy;
  const { name } = check;
  return (
    name === 'unit' || name === 'coverage' || name.startsWith('test') || name.startsWith('e2e')
  );
}

export interface CheckResult {
  name: string;
  /**
   * The command the check ran, with credential values masked
   * (`maskCommandCredentials`). Set only where a record is written for a
   * reader who needs to know what ran (the integration check); absent on
   * results from `run` and on records written before it was stored.
   */
  cmd?: string;
  pass: boolean;
  exitCode: number;
  /**
   * The end of the check's combined stdout+stderr: at most `TAIL_LINES` lines
   * and at most `TAIL_MAX_CHARS` characters, whichever bites first. When
   * anything was dropped the tail says so on its first line — a fragment that
   * does not admit it is a fragment gets read as the whole run.
   */
  tail: string;
  /**
   * Milliseconds spent waiting for the heavy lock before the check started;
   * 0 for a check that never takes it. Not counted against `timeout_ms`.
   */
  lock_wait_ms?: number;
  /** Set to `heavy.wait-timeout` when the check failed because the lock wait timed out. */
  reason?: string;
}

/** `key` also covers API_KEY and APIKEY; `passw` covers PASSWORD and PASSWD. */
const SENSITIVE_NAME = /key|token|secret|passw|pwd|credential|auth/i;
/** A quoted value whole, or an unquoted one up to whitespace. */
const VALUE = String.raw`"[^"]*"|'[^']*'|\S+`;
const ENV_ASSIGNMENT = new RegExp(String.raw`(^|[\s;&|(])([A-Za-z_]\w*)=(?:${VALUE})`, 'g');
/** A bare flag's value is the next word, unless that word is a flag or a shell operator. */
const LONG_FLAG = new RegExp(String.raw`(^|\s)(--[\w-]+)(=|\s+(?![-;&|]))(?:${VALUE})`, 'g');

/**
 * A declared check command with its credential values replaced by `***`:
 * URL userinfo, the value of a `NAME=value` env assignment whose name reads
 * as a secret, and the value of such a long flag (`--token=x`, `--password x`).
 *
 * Defence in depth for a command the project declared, not a general secret
 * scanner. `projectCommandEnv` documents stating env inside the command
 * string, and a stored command goes to the append-only event log, the CLI's
 * JSON and an external judge's prompt, so a value typed there inline is
 * masked once, before the record is written. It errs toward masking.
 */
export function maskCommandCredentials(cmd: string): string {
  return redactCredentials(cmd)
    .replace(ENV_ASSIGNMENT, (match, lead: string, name: string) =>
      SENSITIVE_NAME.test(name) ? `${lead}${name}=***` : match,
    )
    .replace(LONG_FLAG, (match, lead: string, flag: string, sep: string) =>
      SENSITIVE_NAME.test(flag) ? `${lead}${flag}${sep}***` : match,
    );
}

export interface RunOptions {
  cwd: string;
  /** Per-command timeout; default 5 minutes. */
  timeoutMs?: number;
  /** Run every check even after a failure. Default false (short-circuit). */
  runAll?: boolean;
  /** Lock knobs for tests; `run` passes `process.env` as the lock's env. */
  heavyLock?: Pick<HeavyLockOptions, 'lockDir' | 'pollMs' | 'maxWaitMs' | 'isPidAlive' | 'env'>;
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
 * The environment a project's command runs in: this process's, minus the
 * factory's own namespace.
 *
 * A command the factory launches on a project's behalf belongs to the
 * project, not to the factory that launched it. Every `BS_*` variable — and,
 * for the transition period, every legacy `SMITH_*` one — in this process
 * was set for *this* process, and letting one through silently makes the
 * factory's own invocation part of the project's verdict. `BS_HOME` (nee
 * `SMITH_HOME`) is the one that bites: it moves `WORK_ROOT` off the
 * worktree, so a suite that asserts its own layout fails on the launcher's
 * environment alone, and anything the suite writes to state lands in the
 * factory's live `state/` instead of the worktree's. The verdict then
 * depends on how the factory happened to be invoked, which is not a verdict
 * about the branch.
 *
 * The strip is a rule rather than a roster, deliberately: a roster is a list
 * that goes stale the next time a `BS_*`/`SMITH_*` variable is added, and it
 * goes stale silently. Not every one of them is the factory configuring
 * itself — `BS_CROSSCHECK_OFFLINE` is an operator switch — but the runbook
 * already says of that one "pass it per command"
 * (`docs/runbooks/providers.md`, and it names an ambient copy of that switch
 * as its own hazard). The command the operator means is the one running
 * here, not the factory that spawned it, and stating it inside the command
 * string works: the shell applies it after this strip.
 */
export function projectCommandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !name.startsWith(BS_PREFIX) && !name.startsWith(LEGACY_PREFIX),
    ),
  );
}

/**
 * `projectCommandEnv(env)` plus the lease a heavy child needs to re-enter the
 * lock it runs under: `BS_HEAVY_LOCK_TOKEN` and `BS_HEAVY_LOCK_DIR`, and
 * nothing else from the `BS_`/`SMITH_` namespaces. The epic's one add-back,
 * kept beside the strip it undoes. Serves epic bs-optimize criterion 10.
 */
export function heavyChildEnv(env: NodeJS.ProcessEnv, lease: HeavyLease): NodeJS.ProcessEnv {
  return {
    ...projectCommandEnv(env),
    BS_HEAVY_LOCK_TOKEN: lease.token,
    BS_HEAVY_LOCK_DIR: lease.lockDir,
  };
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
function runOne(
  check: CheckCommand,
  cwd: string,
  defaultTimeoutMs: number,
  childEnv: NodeJS.ProcessEnv,
): Promise<CheckResult> {
  return new Promise((resolve) => {
    const timeoutMs = check.timeout_ms ?? defaultTimeoutMs;
    const child = spawn(check.cmd, {
      cwd,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
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
 * One heavy check under the machine lock, taken when its turn comes and
 * released before the next check. The lock wait is reported as `lock_wait_ms`
 * and never counts against the check's timeout; a wait timeout fails the
 * check with reason `heavy.wait-timeout`.
 */
async function runHeavy(
  check: CheckCommand,
  opts: RunOptions,
  defaultTimeoutMs: number,
): Promise<CheckResult> {
  const waitStart = Date.now();
  try {
    return await withHeavyLock(
      async (lease) => {
        const lock_wait_ms = Date.now() - waitStart;
        const env = opts.heavyLock?.env ?? process.env;
        const result = await runOne(check, opts.cwd, defaultTimeoutMs, heavyChildEnv(env, lease));
        return { ...result, lock_wait_ms };
      },
      { ...opts.heavyLock, label: `gate-${check.name}`, cwd: opts.cwd },
    );
  } catch (err) {
    if (!(err instanceof SmithError) || err.code !== 'heavy.wait-timeout') throw err;
    return {
      name: check.name,
      pass: false,
      exitCode: 1,
      tail: err.message,
      reason: 'heavy.wait-timeout',
      lock_wait_ms: Date.now() - waitStart,
    };
  }
}

/**
 * Run configured check commands (test/typecheck/lint/coverage/…) sequentially
 * in a worktree, one process per command, with a per-command timeout. First
 * failure short-circuits the remaining checks unless `runAll` is set. Thin —
 * no test-output parsing beyond the process exit code.
 */
export async function run(checks: CheckCommand[], opts: RunOptions): Promise<RunResult> {
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: CheckResult[] = [];

  for (const check of checks) {
    const result = isHeavyCheck(check)
      ? await runHeavy(check, opts, defaultTimeoutMs)
      : {
          ...(await runOne(check, opts.cwd, defaultTimeoutMs, projectCommandEnv(process.env))),
          lock_wait_ms: 0,
        };
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
  return run([{ name: 'cumulative', cmd: epicTestCmd, heavy: true }], opts);
}
