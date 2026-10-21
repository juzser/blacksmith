import { mkdirSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Count the policy module's git-backed lookups without changing what they do.
const gitCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/policy.js')>();
  return {
    ...actual,
    detectCurrentBranch: (cwd?: string) => {
      gitCalls.count += 1;
      return actual.detectCurrentBranch(cwd);
    },
    detectRepoRoot: (cwd?: string) => {
      gitCalls.count += 1;
      return actual.detectRepoRoot(cwd);
    },
  };
});

import { decideHookPayload } from '../src/hookDecision.js';
import { runOrThrow } from './helpers/process.js';

let scratch: string;
let leaseDir: string;
let repo: string;
const dirs: string[] = [];

function decide(command: string): ReturnType<typeof decideHookPayload> {
  return decideHookPayload(
    JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }),
    repo,
    leaseDir,
  );
}

function cdSteps(targets: string[]): string {
  return `${targets.map((d) => `cd ${d} ;`).join(' ')} echo done`;
}

beforeAll(async () => {
  scratch = realpathSync(await mkdtemp(path.join(tmpdir(), 'hook-fanout-')));
  leaseDir = path.join(scratch, 'leases');
  mkdirSync(leaseDir);
  repo = path.join(scratch, 'project-a');
  mkdirSync(repo);
  runOrThrow('git', ['init', '-q', '-b', 'feat/side', repo]);
  for (let i = 0; i < 100; i += 1) {
    const dir = path.join(scratch, `project-b-${i}`);
    mkdirSync(dir);
    dirs.push(dir);
  }
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('the directory lookup resolves each directory once', () => {
  it('resolves each distinct word and base pair once for hundreds of repeated steps', () => {
    const few = dirs.slice(0, 8);
    const steps: string[] = [];
    for (let i = 0; i < 400; i += 1) steps.push(few[i % few.length] as string);
    const native = vi.spyOn(realpathSync, 'native');
    gitCalls.count = 0;
    const started = Date.now();
    try {
      expect(decide(cdSteps(steps))).toBeNull();
      // 8 words against at most 9 bases (cwd plus the 8 found), once each.
      expect(native.mock.calls.length).toBeLessThanOrEqual(8 * 9);
    } finally {
      native.mockRestore();
    }
    expect(gitCalls.count).toBeLessThanOrEqual(2 * 9);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a line naming too many distinct directories before any git call', () => {
    gitCalls.count = 0;
    const decision = decide(cdSteps(dirs));
    expect(decision?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain('too many directories');
    expect(gitCalls.count).toBe(0);
  });

  it('judges a line at the cap and refuses one directory past it', () => {
    // The cwd counts as one distinct directory: 63 named plus cwd is 64.
    gitCalls.count = 0;
    expect(decide(cdSteps(dirs.slice(0, 63)))).toBeNull();
    expect(gitCalls.count).toBe(2 * 64);
    gitCalls.count = 0;
    const past = decide(cdSteps(dirs.slice(0, 64)));
    expect(past?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(gitCalls.count).toBe(0);
  });

  it('refuses a line past the cap even when its first steps are repeats', () => {
    const steps = [...dirs.slice(0, 5), ...dirs.slice(0, 5), ...dirs];
    gitCalls.count = 0;
    const decision = decide(cdSteps(steps));
    expect(decision?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(gitCalls.count).toBe(0);
  });

  it('still judges every directory on a line under the cap', () => {
    gitCalls.count = 0;
    expect(decide(cdSteps(dirs.slice(0, 20)))).toBeNull();
    expect(gitCalls.count).toBe(2 * 21);
  });
});
