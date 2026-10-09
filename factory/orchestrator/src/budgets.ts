// factory/policies/budgets.yml loader. Same parse-with-defaults pattern as
// crosscheck.ts/scheduler.ts: a RawXYaml on-disk snake_case shape mapped onto a
// typed camelCase policy.
//
// `epic.cap_tokens` is the field src/planQuorum.ts's budget trigger
// (crosscheck.yml plan_quorum.budget_ratio) reads, via the sum of *declared*
// task budgets. The per-role caps below are modeled as of P9-18 so the gate can
// compare a declared task budget against what the task actually spent — see
// checkTaskBudget. `escalation_ladder` is parsed as of P9-32 and asserted
// against the event log by src/escalation.ts. `context_window` and
// `effort_scaling` are still prompt-level: agents read them from their own
// templates, and nothing here parses them.
//
// Every number is sized per effort tier (effort.yml's small / medium / huge,
// the tier being the epic plan's `effort`). budgets.yml declares the epic cap
// as an explicit triplet and each task cap once, at medium, with one
// `task_tier_scale` multiplying them for the other tiers. A policy is loaded
// FOR a tier: parseBudgetPolicy / loadBudgetPolicy take it, and a caller with
// no plan in hand gets effort.yml's `default_tier`.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { EFFORT_TIERS, type EffortTier, isEffortTier } from './effortTiers.js';
import { readEnv } from './env.js';
import { SmithError } from './errors.js';
import { BUDGETS_POLICY_PATH, EFFORT_POLICY_PATH } from './paths.js';

export class BudgetError extends SmithError {}

export interface EpicBudgetPolicy {
  capTokens: number;
  alarmRatio: number;
  /** `epic.max_in_flight_tasks`, or null when the policy declares no cap. */
  maxInFlightTasks: number | null;
}

export interface RoleBudgetPolicy {
  capTokens: number;
}

export interface CoderBudgetPolicy extends RoleBudgetPolicy {
  capDiffLines: number;
}

/**
 * The roles budgets.yml prices, one cap each. Every other role the factory
 * dispatches (merger, uiux, scribe, wave-runner) has no cap, and
 * src/budgetAlarm.ts reports a dispatch of one as a hole rather than as free.
 */
export const PRICED_ROLES = [
  'coder',
  'tester',
  'planner',
  'researcher',
  'spec-reviewer',
  'grader',
  'reviewer',
  'verifier',
  'security-reviewer',
  'auditor',
] as const;

export type PricedRole = (typeof PRICED_ROLES)[number];

export function isPricedRole(role: string): role is PricedRole {
  return (PRICED_ROLES as readonly string[]).includes(role);
}

export type TaskBudgetPolicy = { coder: CoderBudgetPolicy } & Record<
  Exclude<PricedRole, 'coder'>,
  RoleBudgetPolicy
>;

export interface PreCodeBudgetPolicy {
  shareOfEpicBudgetMax: number;
}

/**
 * One rung of `escalation_ladder.rungs`, loaded verbatim (P9-32).
 *
 * This loader stays dumb on purpose — it maps the on-disk shape and validates
 * nothing beyond types, exactly as it does for every other block. `enforce`
 * is a bare string, not the closed union: src/escalation.ts owns the set of
 * keywords it can act on, and an unrecognised one has to reach it as itself so
 * the audit can report `unverifiable` instead of silently reading as "this
 * rung declares no obligation".
 *
 * `failedRounds` is null when the rung declares no numeric threshold, and the
 * rung is kept rather than dropped for the same reason: a rung nobody can
 * evaluate is a finding, not an absence.
 */
export interface EscalationRung {
  rung: number;
  /** `failed_rounds`, or null when the rung declares no numeric threshold. */
  failedRounds: number | null;
  trigger: string;
  /** The obligation this rung imposes, in prose; null when it imposes none. */
  action: string | null;
  /** Machine-readable form of `action` — see src/escalation.ts. */
  enforce: string | null;
}

export interface BudgetPolicy {
  /** The effort tier every number below was sized for. */
  tier: EffortTier;
  epic: EpicBudgetPolicy;
  task: TaskBudgetPolicy;
  preCodeBudget: PreCodeBudgetPolicy;
  /** Ascending by threshold; empty when budgets.yml declares no ladder. */
  escalationLadder: EscalationRung[];
}

