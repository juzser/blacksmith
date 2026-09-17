import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planWorkerTurn, type WorkerInvocation } from '../src/harness.js';
import { REPO_ROOT } from '../src/paths.js';
import { RunnerError, runInvocation } from '../src/runner.js';

// ---------------------------------------------------------------------------
// smith-run's library half: given a rendered WorkerInvocation (harness.ts's
// planWorkerTurn output, or one built by hand here), actually run it — the
// one thing harness.ts itself is forbidden from doing (§18 rule 3).
//
// harness.ts renders; this spawns. The two are tested separately on purpose:
// a WorkerInvocation built by hand here is exactly the contract between them,
// so a test that only exercised planWorkerTurn()'s own output would leave
// that contract unwritten.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'fake-harness-cli.mjs');
const CODER_TEMPLATE = '.claude/agents/coder.md';

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A `cli`-kind WorkerInvocation, shaped exactly like planWorkerTurn()'s own output. */
function invocation(overrides: Partial<WorkerInvocation> = {}): WorkerInvocation {
  return {
    kind: 'cli',
    harness: 'fake-cli',
    role: 'coder',
    taskId: 'epic-1/task-1',
    access: 'worker',
    promptFile: '/dev/null/unused-when-promptText-is-given',
    worktree: null,
    sandboxRequired: false,
    command: 'node',
    args: [FIXTURE, 'text'],
    cwd: null,
    envAllowlist: ['PATH'],
    template: CODER_TEMPLATE,
    output: 'text',
    model: null,
    tier: null,
    schema: null,
    stdin: 'prompt',
    budget: { timeout_ms: 5000, max_output_bytes: 1_000_000, cap_tokens: null },
    ...overrides,
  } as WorkerInvocation;
}

