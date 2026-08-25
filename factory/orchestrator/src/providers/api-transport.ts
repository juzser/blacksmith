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
}

const NUDGE = '\n\nReturn only valid JSON per schema.';
const RESPONSE_BODY_ERROR_SNIPPET_LIMIT = 500;

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
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface CallResult {
  content: string;
  usage?: JudgeUsage;
}

async function callOnce(
  provider: string,
  config: ApiTransportConfig,
  apiKey: string,
  prompt: string,
  budget: { timeout_ms: number; max_output_bytes: number },
  fetchImpl: typeof fetch,
): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget.timeout_ms);

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

  const content = parsed.choices?.[0]?.message?.content ?? '';
  return {
    content,
    usage: parsed.usage
      ? { input_tokens: parsed.usage.prompt_tokens, output_tokens: parsed.usage.completion_tokens }
      : undefined,
  };
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
  if (!result.valid) {
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
    if (!result.valid) {
      throw new ProviderError(
        'provider.invalid-output',
        `Provider "${provider}" API judge returned invalid output after one retry: ${result.reason}.`,
        { provider, reason: result.reason, errors: 'errors' in result ? result.errors : undefined },
      );
    }
  }

  return {
    provider,
    kind: request.kind,
    output: result.value,
    raw_usage: usage,
    latency_ms: Date.now() - start,
  };
}
