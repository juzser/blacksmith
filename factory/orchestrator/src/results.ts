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
  inputTokens: number;
  outputTokens: number;
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

  const inputTokens = requireTokenCount('input_tokens', envelope.inputTokens);
  const outputTokens = requireTokenCount('output_tokens', envelope.outputTokens);

  return {
    ...half,
    task_id: envelope.taskId,
    agent: envelope.agent,
    provider: envelope.provider,
    model_tier: envelope.modelTier,
    // Derived, not accepted: a third number that can contradict the other two
    // is a third thing to get wrong.
    token_usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
