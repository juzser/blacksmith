import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertRuntimeSupported,
  checkRuntime,
  currentRuntime,
  MIN_NAPI,
  MIN_NODE_MAJOR,
  nodeMajor,
  UnsupportedRuntimeError,
} from '../src/runtime.js';
import { assertExited, describeExit, runOrThrow, runProcess } from './helpers/process.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('runtime.ts — the unsupported-runtime guard (P9-30 / D-47)', () => {
  it('parses the major out of a version string, with or without the v', () => {
    expect(nodeMajor('v22.23.1')).toBe(22);
    expect(nodeMajor('20.14.0')).toBe(20);
    expect(nodeMajor('not-a-version')).toBeNull();
  });

  it('accepts the runtime it is actually running on', () => {
    // The suite is only ever expected to run on a supported runtime; if this
    // fails, the guard is doing its job and the interpreter is the bug.
    expect(checkRuntime().supported).toBe(true);
    expect(checkRuntime().reason).toBeNull();
    expect(() => assertRuntimeSupported()).not.toThrow();
  });

  it('rejects the Node 20 that segfaulted, naming both the version and the cause', () => {
    const result = checkRuntime({ version: 'v20.14.0', napi: '9' });
    expect(result.supported).toBe(false);
    const reason = result.reason ?? '';
    // The whole point of the finding: the message has to be actionable prose,
    // not a bare boolean. It must say what was found, what is needed, and why.
    expect(reason).toContain('v20.14.0');
    expect(reason).toContain(String(MIN_NODE_MAJOR));
    expect(reason).toMatch(/segfault|crash/i);
    expect(reason).toMatch(/better-sqlite3|native/i);
    expect(reason).toContain('.nvmrc');
  });

  it('rejects a runtime whose N-API is too old even when the major looks fine', () => {
    const result = checkRuntime({ version: 'v22.0.0', napi: String(MIN_NAPI - 1) });
    expect(result.supported).toBe(false);
    expect(result.reason ?? '').toContain('N-API');
  });

  it('accepts a runtime newer than the floor', () => {
    expect(checkRuntime({ version: 'v24.1.0', napi: '10' }).supported).toBe(true);
    expect(checkRuntime({ version: 'v22.23.1', napi: '12' }).supported).toBe(true);
  });

  it('treats an unparseable version as unsupported rather than assuming the best', () => {
    expect(checkRuntime({ version: 'unknown', napi: '10' }).supported).toBe(false);
  });

  it('treats a build with no N-API at all as unsupported', () => {
    expect(checkRuntime({ version: 'v22.23.1' }).supported).toBe(false);
  });

  it('throws a typed, coded error so the CLI can exit on it deliberately', () => {
    let caught: unknown;
    try {
      assertRuntimeSupported({ version: 'v20.14.0', napi: '9' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedRuntimeError);
    const e = caught as UnsupportedRuntimeError;
    expect(e.code).toBe('unsupported-runtime');
    expect(e.details.version).toBe('v20.14.0');
    expect(e.details.minNodeMajor).toBe(MIN_NODE_MAJOR);
  });

  it('reads the version and napi off this process', () => {
    const info = currentRuntime();
    expect(info.version).toBe(process.version);
    expect(info.napi).toBe(process.versions.napi);
  });
});

describe('runtime pinning is declared in the repo, not just in prose', () => {
  it('.nvmrc pins the same major the guard enforces', () => {
    const nvmrc = readFileSync(path.join(REPO_ROOT, '.nvmrc'), 'utf8').trim();
    expect(nodeMajor(nvmrc)).toBe(MIN_NODE_MAJOR);
  });

  it('.npmrc makes the engines field enforced instead of advisory', () => {
    const npmrc = readFileSync(path.join(REPO_ROOT, '.npmrc'), 'utf8');
    expect(npmrc).toMatch(/^\s*engine-strict\s*=\s*true\s*$/m);
  });

  it('package.json engines agrees with the guard', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    expect(pkg.engines?.node).toBe(`>=${MIN_NODE_MAJOR}`);
  });
});

describe('test-tree child processes report a crash as a crash (D-47)', () => {
  it('carries the signal through instead of laundering it into exit 1', () => {
    const run = runProcess(process.execPath, ['-e', "process.kill(process.pid, 'SIGSEGV')"]);
    // The old `e.status ?? 1` made this indistinguishable from a clean failure.
    expect(run.signal).toBe('SIGSEGV');
    expect(run.status).toBeNull();
    expect(describeExit(run)).toBe('killed by SIGSEGV');
  });

  it('still reports an ordinary non-zero exit as an exit code', () => {
    const run = runProcess(process.execPath, ['-e', 'process.exit(3)']);
    expect(run.status).toBe(3);
    expect(run.signal).toBeNull();
    expect(describeExit(run)).toBe('exit 3');
  });

  it('reports a clean run as exit 0 with its stdout', () => {
    const run = runProcess(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(run).toEqual({ stdout: 'hi', stderr: '', status: 0, signal: null, spawnError: null });
  });

  it('captures stderr so a failure explains itself instead of just failing', () => {
    const run = runProcess(process.execPath, [
      '-e',
      'process.stderr.write("the actual reason"); process.exit(1)',
    ]);
    expect(run.stderr).toBe('the actual reason');
    expect(() =>
      runOrThrow(process.execPath, [
        '-e',
        'process.stderr.write("the actual reason"); process.exit(1)',
      ]),
    ).toThrow(/the actual reason/);
  });

  it('runOrThrow returns the run untouched when the command succeeds', () => {
    const run = runOrThrow(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(run.stdout).toBe('ok');
    expect(run.status).toBe(0);
  });

  it('runOrThrow says so explicitly when a failing command printed nothing', () => {
    expect(() => runOrThrow(process.execPath, ['-e', 'process.exit(4)'])).toThrow(/no output/);
  });

  it('assertExited turns a crash into a sentence naming the signal', () => {
    const crashed = runProcess(process.execPath, ['-e', "process.kill(process.pid, 'SIGSEGV')"]);
    expect(() => assertExited(crashed, 'smith plan validate')).toThrow(/SIGSEGV/);
    expect(() => assertExited(crashed, 'smith plan validate')).toThrow(/smith plan validate/);
  });

  it('assertExited stays out of the way for an ordinary failure', () => {
    const failed = runProcess(process.execPath, ['-e', 'process.exit(1)']);
    expect(() => assertExited(failed, 'anything')).not.toThrow();
  });
});
