// Generic CLI judge transport (architecture §6; design decision: Codex runs
// headless via `codex exec`, ChatGPT-subscription auth — docs/runbooks/
// providers.md). Prompt delivery: STDIN, not a temp file — no filesystem
// cleanup/race to manage, and a CLI judge that reads a prompt off stdin
// (same as an interactive paste) needs no extra flag wiring per provider.
import { type SpawnOutcome, spawnCapped } from '../spawn.js';
import { extractAndValidate } from './schema-validate.js';
import type { JudgeRequest, JudgeResult } from './types.js';
import { ProviderError } from './types.js';

export interface CliTransportConfig {
  command: string;
  args: string[];
}

const NUDGE = '\n\nReturn only valid JSON per schema.';

const DIAGNOSTIC_TAIL_BYTES = 400;

/** Last few hundred bytes of a stream, collapsed to one line, for an error message. */
function tail(text: string): string {
  const trimmed = text.trim();
  const cut =
    trimmed.length > DIAGNOSTIC_TAIL_BYTES ? trimmed.slice(-DIAGNOSTIC_TAIL_BYTES) : trimmed;
  return cut.replace(/\s+/g, ' ');
}

/**
 * What to quote back to the operator when a judge process failed.
 *
 * Do NOT prefer one stream over the other. Observed against the real binary:
 * `codex exec --json` wrote progress to stderr ("Reading prompt from stdin...")
 * and the actual refusal to stdout as a `{"type":"error"}` event, so a
 * stderr-first rule quotes the chatter and drops the reason. That is why the
 * `refuse` and `refuse-codex` fixtures are exact mirrors of each other.
 *
 * crosscheck.yml no longer passes `--json` (D-118), and plain `exec` splits the
 * streams differently again — the whole prompt is echoed to stderr, the answer
 * goes to stdout. Which only reinforces the rule: no CLI owes us a convention
 * about where it says things, so the combined buffer is the only safe input.
 *
 * The combined tail is the answer in the common case. stderr is prepended only
 * when the tail window no longer shows it, which happens when a chatty judge
 * floods stdout after writing a short reason to stderr.
 */
function diagnosticFor(outcome: SpawnOutcome): string {
  const combined = tail(outcome.combined);
  const errOnly = tail(outcome.stderr);
  if (errOnly === '' || combined.includes(errOnly)) return combined;
  return combined === '' ? errOnly : `${errOnly} | ${combined}`;
}

/**
 * One CLI judge invocation via the shared capped spawn (src/spawn.ts). No
 * `cwd` in the call: a CLI judge transport is handed a prompt and nothing
 * else — architecture §18 rule 5, "judges never gain write access" — and a
 * process started with no working directory of its own has no worktree to
 * write into even if its command line wanted one.
 */
function spawnOnce(
  config: CliTransportConfig,
  prompt: string,
  budget: { timeout_ms: number; max_output_bytes: number },
): Promise<SpawnOutcome> {
  return spawnCapped({ command: config.command, args: config.args }, prompt, budget);
}

interface AttemptOutcome {
  validation: ReturnType<typeof extractAndValidate>;
  spawned: SpawnOutcome;
}

/**
 * The buffer minus the prompt this process just sent, for the extractor to
 * scan.
 *
 * D-195: plain `codex exec` echoes the prompt it read off stdin back onto
 * stderr (see diagnosticFor above), and stderr is folded into `combined`. Every
 * prompt this factory builds interpolates free text an earlier agent wrote — a
 * finding's summary, its claimed failure scenario, a reviewer contract that
 * spells out `[]` for a clean diff — so an answer-shaped string sitting in that
 * text lands in the buffer AHEAD of the judge's own answer and wins
 * extractAndValidate's first-valid-candidate rule. A reviewer who writes
 * `{"verdict": "refute"}` into a summary refutes the finding against itself.
 *
 * The bytes removed are bytes this process sent, which is a fact about the
 * exchange rather than a guess about the judge. Preferring the LAST candidate
 * would be such a guess and breaks on a chatty judge or a protocol trailer;
 * discarding any candidate whose text also occurs in the prompt would throw
 * away a judge's legitimate `[]` clean review, turning a clean review into a
 * hard failure.
 */