interface RawEscalationRung {
  rung?: unknown;
  failed_rounds?: unknown;
  trigger?: unknown;
  action?: unknown;
  enforce?: unknown;
}

interface RawBudgetsYaml {
  epic?: {
    cap_tokens?: number | Partial<Record<EffortTier, number>>;
    alarm_ratio?: number;
    max_in_flight_tasks?: number | null;
  };
  task_tier_scale?: Partial<Record<EffortTier, number>>;
  task?: Partial<Record<PricedRole | 'judges', { cap_tokens?: number; cap_diff_lines?: number }>>;
  pre_code_budget?: { share_of_epic_budget_max?: number };
  escalation_ladder?: { rungs?: RawEscalationRung[] };
}

/**
 * Deliberately NOT the number budgets.yml declares (a 4M / 16M / 32M triplet
 * since 2026-09-29) — the one default here that does not mirror the policy
 * file, and the same number at every tier.
 *
 * The other DEFAULT_* numbers below match budgets.yml's medium tier because
 * nobody has ever had cause to diverge them. This one has cause: the repo's
 * cap was raised by operator decisions sized from this repo's own dogfood
 * epics. That is a judgement about this repo's epics, not a floor to hand a
 * project that shipped no policy at all — such a project gets the
 * conservative number and an alarm that fires early, which is the failure
 * direction to prefer.
 *
 * Do not "fix" the mismatch by syncing them.
 */
const DEFAULT_EPIC_CAP_TOKENS = 2_000_000;
const DEFAULT_EPIC_ALARM_RATIO = 0.7;
const DEFAULT_CODER_CAP_DIFF_LINES = 700;
/** budgets.yml's medium-tier task caps. */
const DEFAULT_TASK_CAP_TOKENS: Readonly<Record<PricedRole, number>> = Object.freeze({
  coder: 220_000,
  tester: 60_000,
  planner: 110_000,
  researcher: 80_000,
  'spec-reviewer': 170_000,
  grader: 110_000,
  reviewer: 60_000,
  verifier: 40_000,
  'security-reviewer': 80_000,
  auditor: 90_000,
});
const DEFAULT_TASK_TIER_SCALE: Readonly<Record<EffortTier, number>> = Object.freeze({
  small: 0.5,
  medium: 1,
  huge: 2,
});
const DEFAULT_PRE_CODE_SHARE_MAX = 0.15;

/**
 * The four judges a pre-2026-09-29 budgets.yml priced together under
 * `task.judges`. Still read, below a role the file names itself, so an older
 * policy file keeps its numbers.
 */
const LEGACY_JUDGE_BUCKET_ROLES: readonly PricedRole[] = [
  'spec-reviewer',
  'reviewer',
  'verifier',
  'grader',
];

/**
 * effort.yml's `default_tier`, read directly rather than through effort.ts:
 * effort.ts imports plan.ts, and plan.ts imports this module. Read on every
 * call, not cached: the file is small, and a process that outlives an edit to
 * it (the daemon) must not keep budgeting at the tier it read first. A file
 * that cannot be read, or whose `default_tier` is missing or names no tier, is
 * refused the way effort.ts refuses it — a typo there must not quietly size
 * every untiered epic at `medium`.
 */
function defaultBudgetTier(effortPolicyFile: string = EFFORT_POLICY_PATH): EffortTier {
  let doc: { default_tier?: unknown } | null;
  try {
    doc = parseYaml(readFileSync(effortPolicyFile, 'utf8')) as { default_tier?: unknown } | null;
  } catch (error) {
    throw new BudgetError(
      'budgets.invalid-policy',
      `Cannot read effort.yml's default_tier from ${effortPolicyFile}: ${(error as Error).message}. A budget with no tier named is sized at that tier, so there is no budget without it.`,
      { file: effortPolicyFile },
    );
  }
  const tier = doc?.default_tier;
  if (!isEffortTier(tier)) {
    throw new BudgetError(
      'budgets.invalid-policy',
      `effort.yml default_tier must be one of ${EFFORT_TIERS.join(', ')}; got ${JSON.stringify(tier ?? null)} in ${effortPolicyFile}.`,
      { file: effortPolicyFile, field: 'default_tier', value: tier ?? null },
    );
  }
  return tier;
}

