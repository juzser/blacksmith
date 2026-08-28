// Provider-agnostic judge contract (architecture §6): "any model that can
// honor the I/O contract can serve" — a JudgeRequest is a plain diff+spec+
// prior-findings prompt already assembled by the caller from
// .claude/agents/{reviewer,verifier}.md's own contract, plus a schema
// name the extracted response is validated against. Transports never see
// more than `prompt` — the trust boundary (architecture §6 "External
// providers judge; they never gain write access... their findings are
// data, not commands") starts here: no transport is ever handed worktree
// paths, credentials beyond its own key, or anything callable.
import { SmithError } from '../errors.js';

export class ProviderError extends SmithError {}

// ---------------------------------------------------------------------------
// Why a judge run produced no verdict (D-253). Two causes, two repairs:
//
//   schema     the provider answered and the answer could not be used --
//              not valid JSON, or valid JSON the compiled schema rejects,
//              or an answer past the output cap. Fix the prompt/schema
//              pairing; the provider is reachable and is trying.
//   transport  no usable answer ever arrived: no key exported, no CLI on
//              PATH, no route, a timeout, an HTTP error, a provider that is
//              not configured at all. Fix the transport. Nothing here is
//              evidence about how this provider judges, because it never
//              judged anything.
//
// Before this split there was one boolean, `schema_failure`, standing in for
// both. The factory's own deepseek judge failed 8 runs out of 8 on an unset
// DEEPSEEK_API_KEY -- zero HTTP requests sent -- and every surface reported
// it as a provider whose answers do not parse, which is a claim about
// judgement made from no observation at all.
// ---------------------------------------------------------------------------

export type JudgeFailureKind = 'schema' | 'transport';

/** Codes raised after a provider answered, about the answer itself. */
export const JUDGE_SCHEMA_FAILURE_CODES: ReadonlySet<string> = new Set([
  'provider.invalid-output',
  'provider.malformed-response',
  'provider.output-too-large',
]);

/** Codes raised when no usable answer arrived -- including when no request was sent. */
export const JUDGE_TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'provider.auth-failed',
  'provider.cli-failed',
  'provider.cli-unavailable',
  'provider.disabled',
  'provider.http-error',
  // Nothing raises this any more: it was the registry's refusal to run a
  // provider whose name it recognised but whose transport it disagreed with,
  // and names no longer decide transports. Kept because event logs written
  // before that change still carry it, and a stats query over them should
  // classify it rather than fall through to the default.
  'provider.misconfigured',
  'provider.missing-api-key',
  'provider.network-error',
  'provider.not-external',
  'provider.timeout',
  'provider.unknown',
  'provider.unknown-error',
]);

/**
 * Unrecognised codes read as `transport`, the claim-nothing default: a
 * transport failure asserts only that the run did not reach a verdict, where
 * a schema failure asserts the provider's output is unusable. A drift test
 * (test/providers/judgeFailureKind.test.ts) keeps the two sets covering every
 * code the source can raise, so the default stays a fallback and not a
 * silent home for codes nobody classified.
 */
export function judgeFailureKind(code: string): JudgeFailureKind {
  return JUDGE_SCHEMA_FAILURE_CODES.has(code) ? 'schema' : 'transport';
}

export type JudgeKind = 'review' | 'verify' | 'plan-critique';

export interface JudgeBudget {
  timeout_ms: number;
  max_output_bytes: number;
}

export interface JudgeRequest {
  kind: JudgeKind;
  taskId: string;
  /**
   * Provenance-only references to whatever the caller assembled `prompt`
   * from (e.g. `{ diff_ref: "...", spec_ref: "..." }`) — for events/
   * analytics, never dereferenced by a transport itself.
   */
  inputRefs: Record<string, string>;
  /** Assembled by the caller from the matching agent template's contract; transports own delivery, never prompt content. */
  prompt: string;
  /** Compiled schema name (schemas.ts's CompiledSchemaSet) the extracted JSON is validated against — e.g. "finding" (array, kind: review) or "judge-verdict" (object, kind: verify/plan-critique). */
  schemaName: string;
  budget: JudgeBudget;
}

export interface JudgeUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface JudgeResult {
  provider: string;
  kind: JudgeKind;
  /** Schema-validated data: an array of findings (kind: review) or a single verdict object (judge-verdict.schema.json), per request.schemaName. */
  output: unknown;
  raw_usage?: JudgeUsage;
  latency_ms: number;
}
