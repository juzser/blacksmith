import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { runProcess } from './helpers/process.js';

// The plugin's opt-in policy guard: `.claude/hooks/plugin-policy.sh` is inert
// unless BS_PLUGIN_GUARD=1, and when on it hands the hook input, unchanged, to
// the policy hook the operator names (or the `bs-policy-hook` bin on PATH).
// Every run here uses a temp environment and either a stub hook or the built
// `policyHook.js`; never an installed hook and never `claude`.

const SHIM = path.join(REPO_ROOT, '.claude/hooks/plugin-policy.sh');
const BUILT_HOOK = path.join(REPO_ROOT, 'factory/orchestrator/dist/policyHook.js');
const NODE_DIR = path.dirname(process.execPath);
// The shim needs mktemp, cat, sleep and rm when the guard is on.
const SYS_BIN = '/usr/bin:/bin';

const bashInput = (command: string): string =>
  JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: REPO_ROOT });
const FORCE_PUSH = bashInput(['git', 'push', '--force', 'origin', 'main'].join(' '));
const STATUS = bashInput('git status');

function runShim(input: string, env: NodeJS.ProcessEnv) {
  return runProcess('/bin/sh', [SHIM], { input, env });
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'smith-plugin-guard-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('plugin-policy.sh', () => {
  it('is inert with the switch unset, or set to anything but 1, for every tool input', () => {
    const inputs = [FORCE_PUSH, STATUS, '', 'not json'];
    for (const switchEnv of [
      {},
      { BS_PLUGIN_GUARD: '' },
      { BS_PLUGIN_GUARD: '0' },
      { BS_PLUGIN_GUARD: 'true' },
    ]) {
      for (const input of inputs) {
        const run = runShim(input, { PATH: '', ...switchEnv });
        expect(run.status).toBe(0);
        expect(run.stdout).toBe('');
        expect(run.stderr).toBe('');
      }
    }
  });

  it('with the switch on and the built hook named, denies a force push to main and allows git status', () => {
    const env = {
      PATH: `${NODE_DIR}:${SYS_BIN}`,
      BS_PLUGIN_GUARD: '1',
      BS_POLICY_HOOK: BUILT_HOOK,
    };
    const denied = runShim(FORCE_PUSH, env);
    expect(denied.status).toBe(0);
    const decision = JSON.parse(denied.stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');

    const allowed = runShim(STATUS, env);
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe('');
  });

  it('passes the hook input to the resolved hook unchanged', () => {
    const stub = path.join(tmp, 'stub-hook.js');
    writeFileSync(
      stub,
      "const s = require('node:fs').readFileSync(0, 'utf8'); process.stdout.write(`${JSON.stringify({ echoed: s })}\\n`);\n",
    );
    const input = bashInput('echo "quoted $HOME $(whoami)"');
    const run = runShim(input, {
      PATH: `${NODE_DIR}:${SYS_BIN}`,
      BS_PLUGIN_GUARD: '1',
      BS_POLICY_HOOK: stub,
    });
    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as { echoed: string }).echoed).toBe(input);
  });

  it('falls back to bs-policy-hook on PATH when BS_POLICY_HOOK is unset', () => {
    const bin = path.join(tmp, 'bs-policy-hook');
    writeFileSync(bin, '#!/bin/sh\nprintf \'{"from":"path-bin"}\\n\'\n');
    chmodSync(bin, 0o755);
    const run = runShim(STATUS, { PATH: `${tmp}:${SYS_BIN}`, BS_PLUGIN_GUARD: '1' });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('{"from":"path-bin"}');
  });

  it('asks, naming bs-policy-hook and BS_POLICY_HOOK, when the switch is on and no hook is found', () => {
    for (const hookEnv of [{}, { BS_POLICY_HOOK: path.join(tmp, 'missing.js') }]) {
      const run = runShim(FORCE_PUSH, { PATH: '', BS_PLUGIN_GUARD: '1', ...hookEnv });
      expect(run.status).toBe(0);
      const out = JSON.parse(run.stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      };
      expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain('bs-policy-hook');
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain('BS_POLICY_HOOK');
    }
  });

  it('asks when the resolved hook exits without a decision', () => {
    const stub = path.join(tmp, 'broken-hook.js');
    writeFileSync(stub, 'process.exit(3);\n');
    const run = runShim(STATUS, {
      PATH: `${NODE_DIR}:${SYS_BIN}`,
      BS_PLUGIN_GUARD: '1',
      BS_POLICY_HOOK: stub,
    });
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('does not run the named hook at all while the switch is off', () => {
    const marker = path.join(tmp, 'ran');
    const stub = path.join(tmp, 'sentinel-hook.js');
    writeFileSync(stub, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
    const run = runShim(STATUS, { PATH: `${NODE_DIR}:${SYS_BIN}`, BS_POLICY_HOOK: stub });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(existsSync(marker)).toBe(false);
  });

  it('prefers BS_POLICY_HOOK over bs-policy-hook on PATH', () => {
    const bin = path.join(tmp, 'bs-policy-hook');
    writeFileSync(bin, '#!/bin/sh\nprintf \'{"from":"path-bin"}\\n\'\n');
    chmodSync(bin, 0o755);
    const stub = path.join(tmp, 'named-hook.js');
    writeFileSync(stub, 'process.stdout.write(\'{"from":"named"}\\n\');\n');
    const run = runShim(STATUS, {
      PATH: `${NODE_DIR}:${tmp}:${SYS_BIN}`,
      BS_PLUGIN_GUARD: '1',
      BS_POLICY_HOOK: stub,
    });
    expect(run.stdout.trim()).toBe('{"from":"named"}');
  });

  it('asks when the bs-policy-hook on PATH exits with an error', () => {
    const bin = path.join(tmp, 'bs-policy-hook');
    writeFileSync(bin, '#!/bin/sh\nexit 4\n');
    chmodSync(bin, 0o755);
    const run = runShim(STATUS, { PATH: `${tmp}:${SYS_BIN}`, BS_PLUGIN_GUARD: '1' });
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  });
});

describe('plugin-policy.sh answering in time', () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const slowStub = (): { stub: string; pidFile: string } => {
    const stub = path.join(tmp, 'slow-hook.js');
    const pidFile = path.join(tmp, 'slow.pid');
    writeFileSync(
      stub,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 30000);\n`,
    );
    return { stub, pidFile };
  };

  it('the shim always answers in time: a hook that never answers gets an ask and is stopped', () => {
    const { stub, pidFile } = slowStub();
    const started = Date.now();
    const run = runShim(STATUS, {
      PATH: `${NODE_DIR}:${SYS_BIN}`,
      BS_PLUGIN_GUARD: '1',
      BS_POLICY_HOOK: stub,
      BS_PLUGIN_GUARD_WATCHDOG: '1',
    });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/in time/i);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  });

  it('the shim always answers in time: the default limit sits inside the hook entry timeout', () => {
    const { stub } = slowStub();
    const started = Date.now();
    const run = runShim(STATUS, {
      PATH: `${NODE_DIR}:${SYS_BIN}`,
      BS_PLUGIN_GUARD: '1',
      BS_POLICY_HOOK: stub,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    const out = JSON.parse(run.stdout) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('the shim always answers in time: a malformed limit override falls back to the default', () => {
    const { stub } = slowStub();
    const started = Date.now();
    const run = runShim(STATUS, {
      PATH: `${NODE_DIR}:${SYS_BIN}`,
      BS_PLUGIN_GUARD: '1',
      BS_POLICY_HOOK: stub,
      BS_PLUGIN_GUARD_WATCHDOG: '20; echo x',
    });
    expect(Date.now() - started).toBeLessThan(5000);
    const out = JSON.parse(run.stdout) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('returns the hook answer promptly and does not wait out the limit when the hook is fast', () => {
    const stub = path.join(tmp, 'fast-hook.js');
    writeFileSync(stub, 'process.stdout.write(\'{"from":"fast"}\\n\');\n');
    const started = Date.now();
    const run = runShim(STATUS, {
      PATH: `${NODE_DIR}:${SYS_BIN}`,
      BS_PLUGIN_GUARD: '1',
      BS_POLICY_HOOK: stub,
      BS_PLUGIN_GUARD_WATCHDOG: '30',
    });
    expect(run.stdout.trim()).toBe('{"from":"fast"}');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('docs/guide/plugin-guard.md', () => {
  const readDoc = (): string =>
    readFileSync(path.join(REPO_ROOT, 'docs/guide/plugin-guard.md'), 'utf8');

  it('carries a deny block equal to the deny list in .claude/settings.json', () => {
    const doc = readDoc();
    const settings = JSON.parse(
      readFileSync(path.join(REPO_ROOT, '.claude/settings.json'), 'utf8'),
    ) as {
      permissions: { deny: string[] };
    };
    const block = /```json\n([\s\S]*?)\n```/.exec(doc)?.[1];
    expect(block, 'the doc has no json block').toBeDefined();
    const pasted = JSON.parse(block as string) as { permissions: { deny: string[] } };
    expect(pasted.permissions.deny).toEqual(settings.permissions.deny);
  });

  it('names the one switch and says a settings-file env entry is not a tested way to set it', () => {
    const doc = readDoc();
    expect(doc).toContain('BS_PLUGIN_GUARD=1');
    expect(doc).toMatch(/not tested/i);
  });
});
