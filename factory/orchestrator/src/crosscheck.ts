// factory/policies/crosscheck.yml loader (architecture §6 "Multi-provider
// cross-check"). Same parse-with-defaults pattern as scheduler.ts's
// parseSchedulerPolicy()/loadSchedulerPolicy() — a RawXYaml shape for the
// on-disk snake_case document, mapped onto a typed camelCase policy.
//
// `kind: native` (claude) has no transport at all — it's the in-process
// judge already wired through gate.ts/findings.ts, never dispatched through
// providers/index.ts. Every other provider declares a `transport` field
// (Phase 8) that selects which transport module (cli-transport.ts /
// api-transport.ts) runs it — whatever the provider is called, since nothing
// downstream dispatches on the name. `kind: api` is kept on those for
// backward compatibility with the Phase-1 scaffold (it predates the transport
// split and no longer carries meaning on its own — `transport` is now the
// field that actually selects behavior).
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { SmithError } from './errors.js';
import { CROSSCHECK_POLICY_PATH } from './paths.js';
import { apiKeyPresent, commandOnPath } from './preconditions.js';

export class CrosscheckError extends SmithError {}

export type ProviderMode = 'shadow' | 'active';

export interface NativeProviderConfig {
  name: string;
  kind: 'native';
  enabled: boolean;
}

/**
 * Who decided a provider's `enabled`, so that a report can name the right
 * decider instead of the nearest one.
 *
 * - `declared` — the file says true or false in so many words.
 * - `auto` — the file said `auto` and THIS BOX answered, by having the binary
 *   or the key, or by not having it.
 * - `offline` — neither: `SMITH_CROSSCHECK_OFFLINE` forced the provider off as
 *   the policy loaded, whatever the file said.
 *
 * Nothing gates on this. It exists because "your box has no codex", "your
 * policy disabled codex" and "the offline switch is set" are three different
 * sentences, at most one of them is true, and a report that picks the wrong
 * one sends an operator to edit a file that is already correct.
 */
export type EnabledSource = 'declared' | 'auto' | 'offline';

