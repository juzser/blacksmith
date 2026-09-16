// Generic OpenAI-compatible chat-completions judge transport (DeepSeek,
// architecture §6). No streaming — one request, one full response body.
// Key handling per docs/standards/guardrails.md "Provider keys... reference
// env var names only": `apiKeyEnv` is a NAME, the actual value is read from
// process.env at call time and never appears in any thrown error message.
import { extractAndValidate } from './schema-validate.js';
import type { JudgeRequest, JudgeResult, JudgeUsage } from './types.js';
import { ProviderError } from './types.js';

export interface ApiTransportConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  responseFormatJsonObject: boolean;
  /**
   * The provider's `max_tokens` for one answer, from the policy entry. A
   * request budget's `max_output_tokens` wins over it; when neither is set no
   * `max_tokens` is sent and the model runs to its own ceiling — which for a
   * reasoning model is the whole completion window (deepseek-reasoner spent
   * 64K tokens on one plan critique that way).
   */
  maxTokens?: number;
}

const NUDGE = '\n\nReturn only valid JSON per schema.';
const RESPONSE_BODY_ERROR_SNIPPET_LIMIT = 500;
// Raw answer kept on a rejected verdict: enough head to see what the model
// started writing, enough tail to see where it stopped. A truncated JSON
// answer and a prose answer look alike in a bare `no-json-found`.
const CONTENT_SNIPPET_HEAD = 300;
const CONTENT_SNIPPET_TAIL = 200;
const CONTENT_SNIPPET_JOINER = ' … ';

function resolveApiKey(config: ApiTransportConfig, provider: string): string {
  const key = process.env[config.apiKeyEnv];
  if (!key) {
    throw new ProviderError(
      'provider.missing-api-key',
      `Environment variable "${config.apiKeyEnv}" is not set (required for provider "${provider}").`,
      { provider, envVar: config.apiKeyEnv },
    );
  }
  return key;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface CallResult {
  content: string;
  usage?: JudgeUsage;
  /** `stop`, `length`, ... as the provider reported it; absent when it did not. */
  finishReason?: string;
}

/**
 * The raw answer as it may appear in an error: the API key scrubbed the same
 * way a non-OK body is, and bounded to head + tail so a 64K truncation shows
 * its last bytes instead of nothing.
 */
function contentSnippet(content: string, apiKey: string): string {
  const scrubbed = content.split(apiKey).join('[REDACTED]');
  if (scrubbed.length <= CONTENT_SNIPPET_HEAD + CONTENT_SNIPPET_TAIL) return scrubbed;
  return `${scrubbed.slice(0, CONTENT_SNIPPET_HEAD)}${CONTENT_SNIPPET_JOINER}${scrubbed.slice(-CONTENT_SNIPPET_TAIL)}`;
}

/**
 * Whether a second call with the nudge appended can change anything. It can
 * when the model finished on its own (`stop`) — the prompt is the suspect. It
 * cannot when the model was cut off at `max_tokens`: the same prompt runs to
 * the same cap and bills the same tokens. An absent finish_reason is read as
 * `stop` so a provider that omits the field keeps the retry it always had.
 */
function nudgeCanHelp(finishReason: string | undefined): boolean {
  return finishReason === undefined || finishReason === 'stop';
}

async function callOnce(
  provider: string,
  config: ApiTransportConfig,
  apiKey: string,
  prompt: string,
  budget: { timeout_ms: number; max_output_bytes: number; max_output_tokens?: number },
  fetchImpl: typeof fetch,
): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget.timeout_ms);
  const maxTokens = budget.max_output_tokens ?? config.maxTokens;

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        ...(config.responseFormatJsonObject ? { response_format: { type: 'json_object' } } : {}),
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ProviderError(
        'provider.timeout',
        `Provider "${provider}" API judge timed out after ${budget.timeout_ms}ms.`,
        { provider },
      );
    }
    throw new ProviderError(
      'provider.network-error',
      `Provider "${provider}" API judge request failed: ${err instanceof Error ? err.message : String(err)}`,
      { provider },
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    // Never read/echo the response body here — auth failures on some
    // gateways reflect request headers back in error bodies, and the body
    // is exactly the kind of "output" the key-never-logged rule guards.
    throw new ProviderError(
      'provider.auth-failed',
      `Provider "${provider}" API judge authentication failed (HTTP ${response.status}). Check the "${config.apiKeyEnv}" value — never logged here.`,
      { provider, status: response.status, envVar: config.apiKeyEnv },
    );
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    const scrubbed = bodyText
      .split(apiKey)
      .join('[REDACTED]')
      .slice(0, RESPONSE_BODY_ERROR_SNIPPET_LIMIT);
    throw new ProviderError(
      'provider.http-error',
      `Provider "${provider}" API judge returned HTTP ${response.status}.`,
      { provider, status: response.status, body: scrubbed },
    );
  }

  const bodyText = await response.text();
  if (bodyText.length > budget.max_output_bytes) {
    throw new ProviderError(
      'provider.output-too-large',
      `Provider "${provider}" API judge response exceeded the ${budget.max_output_bytes}-byte cap.`,
      { provider },
    );
  }

  let parsed: ChatCompletionResponse;
  try {
    parsed = JSON.parse(bodyText) as ChatCompletionResponse;
  } catch {
    throw new ProviderError(
      'provider.malformed-response',
      `Provider "${provider}" API judge response was not valid JSON.`,
      { provider },
    );
  }

  const choice = parsed.choices?.[0];
  const content = choice?.message?.content ?? '';
  return {
    content,
    usage: parsed.usage
      ? { input_tokens: parsed.usage.prompt_tokens, output_tokens: parsed.usage.completion_tokens }
      : undefined,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
  };
}

