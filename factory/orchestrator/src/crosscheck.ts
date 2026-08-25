// factory/policies/crosscheck.yml loader (architecture §6 "Multi-provider
// cross-check"). Same parse-with-defaults pattern as scheduler.ts's
// parseSchedulerPolicy()/loadSchedulerPolicy() — a RawXYaml shape for the
// on-disk snake_case document, mapped onto a typed camelCase policy.
//
// `kind: native` (claude) has no transport at all — it's the in-process
// judge already wired through gate.ts/findings.ts, never dispatched through
// providers/index.ts. Codex and DeepSeek each declare a `transport` field
// (Phase 8) that selects which transport module (cli-transport.ts /
// api-transport.ts) runs them; `kind: api` is kept on both for backward
// compatibility with the Phase-1 scaffold (it predates the transport
// split and no longer carries meaning on its own — `transport` is now the
// field that actually selects behavior).
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { SmithError } from './errors.js';
import { CROSSCHECK_POLICY_PATH } from './paths.js';

export class CrosscheckError extends SmithError {}

export type ProviderMode = 'shadow' | 'active';

export interface NativeProviderConfig {
  name: string;
  kind: 'native';
  enabled: boolean;
}

export interface CliProviderConfig {
  name: string;
  kind: 'api';
  transport: 'cli';
  enabled: boolean;
  mode: ProviderMode;
  modelTier: string;
  command: string;
  args: string[];
  /** Optional: a CLI judge usually runs whatever model its own binary defaults to. See providerModel(). */
  model?: string;
}

export interface ApiProviderConfig {
  name: string;
  kind: 'api';
  transport: 'api';
  enabled: boolean;
  mode: ProviderMode;
  modelTier: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  responseFormatJsonObject: boolean;
}

export type ProviderConfig = NativeProviderConfig | CliProviderConfig | ApiProviderConfig;

export interface QuorumRule {
  agreement: string;
  minProviders: number;
}

// crosscheck.yml's plan_quorum block — the machine-readable form of its own
// `triggers:` prose, consumed by src/planQuorum.ts's
// evaluatePlanQuorumTriggers(). See that file's module header for the full
// policy-consequence writeup; this type only carries the parsed values.
export interface PlanQuorumPolicy {
  budgetRatio: number;
  confidenceThreshold: number;
  securityCases: string[];
  securityRoles: string[];
  securityKeywords: string[];
}

/**
 * One finder -> critic relationship from crosscheck.yml's `asymmetric_roles`
 * (P9-23). `finder_ne_critic: true` was prose until this pair list existed:
 * it named no roles, so nothing could check it. dispatchAudit.ts reads these
 * pairs and asserts, against the event log, that the critic's model differed
 * from the model of the finder dispatch it followed.
 */
export interface AsymmetricRolePair {
  finder: string;
  critic: string;
}

export interface AsymmetricRoles {
  finderNeCritic: boolean;
  pairs: AsymmetricRolePair[];
}

export interface CrosscheckPolicy {
  providers: Record<string, ProviderConfig>;
  quorumRule: QuorumRule;
  planQuorum: PlanQuorumPolicy;
  asymmetricRoles: AsymmetricRoles;
}

/**
 * The concrete model a judge dispatch ran on, for the event log's required
 * `model` field. An api-transport provider declares it; a cli-transport one
 * usually doesn't, because the binary picks — `<command>:default` records
 * that honestly rather than inventing a model id nobody verified.
 */
export function providerModel(config: ProviderConfig): string {
  if (config.kind === 'native') return `${config.name}:native`;
  if (config.transport === 'cli') return config.model ?? `${config.command}:default`;
  return config.model;
}

interface RawProviderYaml {
  kind?: string;
  transport?: string;
  enabled?: boolean;
  mode?: string;
  model_tier?: string;
  command?: string;
  args?: string[];
  base_url?: string;
  model?: string;
  api_key_env?: string;
  response_format_json_object?: boolean;
}