/**
 * The tier a budget is sized for: the given one when it names an effort tier,
 * otherwise effort.yml's `default_tier`. An absent or unknown value is "no
 * tier chosen", never an error — plan validation owns refusing a bad
 * `effort`. Callers holding a plan pass epicBudget.ts `budgetTierForPlan`,
 * which applies the security floor; a plan's raw `effort` is not its tier.
 */
export function resolveBudgetTier(tier: unknown, effortPolicyFile?: string): EffortTier {
  return isEffortTier(tier) ? tier : defaultBudgetTier(effortPolicyFile);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The ladder in ascending threshold order.
 *
 * There is no default ladder. A budgets.yml that declares none yields `[]`,
 * and src/escalation.ts reports that as unverifiable — inventing the three
 * rungs here would let a policy file nobody wrote produce a clean audit.
 * Rungs with no numeric threshold sort last, after every rung that has one.
 */
function parseEscalationLadder(raw: RawEscalationRung[] | undefined): EscalationRung[] {
  const rungs = (raw ?? []).map((entry, index) => ({
    rung: typeof entry.rung === 'number' ? entry.rung : index + 1,
    failedRounds: typeof entry.failed_rounds === 'number' ? entry.failed_rounds : null,
    trigger: optionalString(entry.trigger) ?? '',
    action: optionalString(entry.action),
    enforce: optionalString(entry.enforce),
  }));
  return rungs.sort((a, b) => {
    if (a.failedRounds === b.failedRounds) return a.rung - b.rung;
    if (a.failedRounds === null) return 1;
    if (b.failedRounds === null) return -1;
    return a.failedRounds - b.failedRounds;
  });
}

/**
 * Every cap, checked rather than trusted -- the same guard crosscheck.ts and
 * scheduler.ts carry for their own policy files, and the likeliest of the
 * three to actually be typed: `200k` and `80%` are how a human writes these
 * numbers everywhere except here.
 *
 * `??` fills in on null/undefined only, so a YAML typo arrived at the
 * comparison as itself while the declared type still said `number`. Nothing
 * threw, and a cap that no comparison can read is not a loose cap -- it is no
 * cap at all:
 *
 *   - `cap_tokens: 200k` -- `10_000_000 >= '200k'` is false, so an epic ten
 *     times over budget is reported `under`.
 *   - `alarm_ratio: 80%` -- checkBudgetAlarm computes
 *     `Math.floor(capTokens * alarmRatio)`, so the alarm threshold is NaN and
 *     every comparison against it is false.
 *   - `cap_diff_lines: four hundred` -- a 99,999-line diff is under cap.
 *
 * The alarm case is the one that outlives its typo: NaN serialises to null,
 * so the report records that there was no alarm threshold rather than that
 * the policy could not be read. Same reason cli.ts refuses a `--now` it
 * cannot parse instead of writing `Math.floor(NaN)` into an append-only log
 * (D-209).
 *
 * A wrong *number* still passes: a 10-token cap stops the very first task and
 * says so. A wrong *type* stops nothing and says nothing.
 */
const NO_CAP_AT_ALL = 'A cap the comparison cannot read is not a loose cap, it is no cap at all.';

function capNumber(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BudgetError(
      'budgets.invalid-policy',
      `budgets.yml ${field} must be a finite number; got ${JSON.stringify(value)}. ${NO_CAP_AT_ALL}`,
      { field, value },
    );
  }
  return value;
}

/**
 * Same guard as capNumber, for the one field allowed to say "no cap" rather
 * than declare a number: `epic.max_in_flight_tasks` is null by default (see
 * budgets.yml's own comment on the field), and null has to reach
 * checkWaveBudget as the deliberate "no fan-out limit" it is, not as a value
 * that failed capNumber's finite-number check. Anything else that is not a
 * finite number — `"none"`, `80%`, a typo'd string — is the same "no cap at
 * all" failure capNumber guards against, so it throws the same way.
 */
