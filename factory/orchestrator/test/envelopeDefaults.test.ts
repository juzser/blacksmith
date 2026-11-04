import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendEvent, readEvents, setEnvelopeDefaults } from '../src/events.js';
import { CLI_PATH, runCli } from './helpers/cliHarness.js';

// O-11 (lean-mode-scope §6a item 1): `--session` and `--causal-parent` are
// optional on every verb that takes the shared envelope. `prompt record -` is
// the cheapest such verb, so it carries these tests end-to-end as a built binary.

const SESSION = '0a1b2c3d-1111-4222-8333-444455556666';
const execFileAsync = promisify(execFile);

function wavePlan() {
  return {
    epic_id: 'epic-1',
    version: 1,
    status: 'active',
    tasks: [
      {
        task_id: 'epic-1/task-1',
        epic_id: 'epic-1',
        plan_version: 1,
        objective: 'Do the thing.',
        output_schema_ref: 'result.schema.json',
        acceptance_criteria: ['it works'],
        claims: ['src/foo/*.ts'],
        budget: { tokens: 1000, diff_lines: 100 },
        contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
      },
    ],
    edges: [],
  };
}

describe('envelope defaults (built binary)', () => {
  let scratch: string;
  let n = 0;
  const fresh = () => path.join(scratch, `state-${n++}`);

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'smith-envdefaults-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const record = (stateDir: string, extra: string[], env: Record<string, string>, text = 'hi') =>
    runCli(['prompt', 'record', '-', '--state-dir', stateDir, ...extra], env, text);

  it('takes the session from CLAUDE_CODE_SESSION_ID when --session is absent', async () => {
    const stateDir = fresh();
    const run = record(stateDir, [], { CLAUDE_CODE_SESSION_ID: SESSION });
    expect(run.status).toBe(0);
    const events = await readEvents(SESSION, { stateDir });
    expect(events.map((e) => e.record.event_type)).toEqual(['session-start', 'user_prompt']);
  });

  it('refuses when there is neither a --session flag nor the env var', () => {
    const run = record(fresh(), [], { CLAUDE_CODE_SESSION_ID: '' });
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).error.code).toBe('cli.missing-flag');
  });

  it('defaults the parent to the last event of the log', () => {
    const stateDir = fresh();
    const env = { CLAUDE_CODE_SESSION_ID: SESSION };
    const first = JSON.parse(record(stateDir, [], env, 'one').stdout);
    const second = JSON.parse(record(stateDir, [], env, 'two').stdout);
    const third = JSON.parse(record(stateDir, [], env, 'three').stdout);
    expect(first.record.causal_parent).toBe(`${SESSION}#0`);
    expect(second.record.causal_parent).toBe(first.event_id);
    expect(third.record.causal_parent).toBe(second.event_id);
  });

  it('writes one root on an empty log and hangs the event off it', async () => {
    const stateDir = fresh();
    const run = record(stateDir, ['--session', 'fresh-sess'], { CLAUDE_CODE_SESSION_ID: '' });
    expect(run.status).toBe(0);
    const events = await readEvents('fresh-sess', { stateDir });
    expect(events.filter((e) => e.record.event_type === 'session-start')).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(events[0]?.record.causal_parent).toBeNull();
    expect(events[1]?.record.causal_parent).toBe(events[0]?.event_id);
  });

  it('records which envelope fields were defaulted', () => {
    const stateDir = fresh();
    const both = JSON.parse(record(stateDir, [], { CLAUDE_CODE_SESSION_ID: SESSION }).stdout);
    expect(both.record.envelope_defaulted).toEqual(['session', 'causal_parent']);
    const parentOnly = JSON.parse(
      record(stateDir, ['--session', SESSION], { CLAUDE_CODE_SESSION_ID: '' }).stdout,
    );
    expect(parentOnly.record.envelope_defaulted).toEqual(['causal_parent']);
    const sessionOnly = JSON.parse(
      record(stateDir, ['--causal-parent', `${SESSION}#0`], {
        CLAUDE_CODE_SESSION_ID: SESSION,
      }).stdout,
    );
    expect(sessionOnly.record.envelope_defaulted).toEqual(['session']);
  });

  it('leaves an event with both flags given exactly as before', () => {
    const stateDir = fresh();
    expect(runCli(['session', 'start', 'explicit', '--state-dir', stateDir]).status).toBe(0);
    const run = record(stateDir, ['--session', 'explicit', '--causal-parent', 'explicit#0'], {
      CLAUDE_CODE_SESSION_ID: SESSION,
    });
    expect(run.status).toBe(0);
    const stored = JSON.parse(run.stdout).record;
    expect(stored.causal_parent).toBe('explicit#0');
    expect(stored.session_id).toBe('explicit');
    expect('envelope_defaulted' in stored).toBe(false);
  });

  it('still refuses an explicit --causal-parent that names no event', () => {
    const stateDir = fresh();
    runCli(['session', 'start', 'explicit2', '--state-dir', stateDir]);
    const bad = record(stateDir, ['--session', 'explicit2', '--causal-parent', 'explicit2#9'], {});
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout).error.code).toBe('events.unknown-causal-parent');
  });

  it('tags the root it wrote for an empty log as auto-created', async () => {
    const stateDir = fresh();
    record(stateDir, ['--session', 'tagged-root'], { CLAUDE_CODE_SESSION_ID: '' });
    const [root] = await readEvents('tagged-root', { stateDir });
    expect(root?.record.envelope_defaulted).toEqual(['auto_root']);
    runCli(['session', 'start', 'plain-root', '--state-dir', stateDir]);
    const [plain] = await readEvents('plain-root', { stateDir });
    expect('envelope_defaulted' in (plain?.record ?? {})).toBe(false);
  });

  describe('fan-out refusal (cli.envelope-parent-ambiguous)', () => {
    const dispatch = (task: string, i: number) => ({
      session_id: 'fan',
      actor: 'orchestrator',
      event_type: 'dispatch_decision',
      task_id: task,
      plan_version: 1,
      causal_parent: 'fan#0',
      ts: `2026-11-04T00:00:0${i}.000Z`,
      payload: {
        agent_role: 'coder',
        provider: 'claude',
        model_tier: 'mid',
        model: 'claude-sonnet-5',
      },
    });
    const seed = async (live: number) => {
      const stateDir = fresh();
      await mkdir(stateDir, { recursive: true });
      const root = {
        session_id: 'fan',
        actor: 'operator',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        ts: '2026-11-04T00:00:00.000Z',
        payload: {},
      };
      const lines = [root, ...Array.from({ length: live }, (_, i) => dispatch(`e/t${i}`, i + 1))];
      await writeFile(
        path.join(stateDir, 'fan.jsonl'),
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      );
      return stateDir;
    };
    const lineCount = async (stateDir: string) =>
      (await readFile(path.join(stateDir, 'fan.jsonl'), 'utf8')).trim().split('\n').length;

    it.each([0, 1])('passes a defaulted parent with %i live dispatch(es)', async (live) => {
      const stateDir = await seed(live);
      const run = record(stateDir, ['--session', 'fan'], { CLAUDE_CODE_SESSION_ID: '' });
      expect(run.status).toBe(0);
      expect(await lineCount(stateDir)).toBe(live + 2);
    });

    it('refuses a defaulted parent with two live dispatches and writes nothing', async () => {
      const stateDir = await seed(2);
      const run = record(stateDir, ['--session', 'fan'], { CLAUDE_CODE_SESSION_ID: '' });
      expect(run.status).toBe(1);
      const error = JSON.parse(run.stdout).error;
      expect(error.code).toBe('cli.envelope-parent-ambiguous');
      expect(error.message).toContain('e/t0');
      expect(error.message).toContain('e/t1');
      expect(error.message).toContain('--causal-parent');
      expect(await lineCount(stateDir)).toBe(3);
    });

    it('refuses at ONE live dispatch when the session itself came from the env', async () => {
      const stateDir = await seed(1);
      const run = record(stateDir, [], { CLAUDE_CODE_SESSION_ID: 'fan' });
      expect(run.status).toBe(1);
      expect(JSON.parse(run.stdout).error.code).toBe('cli.envelope-parent-ambiguous');
      expect(await lineCount(stateDir)).toBe(2);
      // ...and with no live dispatch the env session is fine.
      const quiet = await seed(0);
      expect(record(quiet, [], { CLAUDE_CODE_SESSION_ID: 'fan' }).status).toBe(0);
    });

    it('names how to close an abandoned dispatch', async () => {
      const stateDir = await seed(2);
      const run = record(stateDir, ['--session', 'fan'], { CLAUDE_CODE_SESSION_ID: '' });
      const message = JSON.parse(run.stdout).error.message;
      expect(message).toContain('error-logged');
      expect(message).toContain('bs event append');
    });

    it('decides the refusal under the log lock, atomically with the read', async () => {
      const stateDir = await seed(1);
      const logFile = path.join(stateDir, 'fan.jsonl');
      const lock = `${logFile}.lock`;
      await writeFile(lock, 'held by the test');
      const textFile = path.join(scratch, 'refusal.txt');
      await writeFile(textFile, 'x');
      const child = execFileAsync(
        'node',
        [CLI_PATH, 'prompt', 'record', textFile, '--state-dir', stateDir, '--session', 'fan'],
        { env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', BS_NO_SETTINGS_HINT: '1' } },
      ).then(
        () => ({ code: 0, out: '' }),
        (e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout }),
      );
      // The child is now queued on the lock having seen ONE live dispatch at most;
      // a second goes live before the lock is released.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await appendFile(logFile, `${JSON.stringify(dispatch('e/t9', 3))}\n`);
      await rm(lock);
      const result = await child;
      expect(result.code).toBe(1);
      expect(JSON.parse(result.out).error.code).toBe('cli.envelope-parent-ambiguous');
      expect(await lineCount(stateDir)).toBe(3);
    });

    it('never refuses an explicit --causal-parent', async () => {
      const stateDir = await seed(2);
      const run = record(stateDir, ['--session', 'fan', '--causal-parent', 'fan#0'], {
        CLAUDE_CODE_SESSION_ID: '',
      });
      expect(run.status).toBe(0);
      expect(await lineCount(stateDir)).toBe(4);
    });
  });

  it('leaves no root-only log behind when the defaulted event itself is rejected', async () => {
    const stateDir = fresh();
    setEnvelopeDefaults({ parentFor: 'never' });
    try {
      await expect(
        appendEvent(
          {
            session_id: 'never',
            actor: 'system',
            event_type: 'dispatch_decision',
            plan_version: 1,
            causal_parent: null,
            payload: {},
          },
          { stateDir },
        ),
      ).rejects.toThrow(/dispatch_decision/);
    } finally {
      setEnvelopeDefaults({});
    }
    expect(existsSync(path.join(stateDir, 'never.jsonl'))).toBe(false);
  });

  it('reads the session from the env in read verbs and the wave admission checks too', async () => {
    const stateDir = fresh();
    runCli(['session', 'start', SESSION, '--state-dir', stateDir]);
    const list = runCli(['findings', 'list', '--state-dir', stateDir], {
      CLAUDE_CODE_SESSION_ID: SESSION,
    });
    expect(list.status).toBe(0);

    // `wave check` with an env session gets the refusals --session gets.
    const plan = path.join(scratch, 'wave-plan.json');
    await writeFile(plan, JSON.stringify(wavePlan()));
    const args = ['wave', 'check', plan, 'epic-1/task-1', '--state-dir', stateDir, '--dry'];
    const flagged = runCli([...args, '--session', SESSION], { CLAUDE_CODE_SESSION_ID: '' });
    const viaEnv = runCli(args, { CLAUDE_CODE_SESSION_ID: SESSION });
    const bare = runCli(args, { CLAUDE_CODE_SESSION_ID: '' });
    expect(flagged.status).toBe(1);
    expect(viaEnv.status).toBe(flagged.status);
    expect(JSON.parse(viaEnv.stdout).error.code).toBe(JSON.parse(flagged.stdout).error.code);
    expect(bare.status).toBe(0);
  });

  it('says in --help that the flags are optional, their defaults, and the fan-out rule', () => {
    for (const args of [['--help'], ['gate', 'run', '--help']]) {
      const text = runCli(args).stdout;
      expect(text).toContain('--session and --causal-parent are optional');
      expect(text).toContain('CLAUDE_CODE_SESSION_ID');
      expect(text).toContain("session's last event");
      expect(text).toMatch(/fan-out.*must pass --causal-parent explicitly/);
      expect(text).toContain('cli.envelope-parent-ambiguous');
    }
    expect(runCli(['gate', 'run', '--help']).stdout).toContain('[--causal-parent <event-id>]');
  });

  it.each([
    ['an empty log (the auto-root is raced too)', false],
    ['a log that already has its root', true],
  ])('keeps the log valid when defaulted writers race on %s', async (_name, seeded) => {
    const stateDir = fresh();
    if (seeded) runCli(['session', 'start', SESSION, '--state-dir', stateDir]);
    const textFile = path.join(scratch, 'prompt.txt');
    await writeFile(textFile, 'racing');
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION, BS_NO_SETTINGS_HINT: '1' };
    // The lock is held while every writer starts, so all six are queued on it
    // together rather than depending on process-start jitter.
    await mkdir(stateDir, { recursive: true });
    const lock = path.join(stateDir, `${SESSION}.jsonl.lock`);
    await writeFile(lock, 'held by the test');
    const writers = Array.from({ length: 6 }, () =>
      execFileAsync('node', [CLI_PATH, 'prompt', 'record', textFile, '--state-dir', stateDir], {
        env,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await rm(lock);
    await Promise.all(writers);
    const events = await readEvents(SESSION, { stateDir });
    expect(events).toHaveLength(7);
    expect(events.filter((e) => e.record.event_type === 'session-start')).toHaveLength(1);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
    events.forEach((e, i) => {
      if (i === 0) return;
      const parent = e.record.causal_parent as string;
      const parentIndex = events.findIndex((p) => p.event_id === parent);
      expect(parentIndex).toBeGreaterThanOrEqual(0);
      expect(parentIndex).toBeLessThan(i);
    });
    // Defaulted under the lock, the parent is the immediate predecessor.
    expect(events.slice(1).map((e) => e.record.causal_parent)).toEqual(
      events.slice(0, -1).map((e) => e.event_id),
    );
  });
});