interface RawPlanQuorumYaml {
  budget_ratio?: number;
  confidence_threshold?: number;
  security_cases?: string[];
  security_roles?: string[];
  security_keywords?: string[];
}

interface RawAsymmetricRolesYaml {
  finder_ne_critic?: boolean;
  pairs?: { finder?: string; critic?: string }[];
}

interface RawCrosscheckYaml {
  providers?: Record<string, RawProviderYaml>;
  quorum_rule?: { agreement?: string; min_providers?: number };
  plan_quorum?: RawPlanQuorumYaml;
  asymmetric_roles?: RawAsymmetricRolesYaml;
}

// Mirrors the shipped crosscheck.yml asymmetric_roles.pairs block, which in
// turn mirrors two sentences already in the role templates: spec-reviewer
// "never runs on the planner's own model", verifier "never runs on the
// reviewer's own model".
const DEFAULT_ASYMMETRIC_PAIRS: readonly AsymmetricRolePair[] = [
  { finder: 'planner', critic: 'spec-reviewer' },
  { finder: 'reviewer', critic: 'verifier' },
];

const DEFAULT_MODEL_TIER = 'mid'; // taxonomy.yml model_tier — judges run sonnet-tier per architecture §4, external judges default to the same tier absent an override.

// Defaults mirror the checked-in crosscheck.yml plan_quorum block exactly,
// so a hand-authored yaml that omits the block (e.g. in tests) still gets
// the same triggers the shipped policy defines.
const DEFAULT_PLAN_QUORUM_BUDGET_RATIO = 0.5;
const DEFAULT_PLAN_QUORUM_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_PLAN_QUORUM_SECURITY_CASES = ['infra'];
const DEFAULT_PLAN_QUORUM_SECURITY_ROLES = ['security-reviewer'];
const DEFAULT_PLAN_QUORUM_SECURITY_KEYWORDS = [
  'auth',
  'authz',
  'authentication',
  'authorization',
  'credential',
  'secret',
  'token',
  'password',
  'crypto',
  'encryption',
  'tls',
  'injection',
  'xss',
  'csrf',
  'sandbox',
  'permission',
  'privilege',
  'sanitize',
  'escalation',
];

/**
 * Every knob this file hands to a comparison, checked rather than trusted --
 * the same guard scheduler.ts carries for scheduler.yml, kept local because
 * the two policies raise different error codes and default differently.
 *
 * `??` fills in on null/undefined only, so a YAML typo arrived at the
 * comparison as itself while the declared type still said `number`. Nothing
 * threw. The gate simply decided something else:
 *
 *   - `min_providers: two` -- `1 < 'two'` is false, so the
 *     `insufficient-providers` escalation never fires and one judge returns a
 *     decided `1-of-1` for a gate the policy says needs two.
 *   - `budget_ratio: half` -- `totalTokens >= NaN` is false, so trigger 1
 *     never fires however much of the epic cap the plan claims.
 *   - `confidence_threshold: high` -- `0.1 < 'high'` is false, so trigger 3
 *     never fires however unsure the planner says it is.
 *
 * The list knobs fail differently again, because a spread over a bare scalar
 * is a spread over its characters, not a one-element list:
 *
 *   - `security_cases: infra` becomes ['i','n','f','r','a'] and the cases are
 *     matched with `Set.has`, so a task whose case IS infra stops tripping
 *     trigger 2. Same for `security_roles`.
 *   - `security_keywords: auth` becomes ['a','u','t','h'] and keywords match
 *     by substring, so "render a nice table" trips it instead. One typo
 *     silences two arms of trigger 2 and floods the third.
 *
 * The booleans fail a third way, and `enabled` is the one that matters. The
 * `yaml` package is YAML 1.2, where only `false`/`False`/`FALSE` are
 * booleans: `no`, `off`, `n` and a quoted `"false"` all arrive as non-empty
 * strings, `??` does not fire on them, and all three readers ask the field by
 * truthiness (quorum.ts's `enabledExternalProviders` and `runQuorum`,
 * providers/index.ts's `runJudge`). So the operator who followed the runbook's
 * rollback step -- "`enabled: false` means never invoked at all" -- and wrote
 * it the YAML 1.1 way watched the provider keep being dispatched: prompts
 * still leaving the machine, spend still accruing, `provider.disabled` never
 * raised. That is the same silence as the others pointed at the one switch
 * whose whole purpose is to stop something from happening.
 *
 * `asymmetric_roles.pairs` is a list of maps rather than of scalars, and so
 * fails a fourth way: an entry missing either key -- `critics:` is one
 * keystroke from `critic:` -- used to be filtered out of the list instead of
 * refused, and `[] ?? DEFAULT` keeps an emptied list rather than the
 * defaults. dispatchAudit walks the pairs that survived, finds nothing wrong
 * with them, and reports `ok` over a shorter list than the file declares. The
 * pair most likely to go missing that way is the verifier's own rule -- "never
 * runs on the reviewer's own model" -- so a verifier dispatched on the
 * reviewer's model passes an audit that never looked at it.
 *
 * Four of those five fail toward "no quorum needed", on a gate whose whole
 * job is to demand a second opinion; the boolean fails toward "call out".
 * A wrong *number* still passes, as in scheduler.ts: it changes what the gate
 * demands, in the open, where the operator reads it. A wrong *type* changes it
 * in silence.
 */
