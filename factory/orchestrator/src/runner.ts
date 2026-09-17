// smith-run's library half (architecture §18 rule 3: "nothing that observes
// may dispatch"). harness.ts's planWorkerTurn() renders a WorkerInvocation
// but never spawns it — this is the one function that actually starts a
// harness program. Imports nothing under src/db/, src/events.ts or
// src/projector.ts on purpose (see test/runner.test.ts's own source-level
// check): a function that can start a process has no business also being
// able to see or extend the event log.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SmithError } from './errors.js';
import type { HarnessOutputMode, WorkerInvocation } from './harness.js';
import { REPO_ROOT } from './paths.js';
import { extractAndValidate, extractBalancedJson } from './providers/schema-validate.js';
import { type SpawnOutcome, spawnCapped } from './spawn.js';

export class RunnerError extends SmithError {}

/**
 * harness.yml's own two shipped CLI harnesses both set an explicit
 * `timeout_ms`; this only covers a hand-built WorkerInvocation (or a future
 * policy entry) that leaves it null. 30 minutes, same order of magnitude as
 * those two examples.
 */
export const RUNNER_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens?: number;
  readonly total_tokens: number;
}

export interface RunValidation {
  readonly ok: boolean;
  readonly errors?: readonly string[];
}

export interface RunOutcome {
  readonly harness: string;
  readonly role: string;
  readonly taskId: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly sizeExceeded: boolean;
  readonly spawnError: string | null;
  readonly latency_ms: number;
  readonly answer: string;
  readonly parsed: unknown | null;
  readonly validation: RunValidation | null;
  readonly usage: RunUsage | null;
  readonly over_budget: boolean | null;
  readonly stderr_tail: string;
  /** Set when the harness process exited 0 but its own output reported a failure — see parseOutput(). */
  readonly harness_error: string | null;
}