export interface CliProviderConfig {
  name: string;
  kind: 'api';
  transport: 'cli';
  enabled: boolean;
  enabledSource: EnabledSource;
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
  enabledSource: EnabledSource;
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
  /**
   * The operator has read the arithmetic and wants the calls anyway.
   *
   * With one external provider promoted to `active` and `min_providers: 2`,
   * every case whose finder is the native judge escalates for
   * insufficient-providers exactly as it would with none promoted — the
   * finder is excluded, so the gating pool is the actives alone, and one
   * cannot meet two. `smith judge preflight` calls that out, because walking
   * into it unaware means paying gating latency for shadow-grade results.
   *
   * Setting this says it was not unaware: the second opinion still reaches
   * the operator on the escalation, and the day a second provider is enabled
   * the pool meets the rule with no further edit. It silences that one
   * advisory and nothing else — an unmet precondition stays a problem, and
   * `canDecide` keeps reporting what can actually gate.
   */
  acceptNonGatingActives: boolean;
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

/**
 * One "this role does not grade its own work" rule.
 *
 * Deliberately not an `AsymmetricRolePair`. That rule compares the two
 * dispatches' *models*, and for a tester the model is the wrong question: a
 * tester may legitimately run on the coder's model, and forcing a second
 * vendor onto it would buy nothing. What it may not do is run inside the
 * coder's own turn, and the only evidence of a separate turn the event log
 * can hold is a separate `dispatch_decision`, written by the node that
 * dispatched and never by an agent about itself. delegation.yml decides who
 * may be such a node, and delegation.ts refuses any grant that would let a
 * `worker` here dispatch its own `auditor`.
 */
export interface RoleIsolationPair {
  /** The role whose work is being graded. */
  worker: string;
  /** The role that must have been dispatched separately to grade it. */
  auditor: string;
}

export interface RoleIsolation {
  pairs: RoleIsolationPair[];
}

/** How a fingerprint both the native reviewer and the independent finder raised resolves when they disagree on severity. */
export type SeverityResolution = 'highest-wins' | 'native-wins';

/**
 * crosscheck.yml's `independent_finder` block — the additive half of the
 * cross-provider tier. Everything else in this file makes a quorum a brake;
 * this makes it an eye. See the block's own comment for what it deliberately
 * does not do, and crossFinding.ts for the reconciliation it feeds.
 */
export interface IndependentFinder {
  /** Ships false. `false` means never invoked at all, regardless of `mode` — the same contract `providers.<name>.enabled` has. */
  enabled: boolean;
  /** `shadow` records reconciliations with zero gating power; only `active` may raise a severity or mint a finding. */
  mode: ProviderMode;
  /** Which external providers run the finder. Validated at run time, not parse time: a policy naming a provider this box has not configured is still a readable policy. */
  providers: string[];
  /** The operator mandate to send worktree source to a third-party API. Ships false; the runner refuses without it rather than prompting a finder that has nothing to read. */
  sendDiff: boolean;
  /** Above this, the runner refuses rather than truncating — half a diff produces confident findings about code that is not there. */
  maxDiffBytes: number;
  severityResolution: SeverityResolution;
}

export interface CrosscheckPolicy {
  providers: Record<string, ProviderConfig>;
  quorumRule: QuorumRule;
  planQuorum: PlanQuorumPolicy;
  asymmetricRoles: AsymmetricRoles;
  roleIsolation: RoleIsolation;
  independentFinder: IndependentFinder;
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
  /** `boolean` or the string `auto`; anything else is refused by parseEnabled. */
  enabled?: boolean | string;
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

interface RawRoleIsolationYaml {
  pairs?: { worker?: string; auditor?: string }[];
}

interface RawIndependentFinderYaml {
  enabled?: boolean;
  mode?: string;
  providers?: string[];
  send_diff?: boolean;
  max_diff_bytes?: number;
  severity_resolution?: string;
}

interface RawCrosscheckYaml {
  providers?: Record<string, RawProviderYaml>;
  quorum_rule?: { agreement?: string; min_providers?: number; accept_non_gating_actives?: boolean };
  plan_quorum?: RawPlanQuorumYaml;
  asymmetric_roles?: RawAsymmetricRolesYaml;
  role_isolation?: RawRoleIsolationYaml;
  independent_finder?: RawIndependentFinderYaml;
}

// Mirrors the shipped crosscheck.yml asymmetric_roles.pairs block, which in
// turn mirrors two sentences already in the role templates: spec-reviewer
// "never runs on the planner's own model", verifier "never runs on the
// reviewer's own model".
const DEFAULT_ASYMMETRIC_PAIRS: readonly AsymmetricRolePair[] = [
  { finder: 'planner', critic: 'spec-reviewer' },
  { finder: 'reviewer', critic: 'verifier' },
];

// Mirrors the shipped crosscheck.yml role_isolation.pairs block. One entry,
// and it is meant to stay one until a second role starts grading work it
// could have written: every other grader in the pipeline is a judge, and a
// judge cannot write at all (`role_write_scopes`, docs/standards/guardrails.md).
const DEFAULT_ROLE_ISOLATION_PAIRS: readonly RoleIsolationPair[] = [
  { worker: 'coder', auditor: 'tester' },
];

// Mirrors the shipped crosscheck.yml independent_finder block. Every default
// here is the OFF position: a file that omits the block entirely gets a finder
// that is disabled, names nobody, gates nothing if enabled, and refuses to send
// a diff. The only way to any of the four powers is an operator writing it down.
//
// `providers` is empty rather than a name because this file is the fallback for
// a policy that did not say, and nothing here knows which vendors a given box
// has. A default naming one would dispatch a CLI the operator may never have
// installed, and then report `independent_finder.providers names "<vendor>"`
// back to someone who named no vendor at all. Empty says the true thing: nobody
// was asked. runIndependentFinder() refuses on it in those words.
const DEFAULT_INDEPENDENT_FINDER_PROVIDERS: readonly string[] = [];
const DEFAULT_INDEPENDENT_FINDER_MAX_DIFF_BYTES = 120_000;

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
      `crosscheck.yml ${field} must be true or false; got ${JSON.stringify(value)}. This file is YAML 1.2, where no/off/yes/on are strings, and a non-empty string is truthy. On an external provider's enabled the one other legal value is auto, unquoted and lowercase, which resolves against that provider's precondition on the box reading the file. ${DECIDES_DIFFERENTLY}`,
      { field, value },
    );
  }
  return value;
}

