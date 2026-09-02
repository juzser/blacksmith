// Does the cross-provider quorum have the providers crosscheck.yml says it
// has? Every other surface answers that question after the fact: a judge run
// that failed is a `judge-verdict` row with `ok: false`, and `smith stats
// providers` aggregates those rows into a rate. Both are readable only once
// the calls have already been spent.
//
// Two failures motivated this, and they are different from each other:
//
//   1. A provider that is `enabled: true` with its precondition unmet. The
//      factory's own deepseek judge shipped `enabled: true` on a machine with
//      no DEEPSEEK_API_KEY, so every quorum trigger — and gate.ts fires one on
//      every blocking finding, unprompted — spawned a call that could not
//      leave the machine, caught it, and wrote a failure row. Nothing was
//      unsafe: the quorum is fail-closed and the finding stayed blocking. It
//      was pure latency and a log that reads like a provider outage.
//
//   2. A promotion that cannot decide anything. `quorum_rule.min_providers`
//      is 2, and on a gate finding the native provider is excluded as the
//      finder, so the gating pool is the ACTIVE EXTERNALS alone. Promote one
//      provider to `mode: active` and every case still comes back
//      `insufficient-providers` — the operator has taken on the cost of a
//      gating provider and bought no gating. docs/runbooks/providers.md §4
//      states this in prose; until this check existed nothing asserted it.
//
// Deliberately not a judge call. A preflight that proves a provider answers
// by asking it a question costs what it is trying to save, and would turn a
// config check into a network dependency. This asks only what can be known
// locally: is the key set, is the binary on PATH, and does the arithmetic of
// the promotions add up.
import { readFileSync } from 'node:fs';
import { type CrosscheckPolicy, type ProviderConfig, parseCrosscheckPolicy } from './crosscheck.js';
import { CROSSCHECK_POLICY_PATH } from './paths.js';
import { apiKeyPresent, commandOnPath } from './preconditions.js';

/**
 * `ok` — the precondition holds, or there is none. `unmet` — the provider is
 * enabled and cannot be called. `not-applicable` — the provider is disabled,
 * so whether its key is set is nobody's business: an operator who has turned
 * deepseek off should not be told to go set DEEPSEEK_API_KEY.
 */
export type PreconditionStatus = 'ok' | 'unmet' | 'not-applicable';

export interface ProviderPreflight {
  provider: string;
  kind: ProviderConfig['kind'];
  /** `native` for the in-process provider; otherwise the transport it dials out on. */
  transport: 'native' | 'cli' | 'api';
  enabled: boolean;
  /** `native` for the in-process provider, which has no mode of its own. */
  mode: 'native' | 'shadow' | 'active';
  /**
   * What has to be true before a call can leave the machine, named so the
   * operator can act on it: an environment variable name for an API
   * transport, a command name for a CLI one. Never a value — this file reads
   * `process.env[name]` to test emptiness and never prints what it found.
   */
  precondition: string | null;
  status: PreconditionStatus;
  detail: string;
}

export interface PreflightGating {
  /** Enabled, `mode: active`, and callable. The pool a gate finding is judged by. */
  activeExternal: string[];
  /** Enabled and callable but `mode: shadow` — recorded, no gating power. */
  shadowExternal: string[];
  minProviders: number;
  /**
   * Whether a finding the native provider raised could be overturned as the
   * policy currently stands. False under the shipped shadow-only default,
   * which is correct and not a problem; see `problems`.
   */
  canDecide: boolean;
  detail: string;
}

export interface JudgePreflight {
  policyPath: string;
  /**
   * Whether SMITH_CROSSCHECK_OFFLINE is set in this environment. Reported
   * rather than applied: the question this command answers is "is the policy
   * sound", and the switch is a per-command override that says nothing about
   * the file. Applying it would report every external as disabled and hide
   * exactly the misconfiguration being looked for.
   */
  offlineSwitch: boolean;
  providers: ProviderPreflight[];
  gating: PreflightGating;
  /** Non-empty means exit 1: something is configured to cost more than it can deliver. */
  problems: string[];
  /**
   * Costs the operator has declared they accept (crosscheck.yml
   * `quorum_rule.accept_non_gating_actives`). Reported for the same reason
   * `problems` is — the arithmetic has not changed — but never exits 1.
   */
  notes: string[];
}