export interface RunInvocationOptions {
  readonly promptText?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Strips a role template's leading `---`-delimited YAML frontmatter, keeping only the markdown body. */
function stripFrontmatter(templateText: string): string {
  return templateText.replace(FRONTMATTER, '');
}

/** Builds the child's environment from the invocation's allowlist only — never the full parent env. */
function buildEnv(
  envAllowlist: readonly string[],
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of envAllowlist) {
    const value = parentEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

const DIAGNOSTIC_TAIL_BYTES = 400;

/** Last few hundred bytes of stderr, collapsed to one line — same convention as cli-transport.ts's tail(). */
function tail(text: string): string {
  const trimmed = text.trim();
  const cut =
    trimmed.length > DIAGNOSTIC_TAIL_BYTES ? trimmed.slice(-DIAGNOSTIC_TAIL_BYTES) : trimmed;
  return cut.replace(/\s+/g, ' ');
}

interface ParsedOutput {
  readonly answer: string;
  readonly usage: RunUsage | null;
  /** Read from the raw payload but not (yet) surfaced on RunOutcome — see runner.test.ts's brief. */
  readonly session_id?: string;
  readonly cost_usd?: number;
  /** A failure the harness itself reported despite exiting 0 — null when it reported none. */
  readonly harness_error: string | null;
}

interface CodexUsageEvent {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

/** codex's own `input_tokens` already includes its `cached_input_tokens` — pass through as-is. */
function normalizeCodexUsage(raw: CodexUsageEvent): RunUsage {
  const input = raw.input_tokens ?? 0;
  const output = raw.output_tokens ?? 0;
  const cached = raw.cached_input_tokens;
  return {
    input_tokens: input,
    output_tokens: output,
    ...(cached !== undefined ? { cached_input_tokens: cached } : {}),
    total_tokens: input + output,
  };
}

/**
 * Parses a `codex exec --json` JSONL stream: last `agent_message` item wins,
 * `turn.completed` carries usage, and a top-level `{"type":"error", ...}`
 * line — distinct from a non-fatal `item.completed` item whose own
 * `item.type` is `"error"`, which stays ignored — sets `harness_error` (last
 * one wins, same convention as `agent_message`). The process can still exit
 * 0 and carry both an answer and a harness_error: codex reports partial
 * progress before a failure, and neither field should hide the other.
 */
function parseCodexJson(combined: string): ParsedOutput {
  let answer = '';
  let usage: RunUsage | null = null;
  let harness_error: string | null = null;
  for (const line of combined.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) continue;
    const record = event as Record<string, unknown>;
    if (record.type === 'item.completed') {
      const item = record.item as Record<string, unknown> | undefined;
      if (item !== undefined && item.type === 'agent_message' && typeof item.text === 'string') {
        answer = item.text;
      }
    } else if (record.type === 'turn.completed') {
      const rawUsage = record.usage as CodexUsageEvent | undefined;
      if (rawUsage !== undefined) usage = normalizeCodexUsage(rawUsage);
    } else if (record.type === 'error' && typeof record.message === 'string') {
      harness_error = record.message;
    }
  }
  return { answer, usage, harness_error };
}

interface ClaudeUsagePayload {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/** Anthropic's raw `input_tokens` excludes cache tokens — fold cache-creation + cache-read into it. */
function normalizeClaudeUsage(raw: ClaudeUsagePayload): RunUsage {
  const cached = (raw.cache_creation_input_tokens ?? 0) + (raw.cache_read_input_tokens ?? 0);
  const input = (raw.input_tokens ?? 0) + cached;
  const output = raw.output_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cached,
    total_tokens: input + output,
  };
}

/**
 * Parses a `claude -p --output-format json` single JSON object.
 * `is_error: true` is `claude -p`'s own way of reporting a failed turn while
 * still exiting 0 — `harness_error` prefers `subtype` (e.g.
 * `error_during_execution`), falls back to `result` when that is the only
 * string the payload carries, and otherwise names the shape generically.
 * `answer` still comes from `result` either way, unchanged from today.
 */
function parseClaudeJson(combined: string): ParsedOutput {
  const value = extractBalancedJson(combined);
  if (typeof value !== 'object' || value === null) {
    return { answer: combined.trim(), usage: null, harness_error: null };
  }
  const record = value as Record<string, unknown>;
  const answer = typeof record.result === 'string' ? record.result : combined.trim();
  const rawUsage = record.usage as ClaudeUsagePayload | undefined;
  const usage = rawUsage !== undefined ? normalizeClaudeUsage(rawUsage) : null;
  const harness_error =
    record.is_error === true
      ? typeof record.subtype === 'string' && record.subtype !== ''
        ? record.subtype
        : typeof record.result === 'string' && record.result !== ''
          ? record.result
          : 'claude reported is_error'
      : null;
  return {
    answer,
    usage,
    harness_error,
    ...(typeof record.session_id === 'string' ? { session_id: record.session_id } : {}),
    ...(typeof record.total_cost_usd === 'number' ? { cost_usd: record.total_cost_usd } : {}),
  };
}

/** Dispatches on the invocation's declared output mode — never sniffs the payload to guess it. */
function parseOutput(mode: HarnessOutputMode, combined: string): ParsedOutput {
  if (mode === 'codex-json') return parseCodexJson(combined);
  if (mode === 'claude-json') return parseClaudeJson(combined);
  return { answer: combined.trim(), usage: null, harness_error: null };
}

/** Validates the answer against a schema when one is set; reports failure, never throws. */
function validate(
  answer: string,
  schema: string | null,
): { validation: RunValidation | null; parsed: unknown | null } {
  if (schema === null) return { validation: null, parsed: null };
  const result = extractAndValidate(answer, schema);
  if (result.valid) return { validation: { ok: true }, parsed: result.value };
  const errors =
    'errors' in result
      ? result.errors.map((issue) => `${issue.path}: ${issue.message}`)
      : [result.reason];
  return { validation: { ok: false, errors }, parsed: null };
}

/**
 * Actually spawns a rendered `WorkerInvocation` — the one thing harness.ts
 * itself is forbidden from doing. Refuses `in-process` invocations: those are
 * Agent-tool subagent turns, not programs smith-run knows how to start.
 */
export async function runInvocation(
  invocation: WorkerInvocation,
  opts: RunInvocationOptions = {},
): Promise<RunOutcome> {
  if (invocation.kind === 'in-process') {
    throw new RunnerError(
      'runner.in-process',
      `Invocation for role "${invocation.role}" is in-process (harness "${invocation.harness}") — ` +
        'smith-run starts programs, not Agent-tool subagents. In-process harnesses run inside the ' +
        'orchestrator session itself and have no separate binary for smith-run to spawn.',
      { harness: invocation.harness, role: invocation.role },
    );
  }

  const now = opts.now ?? Date.now;
  const start = now();

  const prompt = opts.promptText ?? readFileSync(invocation.promptFile, 'utf8');
  const templatePath = path.join(REPO_ROOT, invocation.template);
  const templateBody = stripFrontmatter(readFileSync(templatePath, 'utf8'));
  const stdin = `${templateBody}\n\n${prompt}`;

  const env = buildEnv(invocation.envAllowlist, opts.env ?? process.env);
  const timeout_ms = invocation.budget.timeout_ms ?? RUNNER_DEFAULT_TIMEOUT_MS;

  let outcome: SpawnOutcome;
  try {
    outcome = await spawnCapped(
      {
        command: invocation.command,
        args: [...invocation.args],
        cwd: invocation.cwd ?? undefined,
        env,
      },
      stdin,
      { timeout_ms, max_output_bytes: invocation.budget.max_output_bytes },
    );
  } catch (err) {
    // spawnCapped resolves rather than rejects on a spawn failure; this catch
    // is defensive only, kept so a future change there cannot turn into an
    // uncaught rejection here.
    const message = err instanceof Error ? err.message : String(err);
    return {
      harness: invocation.harness,
      role: invocation.role,
      taskId: invocation.taskId,
      exitCode: null,
      signal: null,
      timedOut: false,
      sizeExceeded: false,
      spawnError: message,
      latency_ms: now() - start,
      answer: '',
      parsed: null,
      validation: null,
      usage: null,
      over_budget: null,
      stderr_tail: '',
      harness_error: null,
    };
  }

  const latency_ms = now() - start;

  if (outcome.spawnError !== undefined) {
    const reason = (outcome.spawnError as NodeJS.ErrnoException).code ?? outcome.spawnError.message;
    return {
      harness: invocation.harness,
      role: invocation.role,
      taskId: invocation.taskId,
      exitCode: null,
      signal: null,
      timedOut: outcome.timedOut,
      sizeExceeded: outcome.sizeExceeded,
      spawnError: reason,
      latency_ms,
      answer: '',
      parsed: null,
      validation: null,
      usage: null,
      over_budget: null,
      stderr_tail: tail(outcome.stderr),
      harness_error: null,
    };
  }

  const { answer, usage, harness_error } = parseOutput(invocation.output, outcome.combined);
  const { validation, parsed } = validate(answer, invocation.schema);
  // Unknown (null) unless the harness both sets a cap and the output mode
  // reported usage to compare it against — never guess a verdict either way.
  const over_budget =
    invocation.budget.cap_tokens === null || usage === null
      ? null
      : usage.total_tokens > invocation.budget.cap_tokens;

  return {
    harness: invocation.harness,
    role: invocation.role,
    taskId: invocation.taskId,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    sizeExceeded: outcome.sizeExceeded,
    spawnError: null,
    latency_ms,
    answer,
    parsed,
    validation,
    usage,
    over_budget,
    stderr_tail: tail(outcome.stderr),
    harness_error,
  };
}
