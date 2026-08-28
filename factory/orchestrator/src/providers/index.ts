// Provider registry (architecture §6: the judge tier is "provider-agnostic by
// contract", so "any model that can honor the contract can serve"). Adding a
// provider is a crosscheck.yml entry and nothing else — no file here, no
// branch below.
//
// It did not start that way. This function used to open with two name-keyed
// branches, `codex` and `deepseek`, each dispatching to a one-line module that
// forwarded to the same generic transport this file ends with, and each
// refusing to run if its name was paired with the other transport. The
// forwarding modules added no behaviour, and the refusals were the real cost:
// they turned two ordinary strings into reserved words with opinions. An
// operator reaching Codex over an OpenAI-compatible endpoint, or running
// DeepSeek's open weights as a local command, wrote a correct config and was
// told it was misconfigured — and an operator whose own provider happened to
// be called either name inherited a vendor's transport by coincidence of
// spelling. Both are configurations someone will write, and neither is wrong.
//
// So the name is now data all the way through: it selects a config entry and
// labels the result, and `transport` alone decides what runs. Keyed by
// crosscheck.yml's provider names; `claude` (kind: native) is never dispatched
// through here — it's the in-process judge already wired through
// gate.ts/findings.ts.
import { type CrosscheckPolicy, loadCrosscheckPolicy } from '../crosscheck.js';
import { runApiJudge } from './api-transport.js';
import { runCliJudge } from './cli-transport.js';
import type { JudgeRequest, JudgeResult } from './types.js';
import { ProviderError } from './types.js';

export interface RunJudgeOpts {
  policy?: CrosscheckPolicy;
  fetchImpl?: typeof fetch;
}

export async function runJudge(
  providerName: string,
  request: JudgeRequest,
  opts: RunJudgeOpts = {},
): Promise<JudgeResult> {
  const policy = opts.policy ?? loadCrosscheckPolicy();
  const config = policy.providers[providerName];

  if (!config) {
    throw new ProviderError(
      'provider.unknown',
      `Unknown provider "${providerName}" (not in crosscheck.yml).`,
      { provider: providerName },
    );
  }
  if (config.kind === 'native') {
    throw new ProviderError(
      'provider.not-external',
      `Provider "${providerName}" is native (in-process); it has no CLI/API transport to run.`,
      { provider: providerName },
    );
  }
  if (!config.enabled) {
    throw new ProviderError(
      'provider.disabled',
      `Provider "${providerName}" is disabled in crosscheck.yml (enabled: false) — never invoked.`,
      { provider: providerName },
    );
  }

  // Every enabled, non-native provider lands here, whatever it is called.
  // `transport` is validated when crosscheck.yml is parsed, so the two arms
  // below are exhaustive and a provider that reached this point has the fields
  // its arm reads.
  if (config.transport === 'cli') {
    return runCliJudge(providerName, { command: config.command, args: config.args }, request);
  }
  return runApiJudge(
    providerName,
    {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeyEnv: config.apiKeyEnv,
      responseFormatJsonObject: config.responseFormatJsonObject,
    },
    request,
    opts.fetchImpl,
  );
}

export type { CrosscheckPolicy } from '../crosscheck.js';
export type { JudgeBudget, JudgeKind, JudgeRequest, JudgeResult, JudgeUsage } from './types.js';
export { ProviderError } from './types.js';
export { loadCrosscheckPolicy };