describe('runner.ts', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'smith-runner-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('refuses an in-process invocation — smith-run starts programs, not Agent-tool subagents', async () => {
    const inProcess: WorkerInvocation = {
      kind: 'in-process',
      harness: 'claude-code',
      role: 'coder',
      taskId: 'epic-1/task-1',
      access: 'worker',
      promptFile: '/dev/null',
      worktree: null,
      sandboxRequired: false,
      subagentType: 'coder',
      template: CODER_TEMPLATE,
    };

    await expect(runInvocation(inProcess, { promptText: 'x' })).rejects.toMatchObject({
      code: 'runner.in-process',
    });
    await expect(runInvocation(inProcess, { promptText: 'x' })).rejects.toBeInstanceOf(RunnerError);
  });

  it('codex-json: extracts the LAST agent_message, ignoring a non-fatal leading error item, and normalises usage', async () => {
    const outcome = await runInvocation(
      invocation({ args: [FIXTURE, 'codex-json'], output: 'codex-json' }),
      { promptText: 'do the task' },
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.sizeExceeded).toBe(false);
    expect(outcome.spawnError).toBeNull();
    expect(JSON.parse(outcome.answer)).toEqual({ verdict: 'confirm', rationale: 'codex says so' });
    expect(outcome.usage).toEqual({
      input_tokens: 100,
      output_tokens: 10,
      cached_input_tokens: 40,
      total_tokens: 110,
    });
  });

  it('claude-json: reads `result`, and folds cache-creation + cache-read into input_tokens', async () => {
    const outcome = await runInvocation(
      invocation({ args: [FIXTURE, 'claude-json'], output: 'claude-json' }),
      { promptText: 'do the task' },
    );

    expect(JSON.parse(outcome.answer)).toEqual({ verdict: 'confirm', rationale: 'claude says so' });
    // raw: input_tokens 10, cache_creation 20, cache_read 30, output 5.
    // "cached counts inside input" (both vendors): cached = 20 + 30 = 50,
    // input = 10 + 50 = 60, total = 60 + 5 = 65.
    expect(outcome.usage).toEqual({
      input_tokens: 60,
      output_tokens: 5,
      cached_input_tokens: 50,
      total_tokens: 65,
    });
  });

  it('text: passes the raw output through untouched, usage null, no validation when no schema is set', async () => {
    const outcome = await runInvocation(invocation({ args: [FIXTURE, 'text'], output: 'text' }), {
      promptText: 'do the task',
    });

    expect(outcome.answer).toBe('Hello from the fake harness, no JSON here.');
    expect(outcome.usage).toBeNull();
    expect(outcome.validation).toBeNull();
    expect(outcome.parsed).toBeNull();
  });

  it('reports a schema mismatch as validation: {ok: false, errors}, not a throw', async () => {
    const outcome = await runInvocation(
      invocation({ args: [FIXTURE, 'text'], output: 'text', schema: 'judge-verdict' }),
      { promptText: 'do the task' },
    );

    expect(outcome.validation?.ok).toBe(false);
    expect(outcome.validation?.errors?.length).toBeGreaterThan(0);
    expect(outcome.parsed).toBeNull();
  });

  it('validates the answer against the schema when it is set, and carries the parsed value', async () => {
    const outcome = await runInvocation(
      invocation({ args: [FIXTURE, 'codex-json'], output: 'codex-json', schema: 'judge-verdict' }),
      { promptText: 'do the task' },
    );

    expect(outcome.validation).toEqual({ ok: true });
    expect(outcome.parsed).toEqual({ verdict: 'confirm', rationale: 'codex says so' });
  });

  it('is over budget when usage exceeds cap_tokens, under when it does not, null when the harness sets no cap', async () => {
    const over = await runInvocation(
      invocation({
        args: [FIXTURE, 'codex-json'],
        output: 'codex-json',
        budget: { timeout_ms: 5000, max_output_bytes: 1_000_000, cap_tokens: 50 },
      }),
      { promptText: 'do the task' },
    );
    expect(over.over_budget).toBe(true);

    const under = await runInvocation(
      invocation({
        args: [FIXTURE, 'codex-json'],
        output: 'codex-json',
        budget: { timeout_ms: 5000, max_output_bytes: 1_000_000, cap_tokens: 500 },
      }),
      { promptText: 'do the task' },
    );
    expect(under.over_budget).toBe(false);

    const uncapped = await runInvocation(
      invocation({ args: [FIXTURE, 'codex-json'], output: 'codex-json' }),
      { promptText: 'do the task' },
    );
    expect(uncapped.over_budget).toBeNull();
  });

  it('times out and kills the WHOLE process group, not just the immediate child', async () => {
    const pidFile = path.join(cwd, 'grandchild.pid');
    const outcome = await runInvocation(
      invocation({
        args: [FIXTURE, 'slow-grandchild', pidFile],
        budget: { timeout_ms: 200, max_output_bytes: 1_000_000, cap_tokens: null },
      }),
      { promptText: 'do the task' },
    );

    expect(outcome.timedOut).toBe(true);

    const grandchildPid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
    expect(Number.isNaN(grandchildPid)).toBe(false);
    const died = await waitUntil(() => !processAlive(grandchildPid), 2000);
    expect(died).toBe(true);
  });

  it('reports an unspawnable command via spawnError, not a throw', async () => {
    const outcome = await runInvocation(
      invocation({ command: path.join(cwd, 'no-such-binary-xyz'), args: [] }),
      { promptText: 'do the task' },
    );

    expect(outcome.spawnError).toContain('ENOENT');
    expect(outcome.exitCode).toBeNull();
  });

  it('prepends the template body (frontmatter stripped) to the prompt, in that order, on stdin', async () => {
    const marker = 'MARKER-7f3a-this-is-the-prompt';
    const outcome = await runInvocation(invocation({ args: [FIXTURE, 'echo'], output: 'text' }), {
      promptText: marker,
    });

    const sent = JSON.parse(outcome.answer) as { stdin: string };
    // Frontmatter gone: no leading `---` block, straight into the body.
    expect(sent.stdin.startsWith('---')).toBe(false);
    expect(sent.stdin).toContain('# Coder');
    expect(sent.stdin).toContain(marker);
    expect(sent.stdin.indexOf('# Coder')).toBeLessThan(sent.stdin.indexOf(marker));
  });

  it('passes only allowlisted env var NAMES through to the child, never the rest', async () => {
    const outcome = await runInvocation(
      invocation({
        args: [FIXTURE, 'echo'],
        output: 'text',
        envAllowlist: ['PATH', 'FOO_ALLOWED'],
      }),
      {
        promptText: 'x',
        env: {
          PATH: process.env.PATH,
          FOO_ALLOWED: 'visible',
          FOO_SECRET: 'must-not-leak',
          HOME: process.env.HOME,
        },
      },
    );

    const sent = JSON.parse(outcome.answer) as { env: Record<string, string | undefined> };
    expect(sent.env.FOO_ALLOWED).toBe('visible');
    expect(sent.env.FOO_SECRET).toBeUndefined();
    expect(sent.env.HOME).toBeUndefined();
  });

  it('reads the prompt from promptFile when opts.promptText is not given', async () => {
    const promptFile = path.join(cwd, 'prompt.md');
    await writeFile(promptFile, 'the prompt on disk', 'utf8');

    const outcome = await runInvocation(
      invocation({ args: [FIXTURE, 'echo'], output: 'text', promptFile }),
      {},
    );

    const sent = JSON.parse(outcome.answer) as { stdin: string };
    expect(sent.stdin).toContain('the prompt on disk');
  });

  it('computes latency_ms off opts.now when given, not the wall clock', async () => {
    const ticks = [1_000, 1_750];
    const outcome = await runInvocation(invocation({ args: [FIXTURE, 'text'] }), {
      promptText: 'x',
      now: () => ticks.shift() as number,
    });
    expect(outcome.latency_ms).toBe(750);
  });

  it('carries the harness, role and taskId straight through from the invocation', async () => {
    const outcome = await runInvocation(
      invocation({ harness: 'fake-cli', role: 'reviewer', taskId: 'epic-9/task-2' }),
      { promptText: 'x' },
    );
    expect(outcome.harness).toBe('fake-cli');
    expect(outcome.role).toBe('reviewer');
    expect(outcome.taskId).toBe('epic-9/task-2');
  });

  describe('harness_error: a harness that exits 0 but reports failure in its own output (F5)', () => {
    it('codex-json: a top-level {"type":"error"} line with no agent_message sets harness_error, answer stays empty', async () => {
      const outcome = await runInvocation(
        invocation({ args: [FIXTURE, 'codex-json-error'], output: 'codex-json' }),
        { promptText: 'do the task' },
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.harness_error).toBe('boom');
      expect(outcome.answer).toBe('');
    });

    it('codex-json: an agent_message AND a later top-level error populate both answer and harness_error', async () => {
      const outcome = await runInvocation(
        invocation({ args: [FIXTURE, 'codex-json-agent-then-error'], output: 'codex-json' }),
        { promptText: 'do the task' },
      );

      expect(outcome.answer).toBe('the answer');
      expect(outcome.harness_error).toBe('boom');
    });

    it('codex-json: the non-fatal item.completed error item (existing fixture) leaves harness_error null', async () => {
      const outcome = await runInvocation(
        invocation({ args: [FIXTURE, 'codex-json'], output: 'codex-json' }),
        { promptText: 'do the task' },
      );

      expect(outcome.harness_error).toBeNull();
    });

    it('claude-json: is_error true reads subtype as harness_error, answer still comes from result, usage still parsed', async () => {
      const outcome = await runInvocation(
        invocation({ args: [FIXTURE, 'claude-json-error'], output: 'claude-json' }),
        { promptText: 'do the task' },
      );

      expect(outcome.harness_error).toBe('error_during_execution');
      expect(outcome.answer).toBe('API error 529');
      expect(outcome.usage).toEqual({
        input_tokens: 10,
        output_tokens: 0,
        cached_input_tokens: 0,
        total_tokens: 10,
      });
    });

    it('claude-json: a normal success run leaves harness_error null', async () => {
      const outcome = await runInvocation(
        invocation({ args: [FIXTURE, 'claude-json'], output: 'claude-json' }),
        { promptText: 'do the task' },
      );

      expect(outcome.harness_error).toBeNull();
    });

    it('text: harness_error is always null', async () => {
      const outcome = await runInvocation(invocation({ args: [FIXTURE, 'text'], output: 'text' }), {
        promptText: 'do the task',
      });

      expect(outcome.harness_error).toBeNull();
    });
  });
});