function capNumberOrNull(field: string, value: number | null): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BudgetError(
      'budgets.invalid-policy',
      `budgets.yml ${field} must be a finite number or null; got ${JSON.stringify(value)}. ${NO_CAP_AT_ALL}`,
      { field, value },
    );
  }
  return value;
}

/**
 * `epic.cap_tokens` for `tier`. A scalar is one cap for every tier (the shape
 * before 2026-09-29, still accepted); a mapping must name all three tiers —
 * a triplet missing one is refused whichever tier is being read, because the
 * missing tier's epics would otherwise fall to a default nobody chose, and so
 * is a key that names no tier (`hughe:`), which would leave its number unread.
 */
function epicCapFor(raw: unknown, tier: EffortTier): number {
  if (raw === undefined || raw === null) return DEFAULT_EPIC_CAP_TOKENS;
  if (typeof raw !== 'object' || Array.isArray(raw)) return capNumber('epic.cap_tokens', raw);
  const byTier = raw as Record<string, unknown>;
  const unknown = Object.keys(byTier).filter((key) => !isEffortTier(key));
  if (unknown.length > 0) {
    throw new BudgetError(
      'budgets.invalid-policy',
      `budgets.yml epic.cap_tokens names ${unknown.map((k) => `"${k}"`).join(', ')}, which ${unknown.length === 1 ? 'is not an effort tier' : 'are not effort tiers'}; the keys are ${EFFORT_TIERS.join(', ')}.`,
      { field: 'epic.cap_tokens', unknown, allowed: [...EFFORT_TIERS] },
    );
  }
  const caps = Object.fromEntries(
    EFFORT_TIERS.map((t) => [t, capNumber(`epic.cap_tokens.${t}`, byTier[t])]),
  ) as Record<EffortTier, number>;
  return caps[tier];
}

function tierScale(raw: RawBudgetsYaml['task_tier_scale'], tier: EffortTier): number {
  const scales = Object.fromEntries(
    EFFORT_TIERS.map((t) => [
      t,
      capNumber(`task_tier_scale.${t}`, raw?.[t] ?? DEFAULT_TASK_TIER_SCALE[t]),
    ]),
  ) as Record<EffortTier, number>;
  return scales[tier];
}

/**
 * budgets.yml sized for `tier` (plan `effort`; absent or unknown reads as
 * effort.yml's `default_tier`). Task caps are declared at medium and scaled by
 * `task_tier_scale`; the epic cap is read per tier as declared.
 */
export function parseBudgetPolicy(yamlText: string, tier?: unknown): BudgetPolicy {
  const resolved = resolveBudgetTier(tier);
  const doc = (parseYaml(yamlText) ?? {}) as RawBudgetsYaml;
  const scale = tierScale(doc.task_tier_scale, resolved);
  const scaled = (n: number): number => Math.round(n * scale);

  const legacyJudges =
    doc.task?.judges?.cap_tokens === undefined
      ? null
      : capNumber('task.judges.cap_tokens', doc.task.judges.cap_tokens);
  const medium = (role: PricedRole): number => {
    const declared = doc.task?.[role]?.cap_tokens;
    if (declared !== undefined) return capNumber(`task.${role}.cap_tokens`, declared);
    if (legacyJudges !== null && LEGACY_JUDGE_BUCKET_ROLES.includes(role)) return legacyJudges;
    return DEFAULT_TASK_CAP_TOKENS[role];
  };

  const task = Object.fromEntries(
    PRICED_ROLES.map((role) => [role, { capTokens: scaled(medium(role)) }]),
  ) as unknown as TaskBudgetPolicy;
  task.coder = {
    capTokens: task.coder.capTokens,
    capDiffLines: scaled(
      capNumber(
        'task.coder.cap_diff_lines',
        doc.task?.coder?.cap_diff_lines ?? DEFAULT_CODER_CAP_DIFF_LINES,
      ),
    ),
  };

  return {
    tier: resolved,
    epic: {
      capTokens: epicCapFor(doc.epic?.cap_tokens, resolved),
      alarmRatio: capNumber('epic.alarm_ratio', doc.epic?.alarm_ratio ?? DEFAULT_EPIC_ALARM_RATIO),
      maxInFlightTasks: capNumberOrNull(
        'epic.max_in_flight_tasks',
        doc.epic?.max_in_flight_tasks ?? null,
      ),
    },
    task,
    preCodeBudget: {
      shareOfEpicBudgetMax: capNumber(
        'pre_code_budget.share_of_epic_budget_max',
        doc.pre_code_budget?.share_of_epic_budget_max ?? DEFAULT_PRE_CODE_SHARE_MAX,
      ),
    },
    escalationLadder: parseEscalationLadder(doc.escalation_ladder?.rungs),
  };
}

