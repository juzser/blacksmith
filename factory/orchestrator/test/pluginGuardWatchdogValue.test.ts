import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { runProcess } from './helpers/process.js';

// The plugin guard shim always answers in time: a limit override the timer
// cannot read falls back to the default, and a timer that fails to run counts
// as fired. Every run uses a temp directory and a stub hook.

const SHIM = path.join(REPO_ROOT, '.claude/hooks/plugin-policy.sh');
const NODE_DIR = path.dirname(process.execPath);
const SYS_BIN = '/usr/bin:/bin';
const INPUT = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } });

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'smith-plugin-guard-value-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A hook that records its pid and idles for 8 seconds.
function idleStub(): { stub: string; pidFile: string } {
  const stub = path.join(tmp, 'idle-hook.js');
  const pidFile = path.join(tmp, 'idle.pid');
  writeFileSync(
    stub,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 8000);\n`,
  );
  return { stub, pidFile };
}

function expectAskInTime(env: NodeJS.ProcessEnv, pathValue: string): void {
  const { stub, pidFile } = idleStub();
  const started = Date.now();
  const run = runProcess('/bin/sh', [SHIM], {
    input: INPUT,
    env: { PATH: pathValue, BS_PLUGIN_GUARD: '1', BS_POLICY_HOOK: stub, ...env },
  });
  const elapsed = Date.now() - started;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    expect(run.status).toBe(0);
    expect(elapsed).toBeLessThan(6000);
    const out = JSON.parse(run.stdout) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(alive(pid)).toBe(false);
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
}

describe('plugin-policy.sh limit override value', () => {
  for (const value of ['.', '1.2.3', '-1', '1.', '.5', '', '20; echo x']) {
    it(`the shim always answers in time: the override ${JSON.stringify(value)} uses the default`, () => {
      expectAskInTime({ BS_PLUGIN_GUARD_WATCHDOG: value }, `${NODE_DIR}:${SYS_BIN}`);
    });
  }

  it('the shim always answers in time: a timer that fails to run counts as fired', () => {
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    const fakeSleep = path.join(bin, 'sleep');
    writeFileSync(fakeSleep, '#!/bin/sh\nexit 1\n');
    chmodSync(fakeSleep, 0o755);
    expectAskInTime({}, `${bin}:${NODE_DIR}:${SYS_BIN}`);
  });
});