const DECIDES_DIFFERENTLY =
  'A value the comparison cannot read does not fail the gate, it changes what the gate decides.';

function quorumNumber(field: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CrosscheckError(
      'crosscheck.invalid-policy',
      `crosscheck.yml ${field} must be a finite number; got ${JSON.stringify(value)}. ${DECIDES_DIFFERENTLY}`,
      { field, value },
    );
  }
  return value;
}

function quorumBoolean(field: string, value: boolean): boolean {
  if (typeof value !== 'boolean') {
    throw new CrosscheckError(
      'crosscheck.invalid-policy',
      `crosscheck.yml ${field} must be true or false; got ${JSON.stringify(value)}. This file is YAML 1.2, where no/off/yes/on are strings, and a non-empty string is truthy. ${DECIDES_DIFFERENTLY}`,
      { field, value },
    );
  }
  return value;
}

function quorumString(field: string, value: string): string {
  if (typeof value !== 'string') {
    throw new CrosscheckError(
      'crosscheck.invalid-policy',
      `crosscheck.yml ${field} must be a string; got ${JSON.stringify(value)}. ${DECIDES_DIFFERENTLY}`,
      { field, value },
    );
  }
  return value;
}

/** Copied, not aliased: two parses must not share one array, or a caller mutating its policy would rewrite the defaults for every later parse. */
function quorumStringList(field: string, value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new CrosscheckError(
      'crosscheck.invalid-policy',
      `crosscheck.yml ${field} must be a list of strings; got ${JSON.stringify(value)}. A bare scalar spreads into its characters, which match nothing -- or, for keywords, nearly everything.`,
      { field, value },
    );
  }
  return [...value];
}

/**
 * The pair list, rebuilt entry by entry rather than filtered.
 *
 * A half-readable list is the same hole as no list: keeping only the entries
 * that parsed would hand dispatchAudit a shorter set of rules than the
 * operator wrote and let it report `ok` over the remainder. An empty list
 * stays legal -- dispatchAudit answers it with one `unverifiable` check and
 * `ok: false`, so it is a sentence the operator can read back -- and only a
 * shape no comparison can read is refused. Copied, not aliased, for the same
 * reason quorumStringList() is.
 */