/**
 * The declared per-dispatch cap for `role` in this policy's tier, or null when
 * budgets.yml prices no such role.
 */
export function roleCapTokens(policy: BudgetPolicy, role: string): number | null {
  return isPricedRole(role) ? policy.task[role].capTokens : null;
}

/**
 * The env names that may override a budgets.yml number on one box, and the
 * field each one replaces. budgets.yml stays the committed default; these are
 * how an operator raises or lowers a cap for their own machine (`.env`, which
 * the CLI loads at start, or an exported shell value, which beats it) without
 * editing a file every other clone reads.
 *
 * A per-box override, not a per-epic one: it applies to every epic run on
 * that box while it is set. Each name also has a `_SMALL` / `_MEDIUM` /
 * `_HUGE` variant that applies to epics of that tier only. Precedence, highest
 * first: the variant for the policy's tier; then the bare name, which applies
 * to every tier with no variant of its own set; then budgets.yml's number for
 * the tier.
 */
interface EnvField {
  name: string;
  kind: 'int' | 'ratio';
  read: (p: BudgetPolicy) => number | null;
  write: (p: BudgetPolicy, value: number) => void;
}

function envNameForRole(role: PricedRole): string {
  return `SMITH_TASK_${role.toUpperCase().replace(/-/g, '_')}_CAP_TOKENS`;
}

const ENV_FIELDS: readonly EnvField[] = [
  {
    name: 'SMITH_EPIC_CAP_TOKENS',
    kind: 'int',
    read: (p) => p.epic.capTokens,
    write: (p, v) => {
      p.epic.capTokens = v;
    },
  },
  {
    name: 'SMITH_EPIC_ALARM_RATIO',
    kind: 'ratio',
    read: (p) => p.epic.alarmRatio,
    write: (p, v) => {
      p.epic.alarmRatio = v;
    },
  },
  {
    name: 'SMITH_EPIC_MAX_IN_FLIGHT_TASKS',
    kind: 'int',
    read: (p) => p.epic.maxInFlightTasks,
    write: (p, v) => {
      p.epic.maxInFlightTasks = v;
    },
  },
  {
    name: envNameForRole('coder'),
    kind: 'int',
    read: (p) => p.task.coder.capTokens,
    write: (p, v) => {
      p.task.coder.capTokens = v;
    },
  },
  {
    name: 'SMITH_TASK_CODER_CAP_DIFF_LINES',
    kind: 'int',
    read: (p) => p.task.coder.capDiffLines,
    write: (p, v) => {
      p.task.coder.capDiffLines = v;
    },
  },
  ...PRICED_ROLES.filter((role) => role !== 'coder').map(
    (role): EnvField => ({
      name: envNameForRole(role),
      kind: 'int',
      read: (p) => p.task[role].capTokens,
      write: (p, v) => {
        p.task[role].capTokens = v;
      },
    }),
  ),
];

/**
 * The pre-2026-09-29 name for the four judges' shared cap. Still honoured —
 * below each judge's own name — so a `.env` copied from an older
 * `.env.example` keeps working; no longer listed there.
 */
const LEGACY_JUDGES_ENV = 'SMITH_TASK_JUDGES_CAP_TOKENS';

const TIER_SUFFIXES: readonly string[] = EFFORT_TIERS.map((t) => `_${t.toUpperCase()}`);

function tierSuffix(tier: EffortTier): string {
  return `_${tier.toUpperCase()}`;
}

/** The documented budget env names, each one bare (the tier variants aside). */
export const BUDGET_ENV_VARS: readonly string[] = Object.freeze(ENV_FIELDS.map((f) => f.name));