/**
 * `enabled` reads one value more than the other booleans do. `auto` means
 * "ask this box": the parser resolves it against the same precondition
 * `smith judge preflight` reports on, so a policy that names a judge no box
 * has to have is legal to ship, and silent where it cannot run.
 *
 * Only the exact lowercase word. `Auto` and a quoted `"auto"` are refused
 * with everything else, because the whole reason this field is checked at all
 * is that a near-miss here used to keep a judge switched on.
 */
function parseEnabled(field: string, value: boolean | string | undefined): boolean | 'auto' {
  if (value === 'auto') return 'auto';
  return quorumBoolean(field, value as boolean);
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
  const declared = parseEnabled(`providers.${name}.enabled`, raw.enabled ?? false);
  const enabledSource = declared === 'auto' ? 'auto' : 'declared';

  if (raw.kind === 'native') {
    if (declared === 'auto') {
      throw new CrosscheckError(
        'crosscheck.invalid-provider',
        `crosscheck.yml providers.${name}.enabled is auto, but "${name}" is kind: native — it runs in this process and has no precondition to ask about. Write true or false.`,
        { provider: name, field: `providers.${name}.enabled` },
      );
    }
    return { name, kind: 'native', enabled: declared };
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
    const command = quorumString(`providers.${name}.command`, raw.command);
    return {
      name,
      kind: 'api',
      transport: 'cli',
      // `auto` asks the same question judgePreflight reports on: is the
      // binary runnable here. Not whether it is authenticated -- only a real
      // call knows that, so `auto` can still resolve true on a box where
      // `codex login` was never run, and the quorum records the failure.
      enabled: declared === 'auto' ? commandOnPath(command) : declared,
      enabledSource,
      mode,
      modelTier,
      command,
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
    const apiKeyEnv = quorumString(`providers.${name}.api_key_env`, raw.api_key_env);
    return {
      name,
      kind: 'api',
      transport: 'api',
      // Set and non-empty, which is all that is knowable without spending a
      // call; whether the key is VALID is not.
      enabled: declared === 'auto' ? apiKeyPresent(apiKeyEnv) : declared,
      enabledSource,
      mode,
      modelTier,
      baseUrl: quorumString(`providers.${name}.base_url`, raw.base_url),
      model: quorumString(`providers.${name}.model`, raw.model),
      apiKeyEnv,
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

/**
 * The isolation pair list, rebuilt entry by entry for quorumPairs()' reason:
 * a half-readable list is the same hole as no list. An empty list stays legal
 * and testerAudit answers it with one `unverifiable` check.
 */
function isolationPairs(field: string, value: readonly unknown[]): RoleIsolationPair[] {
  if (!Array.isArray(value) || !value.every(isIsolationPair)) {
    throw new CrosscheckError(
      'crosscheck.invalid-policy',
      `crosscheck.yml ${field} must be a list of { worker, auditor } maps naming two roles; got ${JSON.stringify(value)}. A pair the audit cannot read leaves the rule it names unchecked, and the audit still reports ok. ${DECIDES_DIFFERENTLY}`,
      { field, value },
    );
  }
  return value.map((pair) => ({ worker: pair.worker, auditor: pair.auditor }));
}

function isIsolationPair(entry: unknown): entry is RoleIsolationPair {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const { worker, auditor } = entry as { worker?: unknown; auditor?: unknown };
  return (
    typeof worker === 'string' && worker !== '' && typeof auditor === 'string' && auditor !== ''
  );
}

function parseRoleIsolation(raw: RawRoleIsolationYaml | undefined): RoleIsolation {
  return {
    // Copied, not aliased — same reason as parsePlanQuorum() above.
    pairs: isolationPairs(
      'role_isolation.pairs',
      raw?.pairs ?? DEFAULT_ROLE_ISOLATION_PAIRS.map((p) => ({ ...p })),
    ),
  };
}

/**
 * `severity_resolution` gets a closed check where `mode` gets none, and the
 * asymmetry is the point. An unreadable `mode` falls to `shadow`, which is the
 * safe direction — a verdict that gates nothing. An unreadable
 * `severity_resolution` has no safe direction: defaulting to `native-wins`
 * silently discards the escalation the operator asked for, and defaulting to
 * `highest-wins` silently grants one they did not. So it is refused.
 */
function parseSeverityResolution(value: string): SeverityResolution {
  if (value === 'highest-wins' || value === 'native-wins') return value;
  throw new CrosscheckError(
    'crosscheck.invalid-policy',
    `crosscheck.yml independent_finder.severity_resolution must be "highest-wins" or "native-wins"; got ${JSON.stringify(value)}. ${DECIDES_DIFFERENTLY}`,
    { field: 'independent_finder.severity_resolution', value },
  );
}

function parseIndependentFinder(raw: RawIndependentFinderYaml | undefined): IndependentFinder {
  const maxDiffBytes = quorumNumber(
    'independent_finder.max_diff_bytes',
    raw?.max_diff_bytes ?? DEFAULT_INDEPENDENT_FINDER_MAX_DIFF_BYTES,
  );
  if (!Number.isInteger(maxDiffBytes) || maxDiffBytes <= 0) {
    throw new CrosscheckError(
      'crosscheck.invalid-policy',
      `crosscheck.yml independent_finder.max_diff_bytes must be a positive integer; got ${JSON.stringify(maxDiffBytes)}. A cap of zero or less refuses every diff, which reads in the log exactly like a finder that ran and found nothing.`,
      { field: 'independent_finder.max_diff_bytes', value: maxDiffBytes },
    );
  }
  return {
    enabled: quorumBoolean('independent_finder.enabled', raw?.enabled ?? false),
    // Same fall-to-shadow rule as a provider's own `mode`, for the same reason.
    mode: raw?.mode === 'active' ? 'active' : 'shadow',
    // Copied, not aliased — same reason as parsePlanQuorum() above.
    providers: quorumStringList(
      'independent_finder.providers',
      raw?.providers ?? DEFAULT_INDEPENDENT_FINDER_PROVIDERS,
    ),
    sendDiff: quorumBoolean('independent_finder.send_diff', raw?.send_diff ?? false),
    maxDiffBytes,
    severityResolution: parseSeverityResolution(
      quorumString(
        'independent_finder.severity_resolution',
        raw?.severity_resolution ?? 'highest-wins',
      ),
    ),
  };
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
      options.offline && config.kind !== 'native'
        ? // The switch is the decider now, and says so: a reader that saw
          // `auto` here would report a box that lacks the binary, which is a
          // different fault with a different fix.
          { ...config, enabled: false, enabledSource: 'offline' }
        : config;
  }

  return {
    providers,
    quorumRule: {
      agreement: doc.quorum_rule?.agreement ?? '2-of-3',
      minProviders: quorumNumber('quorum_rule.min_providers', doc.quorum_rule?.min_providers ?? 2),
      acceptNonGatingActives: quorumBoolean(
        'quorum_rule.accept_non_gating_actives',
        doc.quorum_rule?.accept_non_gating_actives ?? false,
      ),
    },
    planQuorum: parsePlanQuorum(doc.plan_quorum),
    asymmetricRoles: parseAsymmetricRoles(doc.asymmetric_roles),
    roleIsolation: parseRoleIsolation(doc.role_isolation),
    // Not touched by `offline`. That switch exists to stop this process
    // reaching out of the machine, and it already does: it disables every
    // non-native provider, and runIndependentFinder() invokes providers
    // through the same enabled check runQuorumCase() does. Flipping
    // `independent_finder.enabled` here as well would conflate "make no calls"
    // with "make no reconciliations", and `crossfind reconcile` — which is
    // pure, offline, and calls nothing — would stop answering under it.
    independentFinder: parseIndependentFinder(doc.independent_finder),
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
