import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerInvocation } from '../src/harness.js';
import { assertExited, runProcess } from './helpers/process.js';

// smith-run (dist/run-cli.js), driven as the built binary — the way it
// actually runs — not via src/run-cli.ts's functions directly. Mirrors
// test/cli.test.ts's own "verify the built binary" convention.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const RUN_CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'run-cli.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'fake-harness-cli.mjs');
const CODER_TEMPLATE = '.claude/agents/coder.md';

function runSmithRun(
  args: string[],
  opts: { input?: string } = {},
): { stdout: string; stderr: string; status: number } {
  const run = runProcess('node', [RUN_CLI_PATH, ...args], opts);
  assertExited(run, `smith-run ${args.join(' ')}`);
  return { stdout: run.stdout, stderr: run.stderr, status: run.status as number };
}

describe('run-cli.ts (built binary: smith-run)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'smith-run-cli-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function writeInvocation(overrides: Partial<WorkerInvocation> = {}): Promise<string> {
    const promptFile = path.join(cwd, 'prompt.md');
    await writeFile(promptFile, 'do the task', 'utf8');

    const invocation: WorkerInvocation = {
      kind: 'cli',
      harness: 'fake-cli',
      role: 'coder',
      taskId: 'epic-1/task-1',
      access: 'worker',
      promptFile,
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

    const invocationFile = path.join(cwd, 'invocation.json');
    await writeFile(invocationFile, JSON.stringify(invocation), 'utf8');
    return invocationFile;
  }

  it('--help explains why this is not `smith harness run`, and exits 0', () => {
    const run = runSmithRun(['--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Usage: smith-run');
    expect(run.stdout).toContain('smith harness run');
    expect(run.stdout).toContain('§18 rule 3');
  });

  it('exits 1 with a usage message when no invocation argument is given', () => {
    const run = runSmithRun([]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('missing <invocation.json');
  });

  it('exits 0 and prints the JSON RunOutcome when the harness completes and no schema is set', async () => {
    const invocationFile = await writeInvocation({ args: [FIXTURE, 'text'], output: 'text' });
    const run = runSmithRun([invocationFile]);
    expect(run.status).toBe(0);
    const outcome = JSON.parse(run.stdout);
    expect(outcome.answer).toBe('Hello from the fake harness, no JSON here.');
    expect(outcome.validation).toBeNull();
  });

  it('exits 0 when the answer validates against the schema', async () => {
    const invocationFile = await writeInvocation({
      args: [FIXTURE, 'codex-json'],
      output: 'codex-json',
      schema: 'judge-verdict',
    });
    const run = runSmithRun([invocationFile]);
    expect(run.status).toBe(0);
    const outcome = JSON.parse(run.stdout);
    expect(outcome.validation).toEqual({ ok: true });
  });

  it('exits 2 when the harness completes but the answer fails schema validation', async () => {
    const invocationFile = await writeInvocation({
      args: [FIXTURE, 'text'],
      output: 'text',
      schema: 'judge-verdict',
    });
    const run = runSmithRun([invocationFile]);
    expect(run.status).toBe(2);
    const outcome = JSON.parse(run.stdout);
    expect(outcome.validation.ok).toBe(false);
  });

  it('exits 3 on a timeout, honouring a --timeout-ms override', async () => {
    const pidFile = path.join(cwd, 'grandchild.pid');
    const invocationFile = await writeInvocation({
      args: [FIXTURE, 'slow-grandchild', pidFile],
      budget: { timeout_ms: 30_000, max_output_bytes: 1_000_000, cap_tokens: null },
    });
    const run = runSmithRun([invocationFile, '--timeout-ms', '200']);
    expect(run.status).toBe(3);
    const outcome = JSON.parse(run.stdout);
    expect(outcome.timedOut).toBe(true);
  });

  it('exits 1 when the harness exits 0 but its own output reports a failure (harness_error, F5)', async () => {
    const invocationFile = await writeInvocation({
      args: [FIXTURE, 'codex-json-error'],
      output: 'codex-json',
    });
    const run = runSmithRun([invocationFile]);
    expect(run.status).toBe(1);
    const outcome = JSON.parse(run.stdout);
    expect(outcome.harness_error).toBe('boom');
  });

  it('exits 1 when the harness binary cannot be started', async () => {
    const invocationFile = await writeInvocation({
      command: path.join(cwd, 'no-such-binary-xyz'),
      args: [],
    });
    const run = runSmithRun([invocationFile]);
    expect(run.status).toBe(1);
    const outcome = JSON.parse(run.stdout);
    expect(outcome.spawnError).toContain('ENOENT');
  });

  it('exits 1 with a clear stderr message on invalid invocation JSON', async () => {
    const invocationFile = path.join(cwd, 'bad.json');
    await writeFile(invocationFile, 'not json', 'utf8');
    const run = runSmithRun([invocationFile]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('could not read/parse invocation');
  });

  it('reads the invocation from stdin when given "-"', async () => {
    const promptFile = path.join(cwd, 'prompt.md');
    await writeFile(promptFile, 'do the task', 'utf8');
    const invocation: WorkerInvocation = {
      kind: 'cli',
      harness: 'fake-cli',
      role: 'coder',
      taskId: 'epic-1/task-1',
      access: 'worker',
      promptFile,
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
    } as WorkerInvocation;

    const run = runSmithRun(['-'], { input: JSON.stringify(invocation) });
    expect(run.status).toBe(0);
    const outcome = JSON.parse(run.stdout);
    expect(outcome.answer).toBe('Hello from the fake harness, no JSON here.');
  });

  it('--prompt-file overrides the invocation-file prompt reaching the child', async () => {
    const invocationFile = await writeInvocation({ args: [FIXTURE, 'echo'], output: 'text' });
    const overridePromptFile = path.join(cwd, 'override-prompt.md');
    await writeFile(overridePromptFile, 'MARKER-override-prompt', 'utf8');

    const run = runSmithRun([invocationFile, '--prompt-file', overridePromptFile]);
    expect(run.status).toBe(0);
    const outcome = JSON.parse(run.stdout);
    const sent = JSON.parse(outcome.answer) as { stdin: string };
    expect(sent.stdin).toContain('MARKER-override-prompt');
    expect(sent.stdin).not.toContain('do the task');
  });

  it('--out writes the JSON result to a file instead of stdout', async () => {
    const invocationFile = await writeInvocation({ args: [FIXTURE, 'text'], output: 'text' });
    const outFile = path.join(cwd, 'result.json');

    const run = runSmithRun([invocationFile, '--out', outFile]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('');

    const written = JSON.parse(await readFile(outFile, 'utf8'));
    expect(written.answer).toBe('Hello from the fake harness, no JSON here.');
  });
});