function withoutEcho(combined: string, prompt: string): string {
  if (prompt === '') return combined;
  // Newline, not empty: candidates either side of an excised span must not be
  // glued into one unparseable run.
  return combined.split(prompt).join('\n');
}

/** One attempt: spawn, then extract+validate; throws on timeout/size-cap, returns the validation outcome otherwise. */
async function attempt(
  provider: string,
  config: CliTransportConfig,
  prompt: string,
  request: JudgeRequest,
  attemptLabel: string,
): Promise<AttemptOutcome> {
  const outcome = await spawnOnce(config, prompt, request.budget);
  if (outcome.timedOut) {
    throw new ProviderError(
      'provider.timeout',
      `Provider "${provider}" CLI judge timed out after ${request.budget.timeout_ms}ms${attemptLabel}.`,
      { provider },
    );
  }
  if (outcome.sizeExceeded) {
    throw new ProviderError(
      'provider.output-too-large',
      `Provider "${provider}" CLI judge output exceeded the ${request.budget.max_output_bytes}-byte cap${attemptLabel}.`,
      { provider },
    );
  }
  const answered = withoutEcho(outcome.combined, prompt);
  return { validation: extractAndValidate(answered, request.schemaName), spawned: outcome };
}

/**
 * D-116: the process either refused to run or ran and failed. Either way the
 * defect is not in the prompt, so the caller must not nudge-and-retry — that
 * spends a second call on an already-exhausted quota and then reports a schema
 * critique of whatever protocol chatter the CLI printed before dying. Returns
 * undefined when the process itself was healthy.
 */
function processFailure(
  provider: string,
  config: CliTransportConfig,
  outcome: SpawnOutcome,
): ProviderError | undefined {
  if (outcome.spawnError !== undefined) {
    const reason = (outcome.spawnError as NodeJS.ErrnoException).code ?? outcome.spawnError.message;
    return new ProviderError(
      'provider.cli-unavailable',
      `Provider "${provider}" CLI judge could not be started: ${config.command} (${reason}). ` +
        'Check that the binary is installed and on PATH — see docs/runbooks/providers.md.',
      { provider, command: config.command, reason },
    );
  }
  if (outcome.exitCode !== null && outcome.exitCode !== 0) {
    const diagnostic = diagnosticFor(outcome);
    return new ProviderError(
      'provider.cli-failed',
      `Provider "${provider}" CLI judge failed with exit ${outcome.exitCode} and no usable verdict` +
        `${diagnostic ? `: ${diagnostic}` : '.'}`,
      { provider, exitCode: outcome.exitCode, diagnostic },
    );
  }
  if (outcome.signal !== null) {
    return new ProviderError(
      'provider.cli-failed',
      `Provider "${provider}" CLI judge was killed by ${outcome.signal} without a usable verdict.`,
      { provider, signal: outcome.signal },
    );
  }
  return undefined;
}

export async function runCliJudge(
  provider: string,
  config: CliTransportConfig,
  request: JudgeRequest,
): Promise<JudgeResult> {
  const start = Date.now();

  const first = await attempt(provider, config, request.prompt, request, '');
  let result = first.validation;
  if (!result.valid) {
    // A judge that answered is a judge that answered, whatever its exit code —
    // so this check comes *after* validation, never before it. But if the
    // output is unusable AND the process itself failed, the prompt is not the
    // suspect and a retry is waste: report what actually happened.
    const processError = processFailure(provider, config, first.spawned);
    if (processError !== undefined) throw processError;

    // ONE retry with a nudge appended — a fresh spawn (the failed attempt's process is already dead).
    const second = await attempt(
      provider,
      config,
      `${request.prompt}${NUDGE}`,
      request,
      ' on retry',
    );
    result = second.validation;
    if (!result.valid) {
      const retryProcessError = processFailure(provider, config, second.spawned);
      if (retryProcessError !== undefined) throw retryProcessError;
      throw new ProviderError(
        'provider.invalid-output',
        `Provider "${provider}" CLI judge returned invalid output after one retry: ${result.reason}.`,
        { provider, reason: result.reason, errors: 'errors' in result ? result.errors : undefined },
      );
    }
  }

  return {
    provider,
    kind: request.kind,
    output: result.value,
    latency_ms: Date.now() - start,
  };
}