describe('runner.ts — real harness smoke test (gated, opt-in only)', () => {
  // Never set SMITH_REAL_HARNESS_SMOKE from inside this repo's test tooling —
  // it spawns the real `codex` binary and needs live auth/network. An
  // operator opts in by hand: `SMITH_REAL_HARNESS_SMOKE=1 pnpm run test`.
  const gate = process.env.SMITH_REAL_HARNESS_SMOKE === '1';

  it.skipIf(!gate)(
    'spawns the real codex-cli harness end to end',
    async () => {
      const worktree = await mkdtemp(path.join(tmpdir(), 'smith-real-smoke-'));
      try {
        const promptFile = path.join(worktree, 'prompt.md');
        await writeFile(promptFile, 'Reply with exactly the word: pong', 'utf8');

        const invocation = planWorkerTurn({
          harness: 'codex-cli',
          role: 'coder',
          taskId: 'smoke/real-harness',
          promptFile,
          worktree,
        });

        const outcome = await runInvocation(invocation, {});
        expect(outcome.spawnError).toBeNull();
        expect(outcome.exitCode).toBe(0);
      } finally {
        await rm(worktree, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe('runner.ts — architecture §18 rule 3, one more time at the source level', () => {
  it('imports nothing under src/db/, src/events.ts or src/projector.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const forbidden = /from ['"](\.\.\/)*(db\/|events\.js|projector\.js)/;
    for (const rel of ['runner.ts', 'spawn.ts']) {
      const file = path.join(REPO_ROOT, 'factory', 'orchestrator', 'src', rel);
      const text = readFileSync(file, 'utf8');
      const match = text.match(forbidden);
      expect(match, `${rel} imports ${match?.[0]}`).toBeNull();
    }
  });
});