/** Names still read for compatibility but no longer documented. */
export const LEGACY_BUDGET_ENV_VARS: readonly string[] = Object.freeze([LEGACY_JUDGES_ENV]);

/** Every name the overlay reads: bare, legacy, and each one's tier variants. */
export const ALL_BUDGET_ENV_NAMES: readonly string[] = Object.freeze(
  [...BUDGET_ENV_VARS, ...LEGACY_BUDGET_ENV_VARS].flatMap((name) => [
    name,
    ...TIER_SUFFIXES.map((suffix) => `${name}${suffix}`),
  ]),
);

type Env = Readonly<Record<string, string | undefined>>;

function envValue(env: Env, name: string): string | null {
  const value = readEnv(env, name);
  return value === undefined || value === '' ? null : value;
}

/**
 * Strict on purpose, and stricter than the YAML: a `.env` line is typed by
 * hand, and `4M`, `4e6` or `4_000_000` read as something else by every parser
 * that accepts them. Digits only, no sign, no exponent, greater than zero.
 * The error names the variable and the value it was given, and nothing else.
 */
function envPositiveInt(name: string, raw: string): number {
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BudgetError(
      'budgets.invalid-env',
      `${name} must be a positive integer (digits only); got ${JSON.stringify(raw)}.`,
      { variable: name },
    );
  }
  return value;
}

function envRatio(name: string, raw: string): number {
  const value = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new BudgetError(
      'budgets.invalid-env',
      `${name} must be a decimal in (0, 1]; got ${JSON.stringify(raw)}.`,
      { variable: name },
    );
  }
  return value;
}

function parseEnv(name: string, kind: EnvField['kind'], raw: string): number {
  return kind === 'ratio' ? envRatio(name, raw) : envPositiveInt(name, raw);
}

/**
 * The name that supplies `field` for `tier`, or null: the tier variant, else
 * the bare name, else (for the four old bucket judges) the legacy name with
 * the same two-step precedence.
 */
function supplierFor(field: EnvField, tier: EffortTier, env: Env): string | null {
  const candidates = [`${field.name}${tierSuffix(tier)}`, field.name];
  const role = PRICED_ROLES.find((r) => envNameForRole(r) === field.name);
  if (role !== undefined && LEGACY_JUDGE_BUCKET_ROLES.includes(role)) {
    candidates.push(`${LEGACY_JUDGES_ENV}${tierSuffix(tier)}`, LEGACY_JUDGES_ENV);
  }
  return candidates.find((name) => envValue(env, name) !== null) ?? null;
}

/**
 * Every set name is validated — every tier's variant, not only this policy's
 * — before any is applied, so a bad value refuses the whole overlay rather
 * than half of it, and a typo in a tier not in play today is caught today.
 */
function validateBudgetEnv(env: Env): void {
  for (const field of ENV_FIELDS) {
    for (const name of [field.name, ...TIER_SUFFIXES.map((s) => `${field.name}${s}`)]) {
      const raw = envValue(env, name);
      if (raw !== null) parseEnv(name, field.kind, raw);
    }
  }
  for (const name of [LEGACY_JUDGES_ENV, ...TIER_SUFFIXES.map((s) => `${LEGACY_JUDGES_ENV}${s}`)]) {
    const raw = envValue(env, name);
    if (raw !== null) envPositiveInt(name, raw);
  }
}

/**
 * `policy` with every set budget env name applied on top, for the policy's
 * own tier. Pure: it reads only `env` and returns a new policy.
 */
export function applyBudgetEnv(policy: BudgetPolicy, env: Env): BudgetPolicy {
  validateBudgetEnv(env);
  const next = structuredClone(policy);
  for (const field of ENV_FIELDS) {
    const supplier = supplierFor(field, policy.tier, env);
    if (supplier === null) continue;
    field.write(next, parseEnv(supplier, field.kind, envValue(env, supplier) as string));
  }
  return next;
}

/**
 * The budget env names whose value actually changed a number of `base` (the
 * policy as budgets.yml has it, for its tier) — names only, never values — so
 * a report that prints an effective cap can say it did not come from
 * budgets.yml. Each is the name that won for that tier: a variant for another
 * tier supplies nothing here and is left out. A name set to the value
 * budgets.yml already holds overrode nothing and is left out too.
 */
