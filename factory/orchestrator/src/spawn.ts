// A capped, detached-group child process — the mechanics both cli-transport.ts
// (an external judge, no worktree, no cwd) and runner.ts (smith-run, a
// harness that may hold a worktree) spawn a process the same way. Extracted
// so the two do not carry two copies of a timeout/size-cap/group-kill
// implementation that drift the way SpawnOnce's original inline copy would
// have, the day a second caller needed it.
import { spawn } from 'node:child_process';

export interface SpawnConfig {
  command: string;
  args: string[];
  /** Omitted by cli-transport.ts on purpose — see its call site. */
  cwd?: string;
  /** Child's environment. Omit to inherit this process's own (spawn's default). */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnBudget {
  timeout_ms: number;
  max_output_bytes: number;
}

export interface SpawnOutcome {
  /**
   * stdout+stderr interleaved, in arrival order. Named for what it is: a
   * judge's verdict has never been required to arrive on stdout, and calling
   * this field `stdout` is what made cli-transport.ts's original diagnostic
   * bug easy to write.
   */
  combined: string;
  /** stderr alone — kept apart so a refusal reason can be quoted without the payload. */
  stderr: string;
  /** Process exit code, or null if the child was signalled or never started. */
  exitCode: number | null;
  /** Signal that killed the child, if any. */
  signal: NodeJS.Signals | null;
  /** Set when the child could not be spawned at all (ENOENT, EACCES, …). */
  spawnError: Error | undefined;
  timedOut: boolean;
  sizeExceeded: boolean;
}

/**
 * One spawn: detached process group (POSIX `setsid` via `detached: true`) +
 * group-kill on timeout or size-cap breach — mirrors testgate.ts's runOne()
 * exactly (a spawned CLI can start its own children; a plain per-child kill
 * would orphan them the same way testgate's own regression note describes).
 */
export function spawnCapped(
  config: SpawnConfig,
  stdin: string,
  budget: SpawnBudget,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: config.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let combined = '';
    let stderr = '';
    let totalBytes = 0;
    let timedOut = false;
    let sizeExceeded = false;
    let settled = false;
    let spawnError: Error | undefined;

    const killGroup = (): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Group already gone — fine.
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, budget.timeout_ms);

    const onChunk = (chunk: Buffer): void => {
      totalBytes += chunk.length;
      if (totalBytes > budget.max_output_bytes) {
        if (!sizeExceeded) {
          sizeExceeded = true;
          killGroup();
        }
        return;
      }
      combined += chunk.toString('utf8');
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', (chunk: Buffer) => {
      // Still folded into `combined` for extraction — a judge that writes its
      // verdict to stderr has always worked and must keep working. The second
      // copy exists only so a refusal reason can be reported on its own.
      stderr += chunk.toString('utf8');
      onChunk(chunk);
    });

    child.stdin?.on('error', () => {
      // Child exited before consuming stdin (e.g. a fixture that errors
      // immediately) — writing to a closed pipe would otherwise raise an
      // unhandled EPIPE; the close handler below still resolves correctly.
    });
    child.stdin?.write(stdin);
    child.stdin?.end();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ combined, stderr, exitCode, signal, spawnError, timedOut, sizeExceeded });
    };

    child.on('error', (err: Error) => {
      // The child never ran (ENOENT, EACCES, …). Distinct from a child that
      // ran and failed: 'close' carries no code in this case.
      spawnError = err;
      finish(null, null);
    });
    child.on('close', finish);
  });
}
