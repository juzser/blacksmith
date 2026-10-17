import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { assertExited, runProcess } from './helpers/process.js';

// The capture hook is the only writer of the records a session's binding is
// read from. `bs event append` is the one open door to the log, so it refuses
// the two hook-only types and a user_prompt that claims the hook's fields.

const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');
const SESSION = 'hook-only-session';

describe('bs event append: hook-only records', () => {
  let stateDir: string;
  let root: string;

  function run(event: Record<string, unknown>) {
    const r = runProcess('node', [
      CLI_PATH,
      'event',
      'append',
      JSON.stringify(event),
      '--state-dir',
      stateDir,
    ]);
    assertExited(r, 'bs event append');
    return r;
  }

  function event(event_type: string, payload: Record<string, unknown>) {
    return {
      session_id: SESSION,
      actor: 'user',
      event_type,
      plan_version: 1,
      causal_parent: root,
      project: 'project-a',
      payload,
    };
  }

  const logFile = () => path.join(stateDir, `${SESSION}.jsonl`);
  const logBytes = () => readFileSync(logFile(), 'utf8');

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'bs-hook-only-'));
    const r = run({
      session_id: SESSION,
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    root = JSON.parse(r.stdout).event_id as string;
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  function expectRefused(event_: Record<string, unknown>, nameIn: string[]) {
    const before = logBytes();
    const r = run(event_);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const err = JSON.parse(r.stdout).error;
    expect(err.code).toBe('events.hook-only-event-type');
    for (const word of nameIn) expect(err.message).toContain(word);
    expect(logBytes()).toBe(before);
  }

  it('refuses a hand-written session-bound event and leaves the log as it was', () => {
    expectRefused(event('session-bound', { bound_to: 'project-a' }), ['session-bound']);
  });

  it('refuses a hand-written pipeline-bypass-approved event and leaves the log as it was', () => {
    expectRefused(event('pipeline-bypass-approved', { project: 'project-a', question: 'q' }), [
      'pipeline-bypass-approved',
    ]);
  });

  it('refuses a user_prompt whose payload claims source hook', () => {
    expectRefused(event('user_prompt', { prompt: 'hi', source: 'hook' }), [
      'user_prompt',
      'capture hook',
    ]);
  });

  it('refuses a user_prompt whose payload carries a bound_to key', () => {
    expectRefused(event('user_prompt', { prompt: 'hi', bound_to: 'project-a' }), [
      'user_prompt',
      'capture hook',
    ]);
  });

  it('guard: still appends a plain user_prompt with only a prompt (passes before and after)', () => {
    const before = logBytes();
    const r = run(event('user_prompt', { prompt: 'hello' }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(logFile())).toBe(true);
    expect(logBytes().length).toBeGreaterThan(before.length);
    expect(logBytes()).toContain('"hello"');
  });
});
