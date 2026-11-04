import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldAgents, liveAgents } from '../src/agents-registry.js';
import { appendWithin, readEvents } from '../src/events.js';
import { recordSubagent, spendByRole } from '../src/subagentUsage.js';
import { runCli } from './helpers/cliHarness.js';

// Lean-mode scope §4 / §7: SubagentStart and SubagentStop hooks write the
// dispatch and its usage, so the session no longer hand-writes dispatch_decision.
const CLI = '0a1b2c3d-1111-4222-8333-444455556666';

let base: string;
let dir: string;
let eventsDir: string;
const ctx = () => ({
  cwd: dir,
  env: {},
  repoRoot: path.join(base, 'no-clone'),
  isClone: false,
  roadmapPath: path.join(base, 'no-roadmap.md'),
});

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-subagent-')));
  dir = path.join(base, 'app');
  eventsDir = path.join(dir, '.blacksmith', 'state', 'events');
  mkdirSync(eventsDir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const assistant = (id: string, model: string, usage: Record<string, number>) =>
  JSON.stringify({ type: 'assistant', requestId: `r-${id}`, message: { id, model, usage } });

function transcript(name: string, lines: string[]): string {
  const file = path.join(base, name);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const startJson = (id: string, type = 'bs-coder', extra: object = {}) =>
  JSON.stringify({
    session_id: CLI,
    cwd: dir,
    hook_event_name: 'SubagentStart',
    agent_id: id,
    agent_type: type,
    ...extra,
  });
const stopJson = (id: string, file: string | undefined, type = 'bs-coder') =>
  JSON.stringify({
    session_id: CLI,
    cwd: dir,
    hook_event_name: 'SubagentStop',
    agent_id: id,
    agent_type: type,
    ...(file === undefined ? {} : { agent_transcript_path: file }),
  });

const rootEvent = {
  session_id: CLI,
  actor: 'operator',
  event_type: 'session-start',
  plan_version: 1,
  causal_parent: null,
  payload: {},
};

/** The session's own log, as `bs` verbs with the env session default to. */
async function openCliLog(): Promise<void> {
  await appendWithin(CLI, () => [rootEvent], { stateDir: eventsDir });
}

const files = () => readdirSync(eventsDir).sort();
const read = (session = CLI) => readEvents(session, { stateDir: eventsDir });

describe('recordSubagent', () => {
  it('writes a start and a stop with explicit parents; the fold sees live, then terminal', async () => {
    await openCliLog();
    await recordSubagent(startJson('a1'), 'start', ctx());
    let events = await read();
    expect(events.map((e) => e.record.event_type)).toEqual(['session-start', 'subagent-started']);
    expect(events[1]?.record.causal_parent).toBe(events[0]?.event_id);
    expect(events[1]?.record.agent_id).toBe('a1');
    expect(liveAgents(foldAgents(events)).map((a) => a.agentRole)).toEqual(['coder']);

    const file = transcript('a1.jsonl', [
      assistant('m1', 'claude-sonnet-5-5', {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 1000,
      }),
      assistant('m1', 'claude-sonnet-5-5', { input_tokens: 100, output_tokens: 50 }),
      assistant('m2', 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 5 }),
    ]);
    const out = await recordSubagent(stopJson('a1', file), 'stop', ctx());
    expect(out).toBeNull();
    events = await read();
    const stop = events[2];
    expect(stop?.record.event_type).toBe('subagent-stopped');
    expect(stop?.record.causal_parent).toBe(events[1]?.event_id);
    expect(stop?.record.payload).toMatchObject({
      agent_role: 'coder',
      agent_type: 'bs-coder',
      model: 'claude-sonnet-5-5',
      input_tokens: 105,
      output_tokens: 55,
      cache_creation_tokens: 10,
      cache_read_tokens: 1000,
      total_tokens: 170,
      complete: true,
    });
    expect(liveAgents(foldAgents(events))).toEqual([]);
    expect(foldAgents(events)[0]?.status).toBe('done');
  });

  it('hangs a start off the latest captured operator prompt of the log', async () => {
    await openCliLog();
    await appendWithin(
      CLI,
      (e) => [
        {
          session_id: CLI,
          actor: 'user',
          event_type: 'user_prompt',
          plan_version: 1,
          causal_parent: e[0]?.event_id ?? null,
          payload: { prompt: 'do it', source: 'hook' },
        },
      ],
      { stateDir: eventsDir, cliSessionId: CLI },
    );
    await recordSubagent(startJson('a1'), 'start', ctx());
    const events = await read();
    expect(events[2]?.record.causal_parent).toBe(events[1]?.event_id);
  });

  it('lands in prompts-<cli> when the session has no log of its own', async () => {
    await recordSubagent(startJson('a1', 'Explore'), 'start', ctx());
    expect(files()).toEqual([`prompts-${CLI}.jsonl`]);
    const events = await read(`prompts-${CLI}`);
    expect(events.map((e) => e.record.event_type)).toEqual(['session-start', 'subagent-started']);
    // A non-bs agent is recorded with its own type as the role.
    expect(events[1]?.record.payload).toMatchObject({
      agent_role: 'Explore',
      agent_type: 'Explore',
    });
    const file = transcript('e.jsonl', [
      assistant('m1', 'claude-haiku-4-5', { input_tokens: 1, output_tokens: 1 }),
    ]);
    await recordSubagent(stopJson('a1', file, 'Explore'), 'stop', ctx());
    const after = await read(`prompts-${CLI}`);
    expect(after[2]?.record.event_type).toBe('subagent-stopped');
    expect(after[2]?.record.causal_parent).toBe(after[1]?.event_id);
  });

  it('a stop with no readable transcript still closes the dispatch, incomplete', async () => {
    await openCliLog();
    await recordSubagent(startJson('a1'), 'start', ctx());
    await recordSubagent(stopJson('a1', path.join(base, 'missing.jsonl')), 'stop', ctx());
    const events = await read();
    expect(events[2]?.record.payload).toMatchObject({ complete: false, total_tokens: 0 });
    expect(liveAgents(foldAgents(events))).toEqual([]);
  });

  it('writes the stop once even if the hook fires twice', async () => {
    await openCliLog();
    await recordSubagent(startJson('a1'), 'start', ctx());
    const file = transcript('a1.jsonl', [assistant('m1', 'x', { input_tokens: 1 })]);
    await recordSubagent(stopJson('a1', file), 'stop', ctx());
    await recordSubagent(stopJson('a1', file), 'stop', ctx());
    const events = await read();
    expect(events.filter((e) => e.record.event_type === 'subagent-stopped')).toHaveLength(1);
  });

  it('warns with a systemMessage when the role crosses its task cap', async () => {
    await openCliLog();
    await recordSubagent(startJson('a1', 'bs-scribe'), 'start', ctx());
    const file = transcript('big.jsonl', [
      assistant('m1', 'claude-haiku-4-5', { input_tokens: 9_000_000, output_tokens: 1 }),
    ]);
    const out = await recordSubagent(stopJson('a1', file, 'bs-scribe'), 'stop', ctx());
    const msg = JSON.parse(out as string).systemMessage as string;
    expect(msg).toContain('scribe');
    expect(msg).toContain('9,000,001');
    expect(msg).toMatch(/cap/);
  });

  it('is quiet and writes nothing on empty, malformed or unmanaged input', async () => {
    const lone = path.join(base, 'lone');
    mkdirSync(lone);
    for (const raw of [
      '',
      'not json',
      '[]',
      JSON.stringify({ session_id: 'nope', agent_id: 'a', agent_type: 'x', cwd: dir }),
      JSON.stringify({ session_id: CLI, agent_type: 'x', cwd: dir }),
      startJson('a1', 'bs-coder', { cwd: lone }),
    ]) {
      expect(await recordSubagent(raw, 'start', ctx())).toBeNull();
    }
    // A stop with no matching start has nowhere to go.
    expect(await recordSubagent(stopJson('ghost', undefined), 'stop', ctx())).toBeNull();
    expect(files()).toEqual([]);
  });

  it('keeps concurrent starts of one session', async () => {
    await openCliLog();
    await Promise.all(
      ['a1', 'a2', 'a3', 'a4'].map((id) => recordSubagent(startJson(id), 'start', ctx())),
    );
    const events = await read();
    expect(events.filter((e) => e.record.event_type === 'subagent-started')).toHaveLength(4);
    expect(liveAgents(foldAgents(events))).toHaveLength(4);
  });
});

describe('the #533 refusal and a dead agent', () => {
  const env = () => ({ CLAUDE_CODE_SESSION_ID: CLI });
  const note = () =>
    runCli(['prompt', 'record', '-', '--state-dir', eventsDir], env(), 'a line of text');

  it('refuses a defaulted parent while an agent is live, and clears after its stop', async () => {
    await openCliLog();
    await recordSubagent(startJson('a1'), 'start', ctx());
    const refused = note();
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('cli.envelope-parent-ambiguous');
    expect(refused.stdout + refused.stderr).toContain('subagent-stopped');
    await recordSubagent(stopJson('a1', undefined), 'stop', ctx());
    expect(note().status).toBe(0);
  });

  it('a dead agent closes with the hand-written stop the refusal message describes', async () => {
    await openCliLog();
    await recordSubagent(startJson('a1'), 'start', ctx());
    const start = (await read())[1];
    const closed = runCli(
      [
        'event',
        'append',
        JSON.stringify({
          session_id: CLI,
          actor: 'operator',
          event_type: 'subagent-stopped',
          agent_id: 'a1',
          plan_version: 1,
          causal_parent: start?.event_id,
          payload: { agent_role: 'coder', total_tokens: 0, complete: false },
        }),
        '--state-dir',
        eventsDir,
      ],
      env(),
    );
    expect(closed.status, closed.stdout + closed.stderr).toBe(0);
    expect(liveAgents(foldAgents(await read()))).toEqual([]);
  });
});

describe('spend by role', () => {
  it('sums every stopped agent by role, non-bs agents included', async () => {
    await openCliLog();
    const run = async (id: string, type: string, input: number, model: string) => {
      await recordSubagent(startJson(id, type), 'start', ctx());
      const f = transcript(`${id}.jsonl`, [assistant(`m${id}`, model, { input_tokens: input })]);
      await recordSubagent(stopJson(id, f, type), 'stop', ctx());
    };
    await run('a1', 'bs-coder', 100, 'claude-sonnet-5-5');
    await run('a2', 'blacksmith:bs-coder', 50, 'claude-sonnet-5-5');
    await run('a3', 'Explore', 7, 'claude-haiku-4-5');
    const spend = spendByRole(await read());
    expect(spend.roles).toEqual([
      {
        role: 'coder',
        agents: 2,
        total_tokens: 150,
        models: ['claude-sonnet-5-5'],
        cap_tokens: expect.any(Number),
      },
      {
        role: 'Explore',
        agents: 1,
        total_tokens: 7,
        models: ['claude-haiku-4-5'],
        cap_tokens: null,
      },
    ]);
    expect(spend.total_tokens).toBe(157);
    const cli = runCli(['subagent', 'spend', '--session', CLI, '--state-dir', eventsDir]);
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout).total_tokens).toBe(157);
  });
});