function quorumPairs(field: string, value: readonly unknown[]): AsymmetricRolePair[] {
  if (!Array.isArray(value) || !value.every(isRolePair)) {
    throw new CrosscheckError(
      'crosscheck.invalid-policy',
      `crosscheck.yml ${field} must be a list of { finder, critic } maps naming two roles; got ${JSON.stringify(value)}. A pair the audit cannot read leaves the rule it names unchecked, and the audit still reports ok. ${DECIDES_DIFFERENTLY}`,
      { field, value },
    );
  }
  return value.map((pair) => ({ finder: pair.finder, critic: pair.critic }));
}

function isRolePair(entry: unknown): entry is AsymmetricRolePair {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const { finder, critic } = entry as { finder?: unknown; critic?: unknown };
  return typeof finder === 'string' && finder !== '' && typeof critic === 'string' && critic !== '';
}

function parsePlanQuorum(raw: RawPlanQuorumYaml | undefined): PlanQuorumPolicy {
  return {
    budgetRatio: quorumNumber(
      'plan_quorum.budget_ratio',
      raw?.budget_ratio ?? DEFAULT_PLAN_QUORUM_BUDGET_RATIO,
    ),
    confidenceThreshold: quorumNumber(
      'plan_quorum.confidence_threshold',
      raw?.confidence_threshold ?? DEFAULT_PLAN_QUORUM_CONFIDENCE_THRESHOLD,
    ),
    securityCases: quorumStringList(
      'plan_quorum.security_cases',
      raw?.security_cases ?? DEFAULT_PLAN_QUORUM_SECURITY_CASES,
    ),
    securityRoles: quorumStringList(
      'plan_quorum.security_roles',
      raw?.security_roles ?? DEFAULT_PLAN_QUORUM_SECURITY_ROLES,
    ),
    securityKeywords: quorumStringList(
      'plan_quorum.security_keywords',
      raw?.security_keywords ?? DEFAULT_PLAN_QUORUM_SECURITY_KEYWORDS,
    ),
  };
}

function parseProvider(name: string, raw: RawProviderYaml): ProviderConfig {
  // `enabled` is checked before anything else this function does, because it
  // is the field that decides whether the rest of the config is ever used.
  const enabled = quorumBoolean(`providers.${name}.enabled`, raw.enabled ?? false);

  if (raw.kind === 'native') {
    return { name, kind: 'native', enabled };
  }

  // `mode` needs no check: anything that is not exactly 'active' becomes
  // 'shadow', which is the safe direction for it -- a verdict that gates
  // nothing. Left as it is, and named here so the asymmetry reads as chosen.
  const mode: ProviderMode = raw.mode === 'active' ? 'active' : 'shadow';
  const modelTier = quorumString(
    `providers.${name}.model_tier`,
    raw.model_tier ?? DEFAULT_MODEL_TIER,
  );

  if (raw.transport === 'cli') {
    if (!raw.command) {
      throw new CrosscheckError(
        'crosscheck.invalid-provider',
        `Provider "${name}" has transport: cli but no command.`,
        { provider: name },
      );
    }
    return {
      name,
      kind: 'api',
      transport: 'cli',
      enabled,
      mode,
      modelTier,
      command: quorumString(`providers.${name}.command`, raw.command),
      // spawn(command, 'exec') throws ERR_INVALID_ARG_TYPE at dispatch, which
      // quorum.ts catches and files as a provider error -- so the judge drops
      // out of the quorum and the run reads as if the policy said so.
      args: quorumStringList(`providers.${name}.args`, raw.args ?? []),
      ...(raw.model ? { model: raw.model } : {}),
    };
  }

  if (raw.transport === 'api') {
    if (!raw.base_url || !raw.model || !raw.api_key_env) {
      throw new CrosscheckError(
        'crosscheck.invalid-provider',
        `Provider "${name}" has transport: api but is missing base_url/model/api_key_env.`,
        { provider: name },
      );
    }
    return {
      name,
      kind: 'api',
      transport: 'api',
      enabled,
      mode,
      modelTier,
      baseUrl: quorumString(`providers.${name}.base_url`, raw.base_url),
      model: quorumString(`providers.${name}.model`, raw.model),
      apiKeyEnv: quorumString(`providers.${name}.api_key_env`, raw.api_key_env),
      responseFormatJsonObject: quorumBoolean(
        `providers.${name}.response_format_json_object`,
        raw.response_format_json_object ?? true,
      ),
    };
  }

  throw new CrosscheckError(
    'crosscheck.invalid-provider',
    `Provider "${name}" is not kind: native and has no recognized transport (got "${String(raw.transport)}").`,
    { provider: name, transport: raw.transport },
  );
}