export function budgetEnvOverrides(base: BudgetPolicy, env: Env = process.env): string[] {
  validateBudgetEnv(env);
  const names: string[] = [];
  for (const field of ENV_FIELDS) {
    const supplier = supplierFor(field, base.tier, env);
    if (supplier === null || names.includes(supplier)) continue;
    const value = parseEnv(supplier, field.kind, envValue(env, supplier) as string);
    if (value !== field.read(base)) names.push(supplier);
  }
  return names;
}

/**
 * budgets.yml for `tier`, with the box's env overrides on top. Every consumer
 * reads the policy through here, so an override reaches all of them or none.
 */
export function loadBudgetPolicy(
  filePath: string = BUDGETS_POLICY_PATH,
  env: Env = process.env,
  tier?: unknown,
): BudgetPolicy {
  return applyBudgetEnv(parseBudgetPolicy(readFileSync(filePath, 'utf8'), tier), env);
}

/** A task spec's `budget` block, in the plan's own snake_case shape. */
export interface TaskBudget {
  tokens: number;
  diff_lines: number;
  max_turns?: number;
}

/**
 * For each field a task budget may declare, the mechanism that reads it — or
 * `null` when nothing does.
 *
 * This registry exists so the answer is checkable rather than remembered.
 * D-29's finding was that all three fields looked enforced and none were; the
 * fix is not only to wire two of them up but to make the third's emptiness
 * visible, so plan validation can say "you wrote down a limit nobody can
 * apply" instead of the plan quietly implying otherwise.
 *
 * `max_turns` is null on purpose, and not because the wiring is pending: the
 * turn limit lives in the dispatch harness, which reads the role template's
 * `maxTurns` (`.claude/agents/bs-<role>.md`) — per role, never per task
 * (agent-interviews.md M-4, answered (c) on 2026-08-05 and corrected
 * 2026-09-11 once the cap was measured). A plan cannot raise or lower a
 * role's ceiling, so a number here would be a second copy the harness never
 * consults; the /bs dispatch contract restates the template's value instead.
 */
export const TASK_BUDGET_FIELD_READERS: Readonly<Record<keyof TaskBudget, string | null>> =
  Object.freeze({
    tokens: 'gate: compared against the result’s token_usage.total_tokens',
    diff_lines: 'gate: compared against the measured git diff (src/diffstat.ts)',
    max_turns: null,
  });

/**
 * Which of the fields this budget declares have no mechanical reader. Order
 * follows TASK_BUDGET_FIELD_READERS so the message is stable.
 */
export function unreadTaskBudgetFields(budget: TaskBudget): string[] {
  return (Object.keys(TASK_BUDGET_FIELD_READERS) as (keyof TaskBudget)[]).filter(
    (field) => budget[field] !== undefined && TASK_BUDGET_FIELD_READERS[field] === null,
  );
}

export interface BudgetOverrun {
  field: 'tokens' | 'diff_lines';
  cap: number;
  measured: number;
}

export interface TaskBudgetCheckInput {
  budget: TaskBudget;
  /** Total tokens the task actually spent, from the result's token_usage. */
  tokensUsed?: number;
  /** Authored lines changed, from src/diffstat.ts. */
  diffLines?: number;
}

/**
 * Declared budget vs. what the task actually spent.
 *
 * A field with no measurement is skipped rather than compared against zero: an
 * unmeasured budget and a budget that came in at nothing are different facts,
 * and only one of them is evidence of anything. Spend exactly at the cap is
 * within it — a cap of 400 permits 400.
 */
export function checkTaskBudget(input: TaskBudgetCheckInput): BudgetOverrun[] {
  const overruns: BudgetOverrun[] = [];
  const { budget, tokensUsed, diffLines } = input;

  if (tokensUsed !== undefined && tokensUsed > budget.tokens) {
    overruns.push({ field: 'tokens', cap: budget.tokens, measured: tokensUsed });
  }
  if (diffLines !== undefined && diffLines > budget.diff_lines) {
    overruns.push({ field: 'diff_lines', cap: budget.diff_lines, measured: diffLines });
  }
  return overruns;
}
