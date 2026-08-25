// Shared child-process runner for the test tree.
//
// Exists because of finding D-47: `execFileSync` reports a child killed by a
// signal as `status: null` + `signal: 'SIGSEGV'`, and the old per-file helpers
// did `e.status ?? 1`. That collapses a crash and a clean exit 1 into the same
// value, so every assertion downstream describes the wrong failure. Here the
// signal is carried through and `assertExited` turns it into a sentence. The
// same reasoning covers a child that never spawned (`spawnError` below).
import { spawnSync } from 'node:child_process';

export interface ProcessRun {
  stdout: string;
  /** Captured, not inherited — a failure's explanation usually lives here. */
  stderr: string;
  /** Exit code, or null when the child was killed by a signal. */
  status: number | null;
  /** Signal name when the child was killed by one, else null. */
  signal: string | null;
  /**
   * errno code when the child never started at all (`ENOENT` for a missing
   * binary, `EACCES` for one that is not executable), else null. Same class
   * of mistake as D-47 one layer further up: without this, a process that
   * failed to spawn is indistinguishable from one that ran and exited 1 with
   * nothing to say, and the reader goes looking for a bug in a program that
   * never executed.
   */
  spawnError?: string | null;
}

export interface RunOpts {
  cwd?: string;
  input?: string;
  /**
   * Full environment for the child. Omitted means inherit, as before; passing
   * one is how a test puts its own binaries on PATH ahead of the real ones
   * (the scaffold's toolchain run, P9-19) without touching this process's env.
   */
  env?: NodeJS.ProcessEnv;
}

export function runProcess(file: string, args: string[], opts: RunOpts = {}): ProcessRun {
  // spawnSync rather than execFileSync: the latter returns stdout ALONE on
  // success, so a child that exited 0 after writing to stderr came back
  // looking silent (P9-16b — a "this command is quiet" assertion that never
  // looked). spawnSync hands back both streams on every path, and reports a
  // signal, an exit code and a spawn failure as three distinct things rather
  // than as one thrown Error to be picked apart.
  const run = spawnSync(file, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    input: opts.input,
    ...(opts.env ? { env: opts.env } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // `error` is set only when the child never ran; errno lives in `code`.
  const spawnError = run.error
    ? ((run.error as NodeJS.ErrnoException).code ?? run.error.message)
    : null;
  const signal = run.signal ?? null;
  // Only default to 1 when the child actually ran — a signalled child has
  // status null, and one that never started has no exit code to report.
  const status = run.status ?? (signal === null && spawnError === null ? 1 : null);
  return { stdout: run.stdout ?? '', stderr: run.stderr ?? '', status, signal, spawnError };
}

/**
 * Run a command that is setup rather than subject — a build, a fixture step —
 * and fail with what the command actually said. `execFileSync` with piped
 * stdio throws "Command failed: pnpm build" and nothing else, which is the
 * same evidence-deleting move as D-47 one layer up.
 */
export function runOrThrow(file: string, args: string[], opts: RunOpts = {}): ProcessRun {
  const run = runProcess(file, args, opts);
  assertExited(run, `${file} ${args.join(' ')}`);
  if (run.status !== 0) {
    const said = [run.stderr, run.stdout].filter((s) => s.trim() !== '').join('\n');
    throw new Error(
      `${file} ${args.join(' ')} failed with ${describeExit(run)}` +
        (said === '' ? ' and no output' : `:\n${said}`),
    );
  }
  return run;
}

/**
 * git as a test FIXTURE — a repo to run the subject against, never the
 * subject itself. Piped like everything else here, because the old per-file
 * `execFileSync('git', …)` helpers inherited stderr and filled the test log
 * with `warning: You appear to have cloned an empty repository.` and
 * `Preparing worktree (…)`. That noise is what made P9-16(b)'s real leak
 * invisible for two waves: a log that always shouts cannot report anything.
 */
export function git(cwd: string, args: string[]): string {
  return runOrThrow('git', args, { cwd }).stdout;
}

/** Human-readable one-liner for how a child ended. */
export function describeExit(run: ProcessRun): string {
  if (run.spawnError) return `not started (${run.spawnError})`;
  if (run.signal !== null) return `killed by ${run.signal}`;
  return `exit ${run.status}`;
}

/**
 * Fail loudly when a child ended any way other than by exiting — killed by a
 * signal, or never spawned at all. Neither is a legitimate test outcome, and
 * reporting either as an exit code sends the reader to the wrong subsystem
 * (D-47 cost a full false diagnosis that way).
 */
export function assertExited(run: ProcessRun, label: string): void {
  if (run.signal === null && !run.spawnError) return;
  const said = [run.stderr, run.stdout].filter((s) => s.trim() !== '').join('\n');
  const diagnosis = run.spawnError
    ? 'the process never started, so nothing it would have done was tested. ' +
      'Check the command path and that it is executable.'
    : 'the process crashed, it did not fail. This is not an assertion failure; ' +
      'check the runtime and native bindings first (see P9-30).';
  let trailer = '';
  if (said !== '') trailer = `\n${said}`;
  else if (!run.spawnError) trailer = ' The process produced no output before dying.';
  throw new Error(`${label} was ${describeExit(run)} — ${diagnosis}${trailer}`);
}
