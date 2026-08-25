import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertExited, describeExit, runOrThrow, runProcess } from './helpers/process.js';

// A path that cannot exist, so execFileSync fails to spawn rather than
// running something that exits non-zero.
const MISSING_BINARY = path.join(path.sep, 'nonexistent-dir-p9-30', 'no-such-binary');

describe('runProcess', () => {
  it('reports a clean exit 0 with its stdout', () => {
    const run = runProcess(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(run).toMatchObject({ stdout: 'hi', status: 0, signal: null, spawnError: null });
  });

  it('carries stderr and the exit code of a child that ran and failed', () => {
    const run = runProcess(process.execPath, [
      '-e',
      'process.stderr.write("boom"); process.exit(3)',
    ]);
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('boom');
    expect(run.spawnError).toBeNull();
  });

  // P9-16(b): the stderr of a child that SUCCEEDED was being thrown away —
  // `execFileSync` returns stdout alone, so the old helper hardcoded
  // `stderr: ''` on the happy path. A test asserting "this command is quiet"
  // then passes without ever looking, which is worse than not having it.
  it('carries stderr of a child that exited 0 — a warning is not a failure', () => {
    const run = runProcess(process.execPath, ['-e', 'process.stderr.write("warned")']);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('warned');
  });

  it('reports a child killed by a signal as signalled, never as an exit code', () => {
    const run = runProcess(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")']);
    expect(run.signal).toBe('SIGKILL');
    expect(run.status).toBeNull();
  });

  // D-47's disease one layer up: a process that never started must not look
  // like a process that ran and exited 1 with nothing to say.
  it('distinguishes a spawn failure from a silent exit 1', () => {
    const run = runProcess(MISSING_BINARY, []);
    expect(run.spawnError).toBe('ENOENT');
    expect(run.status).toBeNull();
    expect(run.signal).toBeNull();
  });
});

describe('describeExit', () => {
  it('names the spawn failure when the child never started', () => {
    expect(describeExit(runProcess(MISSING_BINARY, []))).toContain('ENOENT');
  });

  it('names the signal when the child was killed', () => {
    expect(describeExit({ stdout: '', stderr: '', status: null, signal: 'SIGSEGV' })).toBe(
      'killed by SIGSEGV',
    );
  });

  it('names the exit code when the child exited', () => {
    expect(describeExit({ stdout: '', stderr: '', status: 2, signal: null })).toBe('exit 2');
  });
});

describe('runOrThrow', () => {
  it('throws naming the missing binary rather than "failed with exit 1 and no output"', () => {
    let message = '';
    try {
      runOrThrow(MISSING_BINARY, ['--version']);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('ENOENT');
    expect(message).toContain(MISSING_BINARY);
    expect(message).not.toContain('exit 1');
  });

  it('returns the run when the command succeeds', () => {
    expect(runOrThrow(process.execPath, ['-e', 'process.stdout.write("ok")']).stdout).toBe('ok');
  });
});

describe('assertExited', () => {
  it('also fires on a spawn failure, which is not a legitimate outcome either', () => {
    expect(() => assertExited(runProcess(MISSING_BINARY, []), 'probe')).toThrow(/ENOENT/);
  });

  it('stays silent on an ordinary non-zero exit', () => {
    expect(() =>
      assertExited(runProcess(process.execPath, ['-e', 'process.exit(1)']), 'probe'),
    ).not.toThrow();
  });
});
