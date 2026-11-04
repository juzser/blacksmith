import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { bareSpecifiersFrom } from './helpers/moduleGraph.js';
import { runProcess } from './helpers/process.js';

// The process contract of the built entry and of its transport shim: quiet,
// exit 0, off the database layer. What it writes is subagentUsage.test.ts.
const HOOK_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'subagentHook.js');
const SHIM = path.join(REPO_ROOT, '.claude', 'hooks', 'subagent-hook.sh');
const CLI = '0a1b2c3d-1111-4222-8333-444455556666';

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'subagent-hook-')));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('dist/subagentHook.js', () => {
  it('is built and stays off the database layer', () => {
    expect(existsSync(HOOK_PATH)).toBe(true);
    const bare = [...bareSpecifiersFrom(HOOK_PATH)];
    expect(bare.filter((s) => s.includes('drizzle') || s.includes('sqlite'))).toEqual([]);
  });

  it('is silent with exit 0 on bad JSON, empty stdin and an unknown mode', () => {
    for (const [mode, input] of [
      ['start', 'not json'],
      ['stop', ''],
      ['bogus', '{}'],
    ] as const) {
      const r = runProcess('node', [HOOK_PATH, mode], {
        input,
        cwd: base,
        env: { PATH: process.env.PATH },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
  });

  it('records a start end to end through the shim', () => {
    const dir = path.join(base, 'app');
    const events = path.join(dir, '.blacksmith', 'state', 'events');
    mkdirSync(events, { recursive: true });
    execFileSync('git', ['init', '-q', dir]);
    const r = runProcess('/bin/bash', [SHIM, 'start'], {
      input: JSON.stringify({ session_id: CLI, cwd: dir, agent_id: 'a1', agent_type: 'bs-coder' }),
      cwd: base,
      env: { PATH: process.env.PATH, BS_SUBAGENT_HOOK: HOOK_PATH },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(readdirSync(events)).toEqual([`${CLI}.jsonl`]);
  });
});

describe('subagent-hook.sh', () => {
  it('is inert with an empty PATH, no entry named, or an unknown mode', () => {
    writeFileSync(path.join(base, 'marker'), '');
    for (const args of [['start'], ['stop'], ['nope'], []]) {
      const r = runProcess('/bin/bash', [SHIM, ...args], {
        input: JSON.stringify({ session_id: CLI, agent_id: 'a', agent_type: 'x' }),
        cwd: base,
        env: { PATH: '' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    }
    expect(readdirSync(base)).toEqual(['marker']);
  });
});
