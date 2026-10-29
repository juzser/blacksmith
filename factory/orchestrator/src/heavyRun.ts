import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { type HeavyLockOptions, withHeavyLock } from './heavyLock.js';
import { heavyChildEnv } from './testgate.js';

const FORWARDED: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Run `cmd` under the machine-wide heavy lock and return the exit code to
 * use: the child's own code, or 128 + the signal number when a signal ended
 * it. SIGINT, SIGTERM and SIGHUP received while the child runs are forwarded
 * to the child's pid only; the lock stays held until the child has exited.
 * argv array, no shell.
 */
export function runUnderHeavyLock(
  cmd: string,
  cmdArgs: string[],
  lockOptions: HeavyLockOptions,
): Promise<number> {
  return withHeavyLock(
    (lease) =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(cmd, cmdArgs, {
          env: heavyChildEnv(process.env, lease),
          stdio: 'inherit',
        });
        let finished = false;
        const handlers = FORWARDED.map((sig) => {
          const handler = () => {
            if (!finished) child.kill(sig);
          };
          process.on(sig, handler);
          return [sig, handler] as const;
        });
        const finish = (settle: () => void) => {
          finished = true;
          for (const [sig, handler] of handlers) process.off(sig, handler);
          settle();
        };
        child.on('error', (err) => finish(() => reject(err)));
        child.on('close', (code, signal) =>
          finish(() => resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1))),
        );
      }),
    lockOptions,
  );
}
