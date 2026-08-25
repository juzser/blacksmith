// Provider registry (architecture §6: "extensible" — adding a provider is
// config + a thin binding, not a redesign). Keyed by crosscheck.yml's
// provider names; `claude` (kind: native) is never dispatched through here —
// it's the in-process judge already wired through gate.ts/findings.ts.
import { type CrosscheckPolicy, loadCrosscheckPolicy } from '../crosscheck.js';
import { runApiJudge } from './api-transport.js';
import { runCliJudge } from './cli-transport.js';
import { runCodexJudge } from './codex.js';
import { runDeepseekJudge } from './deepseek.js';
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

  // Named bindings for the two Phase-8 providers (their own thin config
  // files, per the architecture doc); any FUTURE provider name resolves
  // purely by its declared transport — no per-provider binding required.
  if (providerName === 'codex') {
    if (config.transport !== 'cli') {
      throw new ProviderError(
        'provider.misconfigured',
        'Provider "codex" must be configured with transport: cli.',
        { provider: providerName },
      );
    }
    return runCodexJudge(config, request);
  }
  if (providerName === 'deepseek') {
    if (config.transport !== 'api') {
      throw new ProviderError(
        'provider.misconfigured',
        'Provider "deepseek" must be configured with transport: api.',
        { provider: providerName },
      );
    }
    return runDeepseekJudge(config, request, opts.fetchImpl);
  }

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
