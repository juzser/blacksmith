// Thin binding: DeepSeek is an OpenAI-compatible API judge (already cheap —
// design decision: API transport, not CLI, since there's no subscription
// auth to save on).
import type { ApiProviderConfig } from '../crosscheck.js';
import { runApiJudge } from './api-transport.js';
import type { JudgeRequest, JudgeResult } from './types.js';

export function runDeepseekJudge(
  config: ApiProviderConfig,
  request: JudgeRequest,
  fetchImpl?: typeof fetch,
): Promise<JudgeResult> {
  return runApiJudge(
    'deepseek',
    {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeyEnv: config.apiKeyEnv,
      responseFormatJsonObject: config.responseFormatJsonObject,
    },
    request,
    fetchImpl,
  );
}
