import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
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
import { appendWithin, ROOT_EVENT_TYPE } from '../src/events.js';
import {
  BINDING_TAIL_BYTES,
  bindingInput,
  loadBindingPolicy,
  REMINDER_PREFIX,
  reminderLines,
} from '../src/sessionBinding.js';
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

  it('answer mode records an AskUserQuestion answer end to end', () => {
    const dir = managedCheckout();
    const cli = '11111111-2222-4333-8444-555555555555';
    const r = run(
      ['answer'],
      JSON.stringify({
        session_id: cli,
        cwd: dir,
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_01',
        tool_response: {
          questions: [{ question: 'Go?', header: 'Go', options: [], multiSelect: false }],
          answers: { 'Go?': 'Yes' },
        },
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(
      `bs prompt capture: {"event_id":"prompts-${cli}#1","session_id":"prompts-${cli}"}`,
    );
  });
});

describe('dist/promptHook.js, the binding reminder', () => {
  const cli = '11111111-2222-4333-8444-555555555555';
  const home = `prompts-${cli}`;
  const standing = reminderLines('project-a', loadBindingPolicy());
  const SEED_ID = 'p-seed';
  const CAPTURE_PREFIX = 'bs prompt capture: ';

  const eventsOf = (dir: string): string => path.join(dir, '.blacksmith', 'state', 'events');

  async function bind(dir: string): Promise<void> {
    await appendWithin(
      home,
      () => [
        {
          session_id: home,
          actor: 'system',
          event_type: ROOT_EVENT_TYPE,
          plan_version: 1,
          causal_parent: null,
          payload: { kind: 'prompt-log' },
        },
        bindingInput({
          target: home,
          project: 'project-a',
          causalParent: `${home}#0`,
          planVersion: 1,
        }),
      ],
      { stateDir: eventsOf(dir), cliSessionId: cli },
    );
    // A recorded, stamped prompt: a later payload with the same prompt id is a
    // duplicate, so the capture writes nothing and the reminder stands alone.
    await appendWithin(
      home,
      () => [
        {
          session_id: home,
          actor: 'user',
          event_type: 'user_prompt',
          plan_version: 1,
          causal_parent: `${home}#1`,
          payload: { prompt: 'seed', source: 'hook', bound_to: `${home}#1`, prompt_id: SEED_ID },
          project: 'project-a',
        },
      ],
      { stateDir: eventsOf(dir), cliSessionId: cli },
    );
  }

  const prompt = (dir: string, text: string, over: Record<string, unknown> = {}): string =>
    JSON.stringify({ session_id: cli, prompt: text, cwd: dir, ...over });

  const linesOf = (stdout: string): string[] => stdout.split('\n').filter((l) => l !== '');

  /** Exit 0, only the two plain-text prefixes, and no line is a JSON hook response. */
  function expectPlain(r: { status: number | null; stdout: string }): string[] {
    expect(r.status).toBe(0);
    const lines = linesOf(r.stdout);
    for (const line of lines) {
      expect(line.startsWith(CAPTURE_PREFIX) || line.startsWith(REMINDER_PREFIX)).toBe(true);
      expect(() => JSON.parse(line)).toThrow();
    }
    return lines;
  }

  it('prints the reminder alone on a duplicate prompt', async () => {
    const dir = managedCheckout();
    await bind(dir);
    const input = prompt(dir, 'Fix it.', { prompt_id: SEED_ID });
    expect(expectPlain(run([], input))).toEqual(standing);
  });

  it('prints the reminder alone on a harness-text prompt', async () => {
    const dir = managedCheckout();
    await bind(dir);
    const input = prompt(dir, '<system-reminder>noise</system-reminder>', { prompt_id: SEED_ID });
    expect(expectPlain(run([], input))).toEqual(standing);
  });

  it('prints no reminder in answer mode', async () => {
    const dir = managedCheckout();
    await bind(dir);
    const r = run(
      ['answer'],
      JSON.stringify({
        session_id: cli,
        cwd: dir,
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_01',
        tool_response: {
          questions: [{ question: 'Go?', header: 'Go', options: [], multiSelect: false }],
          answers: { 'Go?': 'Yes' },
        },
      }),
    );
    const lines = expectPlain(r);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(CAPTURE_PREFIX)).toBe(true);
  });

  it('lists the known names for an unknown project name, then the standing reminder', async () => {
    const dir = managedCheckout();
    await bind(dir);
    const lines = expectPlain(
      run([], prompt(dir, '/bs use nothing-here zebra-marker', { prompt_id: SEED_ID })),
    );
    const reminder = lines.filter((l) => l.startsWith(REMINDER_PREFIX));
    expect(reminder[0]).toMatch(/not a project/);
    expect(reminder[1]).toMatch(/^bs use: known projects: .+\.$/);
    expect(reminder.slice(2)).toEqual(standing);
    expect(lines.join('\n')).not.toMatch(/nothing-here|zebra-marker/);
  });

  it('guard: an unbound session exits 0 with plain capture output only', () => {
    const dir = managedCheckout();
    const lines = expectPlain(run([], prompt(dir, 'Fix it.')));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(CAPTURE_PREFIX)).toBe(true);
  });

  it('guard: an internal failure (a home log line that is not JSON) exits 0 and prints nothing', () => {
    const dir = managedCheckout();
    writeFileSync(path.join(eventsOf(dir), `${home}.jsonl`), 'this is not json\n');
    const r = run([], prompt(dir, 'Fix it.'));
    expect(expectPlain(r)).toEqual([]);
  });

  it('reads a binding past a bad line and over 4 MiB of prompts, whatever the capture does', async () => {
    const dir = managedCheckout();
    const file = path.join(eventsOf(dir), `${home}.jsonl`);
    const rec = (event_type: string, payload: Record<string, unknown>): string =>
      `${JSON.stringify({
        session_id: home,
        actor: 'user',
        event_type,
        plan_version: 1,
        causal_parent: null,
        cli_session_id: cli,
        project: 'project-a',
        payload,
        ts: '2026-01-01T00:00:00.000Z',
      })}\n`;
    appendFileSync(file, rec('session-start', {}));
    appendFileSync(file, rec('session-bound', { project: 'project-a', source: 'hook' }));
    appendFileSync(file, 'this line is not json\n');
    const line = rec('user_prompt', {
      prompt: 'x'.repeat(2000),
      source: 'hook',
      bound_to: 'project-a',
    });
    appendFileSync(file, line.repeat(Math.ceil((4 * BINDING_TAIL_BYTES + 4096) / line.length)));
    const lines = expectPlain(run([], prompt(dir, 'Fix it.')));
    expect(lines.filter((l) => l.startsWith(REMINDER_PREFIX))).toEqual(standing);
  });
});
