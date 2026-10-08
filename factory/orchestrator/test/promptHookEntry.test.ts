import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bareSpecifiersFrom } from './helpers/moduleGraph.js';
import { runProcess } from './helpers/process.js';

// The capture hook runs on every operator prompt, so like `policyHook.js` it
// must stay off the database layer. Everything it does is in promptCapture.ts
// (promptCapture.test.ts); this file pins the process contract of the built
// entry: silent, exit 0, and no write on `--resolve`.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'promptHook.js');

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'prompt-hook-')));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A git checkout with its own store, so M2 answers without any env. */
function managedCheckout(): string {
  const dir = path.join(base, 'beta-app');
  mkdirSync(path.join(dir, '.blacksmith', 'state', 'events'), { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

const run = (args: string[], input = '', env: NodeJS.ProcessEnv = {}) =>
  runProcess('node', [HOOK_PATH, ...args], {
    input,
    cwd: base,
    env: { PATH: process.env.PATH, ...env },
  });

describe('dist/promptHook.js, the prompt-capture entry point', () => {
  it('is built', () => {
    expect(existsSync(HOOK_PATH)).toBe(true);
  });

  it('does not reach the database layer', () => {
    const bare = bareSpecifiersFrom(HOOK_PATH);
    expect([...bare].filter((s) => s.includes('drizzle'))).toEqual([]);
    expect([...bare].filter((s) => s.includes('sqlite'))).toEqual([]);
  });

  it('is silent with exit 0 on bad JSON and on empty stdin', () => {
    for (const input of ['this is not json', '']) {
      const r = run([], input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
  });

  it('--resolve prints the M2 store of a checkout and writes nothing', () => {
    const dir = managedCheckout();
    const before = readdirSync(dir, { recursive: true });
    const r = run(['--resolve', dir]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      events_dir: path.join(dir, '.blacksmith', 'state', 'events'),
      rule: 'M2',
    });
    expect(readdirSync(dir, { recursive: true })).toEqual(before);
  });

  it('--resolve prints the M1 store BS_HOME names', () => {
    const home = path.join(base, 'home');
    mkdirSync(path.join(home, 'state', 'events'), { recursive: true });
    const r = run(['--resolve', base], '', { BS_HOME: home });
    expect(JSON.parse(r.stdout)).toEqual({
      events_dir: path.join(home, 'state', 'events'),
      rule: 'M1',
    });
  });

  it('--resolve prints nothing outside any checkout, and for a missing argument', () => {
    for (const args of [['--resolve', base], ['--resolve']]) {
      const r = run(args);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(readdirSync(base)).toEqual([]);
  });

  it('records a prompt end to end and prints the one line', () => {
    const dir = managedCheckout();
    const cli = '11111111-2222-4333-8444-555555555555';
    const r = run([], JSON.stringify({ session_id: cli, prompt: 'Fix it.', cwd: dir }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(
      `bs prompt capture: {"event_id":"prompts-${cli}#1","session_id":"prompts-${cli}"}`,
    );
    expect(
      existsSync(path.join(dir, '.blacksmith', 'state', 'events', `prompts-${cli}.jsonl`)),
    ).toBe(true);
  });
});