function inspect(config: ProviderConfig): ProviderPreflight {
  if (config.kind === 'native') {
    return {
      provider: config.name,
      kind: 'native',
      transport: 'native',
      enabled: config.enabled,
      mode: 'native',
      precondition: null,
      status: 'ok',
      detail: 'In-process. Nothing to configure and nothing to dial.',
    };
  }

  const base = {
    provider: config.name,
    kind: config.kind,
    enabled: config.enabled,
    mode: config.mode,
  } as const;

  if (config.transport === 'api') {
    const set = apiKeyPresent(config.apiKeyEnv);
    if (!config.enabled) {
      return {
        ...base,
        transport: 'api',
        precondition: config.apiKeyEnv,
        status: 'not-applicable',
        detail:
          config.enabledSource === 'auto'
            ? `enabled: auto, and ${config.apiKeyEnv} is unset here, so this box does not use it. Set the key to switch it on; nothing to edit.`
            : `Disabled in the policy, so ${config.apiKeyEnv} is not read.`,
      };
    }
    return {
      ...base,
      transport: 'api',
      precondition: config.apiKeyEnv,
      status: set ? 'ok' : 'unmet',
      detail: set
        ? `${config.apiKeyEnv} is set.`
        : `${config.apiKeyEnv} is unset or empty. Every quorum trigger will spend a call that cannot be sent, and record it as provider.missing-api-key.`,
    };
  }

  const resolvable = commandOnPath(config.command);
  if (!config.enabled) {
    return {
      ...base,
      transport: 'cli',
      precondition: config.command,
      status: 'not-applicable',
      detail:
        config.enabledSource === 'auto'
          ? `enabled: auto, and ${config.command} is not on PATH here, so this box does not use it. Install it to switch it on; nothing to edit.`
          : `Disabled in the policy, so ${config.command} is never spawned.`,
    };
  }
  return {
    ...base,
    transport: 'cli',
    precondition: config.command,
    status: resolvable ? 'ok' : 'unmet',
    detail: resolvable
      ? `${config.command} is executable on PATH. Whether it is authenticated is not knowable without spending a call — run "smith judge run --provider ${config.name}" to find out.`
      : `${config.command} is not executable on PATH. Every quorum trigger will spend a call that cannot start.`,
  };
}

/**
 * Read the policy as written and report what it would cost and buy. Pure
 * except for `process.env` and PATH lookups; appends nothing and calls nobody.
 */
export function judgePreflight(policyPath: string = CROSSCHECK_POLICY_PATH): JudgePreflight {
  // parseCrosscheckPolicy with `offline: false` rather than
  // loadCrosscheckPolicy: see `offlineSwitch` above.
  const policy: CrosscheckPolicy = parseCrosscheckPolicy(readFileSync(policyPath, 'utf8'), {
    offline: false,
  });
  const providers = Object.values(policy.providers)
    .map(inspect)
    .sort((a, b) => a.provider.localeCompare(b.provider));

  const callable = providers.filter(
    (p) => p.kind !== 'native' && p.enabled && p.status !== 'unmet',
  );
  const activeExternal = callable.filter((p) => p.mode === 'active').map((p) => p.provider);
  const shadowExternal = callable.filter((p) => p.mode === 'shadow').map((p) => p.provider);
  const minProviders = policy.quorumRule.minProviders;
  const canDecide = activeExternal.length >= minProviders;

  const problems: string[] = [];
  const notes: string[] = [];
  for (const p of providers) {
    if (p.status !== 'unmet') continue;
    problems.push(
      `Provider "${p.provider}" is enabled but its precondition (${p.precondition}) is unmet. Set it, or set "enabled: false" for this runner.`,
    );
  }
  // One promoted provider is the trap worth failing on. Zero is the shipped
  // default and a deliberate one, so it is reported and not complained about.
  //
  // Unless it was chosen: the sentence below has always ended "or accept
  // that these calls are shadow runs that cost like gating ones", and
  // `accept_non_gating_actives` is where that acceptance is now written down.
  // Declared, the same sentence is a note — the cost is unchanged and still
  // printed, but a command that reports a decision the operator already made
  // has no business exiting 1 on it, and a scheduled health check cannot
  // distinguish a permanent 1 from a new one.
  if (activeExternal.length > 0 && !canDecide) {
    const arithmetic = `${activeExternal.length} external provider(s) are mode: active but quorum_rule.min_providers is ${minProviders}. On a finding the native provider raised it is excluded as the finder, so the gating pool is the actives alone and every case returns insufficient-providers.`;
    if (policy.quorumRule.acceptNonGatingActives) {
      notes.push(
        `${arithmetic} Accepted via quorum_rule.accept_non_gating_actives: the verdict still reaches the operator on the escalation, and enabling a second provider starts gating with no further edit.`,
      );
    } else {
      problems.push(
        `${arithmetic} Promote a second provider or accept that these calls are shadow runs that cost like gating ones.`,
      );
    }
  }

  const detail = canDecide
    ? `${activeExternal.length} active external provider(s) against min_providers ${minProviders}: a native finding can be overturned.`
    : activeExternal.length === 0
      ? `No external provider is mode: active. Every cross-check is recorded and none can change an outcome — the shipped default.`
      : `${activeExternal.length} active external provider(s) against min_providers ${minProviders}: nothing can be decided.`;

  return {
    policyPath,
    offlineSwitch: Boolean(process.env.SMITH_CROSSCHECK_OFFLINE),
    providers,
    gating: { activeExternal, shadowExternal, minProviders, canDecide, detail },
    problems,
    notes,
  };
}
