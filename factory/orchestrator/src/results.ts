import { SmithError } from './errors.js';

export class ResultError extends SmithError {}

/**
 * Fields the dispatcher owns on a worker's result document. An agent that sets
 * any of them has overstepped the contract, and the value it wrote cannot be
 * trusted even when it looks right (interview N-1, answer (b)).
 *
 * `token_usage` is here for the reason the other four are: an agent has no way
 * to read its own meter. Whatever it writes is invented — wave 2 invented
 * zeros, wave 3 invented round numbers — and both shapes satisfy
 * `result.schema.json`, because a schema validates shape and never provenance.
 * The harness knows the real counts; the dispatcher stamps them.
 */
export const ORCHESTRATOR_OWNED_RESULT_FIELDS = [
  'task_id',
  'agent',
  'provider',
  'model_tier',
  'token_usage',
] as const;

export interface ResultEnvelope {
  taskId: string;
  /** taxonomy `agent` — the role the dispatcher sent the work to. */
  agent: string;
  /** taxonomy `provider`. */
  provider: string;
  /** taxonomy `model_tier`. */
  modelTier: string;
  /**
   * Both given, or both omitted (#220). A harness that ran the subprocess
   * itself always has both; a dispatcher with no API onto a subagent's token
   * spend — one running inside Claude Code, say — has neither, and omitting
   * both is how it says "not measured" instead of inventing a number.
   */
  inputTokens?: number;
  outputTokens?: number;
}

function requireTokenCount(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ResultError(
      'results.invalid-token-count',
      `${name} must be a non-negative integer, got ${String(value)}.`,
      { field: name, value },
    );
  }
  return value;
}

/**
 * Merge a worker's half of a result document with the envelope the dispatcher
 * owns, and refuse the merge if the worker wrote any of the dispatcher's
 * fields.
 *
 * The refusal is a throw rather than a gate event: a result whose provenance is
 * unknown should never reach the gate at all, and this mirrors
 * `mintFindings`' `findings.evidence-carries-identity` on the judge side. As
 * there, no `agent-result.schema.json` is added — the ownership check lives in
 * code where it can name the offending field, and `result.schema.json`
 * validates the merged document.
 */
export function stampResultEnvelope(
  agentResult: unknown,
  envelope: ResultEnvelope,
): Record<string, unknown> {
  if (agentResult === null || typeof agentResult !== 'object' || Array.isArray(agentResult)) {
    throw new ResultError(
      'results.not-an-object',
      `A result file must be a JSON object, got ${Array.isArray(agentResult) ? 'an array' : String(agentResult === null ? 'null' : typeof agentResult)}.`,
      { received: Array.isArray(agentResult) ? 'array' : typeof agentResult },
    );
  }

  const half = agentResult as Record<string, unknown>;
  const overstep = ORCHESTRATOR_OWNED_RESULT_FIELDS.filter((field) => half[field] !== undefined);
  if (overstep.length > 0) {
    throw new ResultError(
      'results.agent-wrote-owned-field',
      `Result set dispatcher-owned field(s) ${overstep.join(', ')}. Agents return run_status, structured_output and artifacts only.`,
      { fields: [...overstep] },
    );
  }

  const tokenUsage = deriveTokenUsage(envelope);

  return {
    ...half,
    task_id: envelope.taskId,
    agent: envelope.agent,
    provider: envelope.provider,
    model_tier: envelope.modelTier,
    // Derived, not accepted: a third number that can contradict the other two
    // is a third thing to get wrong.
    token_usage: tokenUsage,
  };
}

/**
 * `{input_tokens, output_tokens, total_tokens}` when the dispatcher has real
 * numbers, or `{measured: false}` when it has neither (#220) — never one
 * without the other, since half a measurement is not an honest "not measured"
 * and not a count either.
 */
function deriveTokenUsage(
  envelope: Pick<ResultEnvelope, 'inputTokens' | 'outputTokens'>,
): Record<string, unknown> {
  const { inputTokens, outputTokens } = envelope;
  if (inputTokens === undefined && outputTokens === undefined) {
    return { measured: false };
  }
  if (inputTokens === undefined || outputTokens === undefined) {
    const missing = inputTokens === undefined ? 'input_tokens' : 'output_tokens';
    throw new ResultError(
      'results.partial-token-count',
      `input_tokens and output_tokens must both be given or both omitted (an honest "not measured" is neither alone); ${missing} is missing.`,
      { field: missing },
    );
  }

  const input = requireTokenCount('input_tokens', inputTokens);
  const output = requireTokenCount('output_tokens', outputTokens);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
  };
}