function parseAsymmetricRoles(raw: RawAsymmetricRolesYaml | undefined): AsymmetricRoles {
  return {
    // This one's wrong-shape direction is benign -- a truthy string keeps the
    // rule enforced -- but an operator who writes `no` still got the opposite
    // of what they wrote, and was not told.
    finderNeCritic: quorumBoolean(
      'asymmetric_roles.finder_ne_critic',
      raw?.finder_ne_critic ?? true,
    ),
    // Copied, not aliased — same reason as parsePlanQuorum() above.
    pairs: quorumPairs(
      'asymmetric_roles.pairs',
      raw?.pairs ?? DEFAULT_ASYMMETRIC_PAIRS.map((p) => ({ ...p })),
    ),
  };
}

export interface CrosscheckLoadOptions {
  /**
   * Force every non-native provider to `enabled: false`. `kind: native`
   * (claude) is untouched because it is the in-process judge — it dispatches
   * through no transport and reaches nothing outside this process.
   *
   * This exists because `enabled` is the one field in crosscheck.yml that
   * tracks a machine rather than the repo: it says which judge binaries and
   * API keys a given box actually has, and flipping it is a supported operator
   * action (docs/runbooks/providers.md §2). Anything that must behave the same
   * on every box — the test suite, and CI — has to be able to say "parse this
   * file, but invoke nothing", instead of inheriting whichever toggles the
   * working copy happens to carry. See loadCrosscheckPolicy() for the switch.
   */
  offline?: boolean;
}

export function parseCrosscheckPolicy(
  yamlText: string,
  options: CrosscheckLoadOptions = {},
): CrosscheckPolicy {
  const doc = (parseYaml(yamlText) ?? {}) as RawCrosscheckYaml;
  if (!doc.providers || Object.keys(doc.providers).length === 0) {
    throw new CrosscheckError('crosscheck.invalid-policy', 'crosscheck.yml has no providers.');
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [name, raw] of Object.entries(doc.providers)) {
    const config = parseProvider(name, raw ?? {});
    providers[name] =
      options.offline && config.kind !== 'native' ? { ...config, enabled: false } : config;
  }

  return {
    providers,
    quorumRule: {
      agreement: doc.quorum_rule?.agreement ?? '2-of-3',
      minProviders: quorumNumber('quorum_rule.min_providers', doc.quorum_rule?.min_providers ?? 2),
    },
    planQuorum: parsePlanQuorum(doc.plan_quorum),
    asymmetricRoles: parseAsymmetricRoles(doc.asymmetric_roles),
  };
}

/**
 * Reads the policy, honouring `SMITH_CROSSCHECK_OFFLINE`: set it to anything
 * non-empty and no external provider can be invoked, whatever the file says.
 *
 * The switch is read here rather than passed down from each call site because
 * the property it protects is process-wide — "this process makes no judge
 * calls out of the machine" — and because it has to survive `spawn`, which
 * inherits the environment but not an argument. The CLI tests exercise the
 * built binary as a subprocess; nothing else would reach them.
 */
export function loadCrosscheckPolicy(
  filePath: string = CROSSCHECK_POLICY_PATH,
  options: CrosscheckLoadOptions = {},
): CrosscheckPolicy {
  return parseCrosscheckPolicy(readFileSync(filePath, 'utf8'), {
    offline: options.offline ?? Boolean(process.env.SMITH_CROSSCHECK_OFFLINE),
  });
}