/**
 * The error for an answer that never validated. Two codes, because the two
 * situations are fixed in different places: `output-truncated` (the model
 * stopped at the cap mid-answer) is fixed by a cap or a shorter prompt;
 * `invalid-output` (the model finished and still did not answer the schema)
 * is fixed at the prompt. Both carry the raw answer, scrubbed and bounded, so
 * the operator can tell the two apart in the log instead of guessing from a
 * reason string.
 */
function rejectedAnswerError(
  provider: string,
  apiKey: string,
  call: CallResult,
  result: { reason: string; errors?: unknown },
  retried: boolean,
): ProviderError {
  const details = {
    provider,
    reason: result.reason,
    errors: result.errors,
    finish_reason: call.finishReason,
    content_length: call.content.length,
    content_snippet: contentSnippet(call.content, apiKey),
    retried,
  };
  if (call.finishReason === 'length') {
    return new ProviderError(
      'provider.output-truncated',
      `Provider "${provider}" API judge stopped at its output cap (finish_reason "length") after ${call.content.length} characters, before the answer closed; not retried. Raise max_tokens for the provider (crosscheck.yml) or --max-output-tokens, or shorten the prompt.`,
      details,
    );
  }
  return new ProviderError(
    'provider.invalid-output',
    `Provider "${provider}" API judge returned invalid output${retried ? ' after one retry' : ''}: ${result.reason}.`,
    details,
  );
}

/**
 * Both attempts, added together — the provider billed both, and this is the
 * number `smith judge run` prints at the operator.
 *
 * A field is summed only over the attempts that reported it: a provider that
 * answers with usage once and without it once still spent what it did report,
 * and dropping that half because the other is missing would undercount for a
 * second reason. `undefined` survives only when neither attempt said anything.
 */
function addUsage(a: JudgeUsage | undefined, b: JudgeUsage | undefined): JudgeUsage | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const add = (x?: number, y?: number) => (x === undefined ? y : y === undefined ? x : x + y);
  return {
    input_tokens: add(a.input_tokens, b.input_tokens),
    output_tokens: add(a.output_tokens, b.output_tokens),
  };
}

export async function runApiJudge(
  provider: string,
  config: ApiTransportConfig,
  request: JudgeRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<JudgeResult> {
  const apiKey = resolveApiKey(config, provider);
  const start = Date.now();

  let call = await callOnce(provider, config, apiKey, request.prompt, request.budget, fetchImpl);
  let usage = call.usage;
  let result = extractAndValidate(call.content, request.schemaName);
  let retried = false;
  if (!result.valid && nudgeCanHelp(call.finishReason)) {
    call = await callOnce(
      provider,
      config,
      apiKey,
      `${request.prompt}${NUDGE}`,
      request.budget,
      fetchImpl,
    );
    usage = addUsage(usage, call.usage);
    result = extractAndValidate(call.content, request.schemaName);
    retried = true;
  }
  if (!result.valid) {
    throw rejectedAnswerError(
      provider,
      apiKey,
      call,
      { reason: result.reason, errors: 'errors' in result ? result.errors : undefined },
      retried,
    );
  }

  return {
    provider,
    kind: request.kind,
    output: result.value,
    raw_usage: usage,
    latency_ms: Date.now() - start,
  };
}
