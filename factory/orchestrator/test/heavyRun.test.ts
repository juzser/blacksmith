import { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUnderHeavyLock } from '../src/heavyRun.js';

// Direct coverage of runUnderHeavyLock (bs-optimize followup 0cda4bb8). The
// lock lives in a temp dir, never the machine lock. Signals are delivered with
// process.emit, so the vitest worker is never really signalled; every child
// the tests start is reaped by the call itself or told to stop via a file.

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'heavyrun-'));
});
afterEach(async () => {
  // Release any child a failed test left polling, so it exits on its own.
  writeFileSync(path.join(dir, 'stop'), 'x');
  await new Promise((r) => setTimeout(r, 50));
  await rm(dir, { recursive: true, force: true });
});

const lockOpts = () => ({
  lockDir: path.join(dir, 'locks'),
  label: 'heavy-run-test',
  cwd: dir,
  pollMs: 5,
  maxWaitMs: 0,
  env: {} as NodeJS.ProcessEnv,
});
const lockFile = () => path.join(dir, 'locks', 'heavy.lock');
const counts = () => SIGNALS.map((s) => process.listenerCount(s));

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A child that logs each trapped signal, then exits 0 once `stop` exists. */
function writeTrapChild(): { script: string; log: string; ready: string; stop: string } {
  const script = path.join(dir, 'trap.cjs');
  const log = path.join(dir, 'signals.log');
  const ready = path.join(dir, 'ready');
  const stop = path.join(dir, 'stop');
  writeFileSync(
    script,
    `const fs = require('fs');
for (const s of ['SIGINT','SIGTERM','SIGHUP']) process.on(s, () => fs.appendFileSync(${JSON.stringify(log)}, s + '\\n'));
fs.writeFileSync(${JSON.stringify(ready)}, 'x');
setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0); }, 10);
`,
  );
  return { script, log, ready, stop };
}

const logged = (log: string): string[] =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];

describe('runUnderHeavyLock', () => {
  it('passes a normal exit code through', async () => {
    const code = await runUnderHeavyLock(process.execPath, ['-e', 'process.exit(3)'], lockOpts());
    expect(code).toBe(3);
  });

  it('maps a signal-killed child to 128 + the signal number', async () => {
    const kill = (sig: string) =>
      runUnderHeavyLock(
        process.execPath,
        ['-e', `process.kill(process.pid, '${sig}')`],
        lockOpts(),
      );
    expect(await kill('SIGKILL')).toBe(137);
    expect(await kill('SIGTERM')).toBe(143);
  });

  it('forwards SIGINT and SIGHUP once each to the child, then exits with its code', async () => {
    const c = writeTrapChild();
    const run = runUnderHeavyLock(process.execPath, [c.script], lockOpts());
    await until(() => existsSync(c.ready), 'child ready');
    process.emit('SIGINT');
    await until(() => logged(c.log).length === 1, 'SIGINT at child');
    process.emit('SIGHUP');
    await until(() => logged(c.log).length === 2, 'SIGHUP at child');
    writeFileSync(c.stop, 'x');
    expect(await run).toBe(0);
    expect(logged(c.log)).toEqual(['SIGINT', 'SIGHUP']);
  });

  it('forwards SIGTERM only to the child and keeps the lock until it exits', async () => {
    const c = writeTrapChild();
    const run = runUnderHeavyLock(process.execPath, [c.script], lockOpts());
    await until(() => existsSync(c.ready), 'child ready');
    expect(existsSync(lockFile())).toBe(true);
    process.emit('SIGTERM');
    await until(() => logged(c.log).length === 1, 'SIGTERM at child');
    expect(logged(c.log)).toEqual(['SIGTERM']);
    // the child ignored the signal and still runs: the lock is still held
    expect(existsSync(lockFile())).toBe(true);
    writeFileSync(c.stop, 'x');
    await run;
    expect(existsSync(lockFile())).toBe(false);
  });

  it('removes its handlers after a successful run', async () => {
    const before = counts();
    await runUnderHeavyLock(process.execPath, ['-e', ''], lockOpts());
    expect(counts()).toEqual(before);
  });

  it('adds one handler per signal while the child runs', async () => {
    const c = writeTrapChild();
    const before = counts();
    const run = runUnderHeavyLock(process.execPath, [c.script], lockOpts());
    await until(() => existsSync(c.ready), 'child ready');
    expect(counts()).toEqual(before.map((n) => n + 1));
    writeFileSync(c.stop, 'x');
    await run;
  });

  it('rejects on a spawn error, removes its handlers and frees the lock', async () => {
    const before = counts();
    await expect(
      runUnderHeavyLock(path.join(dir, 'no-such-command'), [], lockOpts()),
    ).rejects.toThrow(/ENOENT/);
    expect(counts()).toEqual(before);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('forwards nothing for a signal that arrives after the child exited', async () => {
    const c = writeTrapChild();
    const run = runUnderHeavyLock(process.execPath, [c.script], lockOpts());
    await until(() => existsSync(c.ready), 'child ready');
    writeFileSync(c.stop, 'x');
    await run;
    const kill = vi.spyOn(ChildProcess.prototype, 'kill');
    // Own harmless listener so an unhandled emit has somewhere to land.
    const noop = () => {};
    for (const s of SIGNALS) process.on(s, noop);
    try {
      for (const s of SIGNALS) process.emit(s);
    } finally {
      for (const s of SIGNALS) process.off(s, noop);
      expect(kill).not.toHaveBeenCalled();
      kill.mockRestore();
    }
    expect(logged(c.log)).toEqual([]);
  });

  it('frees the lock after the child exits, for the next run', async () => {
    await runUnderHeavyLock(process.execPath, ['-e', ''], lockOpts());
    expect(existsSync(lockFile())).toBe(false);
    expect(await runUnderHeavyLock(process.execPath, ['-e', 'process.exit(5)'], lockOpts())).toBe(
      5,
    );
  });
});
