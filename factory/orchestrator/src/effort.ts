import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { PlanQuorumPolicy } from './crosscheck.js';
import { SmithError } from './errors.js';
import { EFFORT_POLICY_PATH } from './paths.js';
import { EFFORT_TIERS, type EffortTier, isEffortTier, type PlanFile } from './plan.js';
import { evaluatePlanSecurityTriggers, type PlanQuorumSecurityTrigger } from './planQuorum.js';

/**
 * How much judgment an epic buys — factory/policies/effort.yml's host.
 *
 * An internal tool and a payments rewrite were running the same sixteen-step
 * loop, because the loop was the only one there was. Making a small epic cheap
 * meant skipping steps by hand and remembering which ones, which is the
 * "recall, do not ask" failure sensitive-paths.yml and crosscheck.yml were
 * each written to end. This module ends it for step count: the tiers are
 * declared in the policy file, the plan file names one, and
 * `smith effort show` answers so `.claude/skills/bs/SKILL.md` never has to
 * decide twice.
 *
 * Two invariants make the feature safe to ship:
 *
 * 1. **`huge` is today's flow, unchanged.** Nothing about black-smith's own
 *    behaviour moves until an epic is assigned a lower tier — effort.test.ts
 *    pins every `huge` knob to what SKILL.md already writes, so a future tune
 *    of `huge` has to be a deliberate edit to a red test rather than a quiet
 *    regression for every epic that never asked for a tier.
 * 2. **A tier scales judgment steps only.** Never a mechanical oracle, never a
 *    guardrail: gates, coverage, claim disjointness, worktree isolation, the
 *    security-reviewer's own dispatch triggers, operator sign-off, and the
 *    event log run identically at every tier. The policy file's `invariants:`
 *    list says so in prose and `resolveEffort` returns it verbatim beside
 *    every profile, so a caller reading the cheap answer reads the limit of it
 *    in the same breath. A `small` tier that skipped tests would not be cheap,
 *    it would be unverified.
 *
 * The tier is per EPIC, not per project (the operator's call): it is chosen at
 * `/bs plan` time and stored on the plan file, so one project runs a `small`
 * epic and a `huge` one without re-configuring anything.
 */
export class EffortError extends SmithError {}

/**
 * The tier names, ordered cheapest-first — the index is the rank the security
 * floor compares on. Declared in plan.ts (beside the `PlanFile.effort` field
 * that carries them, so `validatePlan` can check one without importing this
 * module) and re-exported here, which is where callers should read it from:
 * this file is what gives the names meaning.
 */
export { EFFORT_TIERS, type EffortTier, isEffortTier } from './plan.js';

/** Cheapest = 0. Only ever compared, never persisted — the names are the contract. */
function tierRank(tier: EffortTier): number {
  return EFFORT_TIERS.indexOf(tier);
}

const PRE_CODE_RESEARCH = ['when-needed', 'never'] as const;
const PRE_CODE_UIUX = ['always', 'when-ui-criterion', 'never'] as const;
const SPEC_REVIEW_ROUNDS = ['until-clean', 'single-pass'] as const;
const PLAN_QUORUM = ['always', 'when-triggered'] as const;
const CLOSING_SPEC_REVIEW = ['always', 'when-plan-amended'] as const;

/**
 * One tier's answer for every judgment step the flow can scale. Each field
 * names a step in `.claude/skills/bs/SKILL.md`; the doc comments there and the
 * policy file's inline comments are the same statement, deliberately.
 */
export interface EffortProfile {
  summary: string;
  /** `/bs run` step 3 — dispatch `researcher` for a pre-code unknown. */
  preCodeResearch: (typeof PRE_CODE_RESEARCH)[number];
  /** `/bs run` step 3 — dispatch `uiux` for a UI-affecting acceptance criterion. */
  preCodeUiux: (typeof PRE_CODE_UIUX)[number];
  /** `/bs plan` steps 3-4 — planner <-> spec-reviewer loop depth. */
  specReviewRounds: (typeof SPEC_REVIEW_ROUNDS)[number];
  /** `/bs plan` step 4 — whether `smith plan quorum` runs unconditionally. */
  planQuorum: (typeof PLAN_QUORUM)[number];
  /** `/bs run` step 6 — the grader's bounded rubric loop; never above 2. */
  graderRounds: number;
  /** `/bs run` step 7 — reviewer findings that get the adversarial verifier pass. */
  verifierSeverities: string[];
  /** ...plus this sampled share of S3-minor findings. 0 drops the sample. */
  verifierS3SpotCheckRatio: number;
  /** `/bs run` step 13 — the closing spec-review against the assembled branch. */
  closingSpecReview: (typeof CLOSING_SPEC_REVIEW)[number];
}

export interface EffortPolicy {
  version: number;
  /** The tier an epic gets when its plan file names none. */
  defaultTier: EffortTier;
  /** The lowest tier a security-sensitive plan may run at. */
  securityFloor: EffortTier;
  tiers: Record<EffortTier, EffortProfile>;
  /** What no tier may touch, returned beside every resolution. */
  invariants: string[];
}

// --- parsing ---------------------------------------------------------------
// Every reader below rejects rather than defaults. A policy file that half
// parses is worse than one that fails: the missing half becomes an unstated
// tier assignment, which is exactly the thing this module exists to end.

function requireNode(node: unknown, what: string): Record<string, unknown> {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw new EffortError('effort.policy-invalid', `effort.yml: ${what} must be a mapping.`);
  }
  return node as Record<string, unknown>;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new EffortError(
      'effort.policy-invalid',
      `effort.yml: ${where} is ${JSON.stringify(value)}; allowed: ${allowed.join(', ')}.`,
      { where, value, allowed: [...allowed] },
    );
  }
  return value as T;
}

function requireNumber(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new EffortError(
      'effort.policy-invalid',
      `effort.yml: ${where} is ${JSON.stringify(value)}; expected a number in [${min}, ${max}].`,
      { where, value },
    );
  }
  return value;
}

function requireStringList(value: unknown, where: string, minLength: number): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw new EffortError(
      'effort.policy-invalid',
      `effort.yml: ${where} must be a list of non-empty strings.`,
      { where },
    );
  }
  if (value.length < minLength) {
    throw new EffortError(
      'effort.policy-invalid',
      `effort.yml: ${where} needs at least ${minLength} entr${minLength === 1 ? 'y' : 'ies'}.`,
      { where },
    );
  }
  return value.map(String);
}

function parseProfile(node: unknown, tier: EffortTier): EffortProfile {
  const t = requireNode(node, `tiers.${tier}`);
  const summary = typeof t.summary === 'string' ? t.summary.trim() : '';
  const graderRounds = requireNumber(t.grader_rounds, `tiers.${tier}.grader_rounds`, 1, 2);
  if (!Number.isInteger(graderRounds)) {
    throw new EffortError(
      'effort.policy-invalid',
      `effort.yml: tiers.${tier}.grader_rounds must be a whole number of rounds.`,
    );
  }
  const verifierSeverities = requireStringList(
    t.verifier_severities,
    `tiers.${tier}.verifier_severities`,
    1,
  );
  // S1 is not a tier's to drop: a stop-the-line finding reaching the coder
  // unrefuted is the round trip the adversarial pass exists to prevent, and it
  // costs the same at every scale.
  if (!verifierSeverities.includes('S1-stop-the-line')) {
    throw new EffortError(
      'effort.policy-invalid',
      `effort.yml: tiers.${tier}.verifier_severities must keep "S1-stop-the-line" — no tier may leave a stop-the-line finding unverified.`,
      { tier },
    );
  }
  return {
    summary,
    preCodeResearch: requireEnum(
      t.pre_code_research,
      PRE_CODE_RESEARCH,
      `tiers.${tier}.pre_code_research`,
    ),
    preCodeUiux: requireEnum(t.pre_code_uiux, PRE_CODE_UIUX, `tiers.${tier}.pre_code_uiux`),
    specReviewRounds: requireEnum(
      t.spec_review_rounds,
      SPEC_REVIEW_ROUNDS,
      `tiers.${tier}.spec_review_rounds`,
    ),
    planQuorum: requireEnum(t.plan_quorum, PLAN_QUORUM, `tiers.${tier}.plan_quorum`),
    graderRounds,
    verifierSeverities,
    verifierS3SpotCheckRatio: requireNumber(
      t.verifier_s3_spot_check_ratio,
      `tiers.${tier}.verifier_s3_spot_check_ratio`,
      0,
      1,
    ),
    closingSpecReview: requireEnum(
      t.closing_spec_review,
      CLOSING_SPEC_REVIEW,
      `tiers.${tier}.closing_spec_review`,
    ),
  };
}

export function parseEffortPolicy(yamlText: string): EffortPolicy {
  const doc = requireNode(parseYaml(yamlText), 'the document');
  const tiersNode = requireNode(doc.tiers, 'tiers');

  // Presence of the whole table first, then each profile: an operator who
  // deleted two tiers should be told that, not handed the first missing knob
  // of the one tier they kept.
  const missing = EFFORT_TIERS.filter((tier) => !(tier in tiersNode));
  if (missing.length > 0) {
    throw new EffortError(
      'effort.policy-invalid',
      `effort.yml: tiers is missing ${missing.map((t) => `"${t}"`).join(', ')}. All of ${EFFORT_TIERS.join(', ')} must be declared — a missing tier is a silent default.`,
      { missing },
    );
  }

  const tiers = {} as Record<EffortTier, EffortProfile>;
  for (const tier of EFFORT_TIERS) {
    tiers[tier] = parseProfile(tiersNode[tier], tier);
  }

  return {
    version: typeof doc.version === 'number' ? doc.version : 1,
    defaultTier: requireEnum(doc.default_tier, EFFORT_TIERS, 'default_tier'),
    securityFloor: requireEnum(doc.security_floor, EFFORT_TIERS, 'security_floor'),
    tiers,
    invariants: requireStringList(doc.invariants, 'invariants', 1),
  };
}

export function loadEffortPolicy(filePath: string = EFFORT_POLICY_PATH): EffortPolicy {
  return parseEffortPolicy(readFileSync(filePath, 'utf8'));
}

// --- resolution ------------------------------------------------------------

export interface EffortResolution {
  /** The tier that was asked for, from whichever source `requestedFrom` names. */
  requested: EffortTier | null;
  /**
   * Where `requested` came from. `'default'` (with `requested: null`) means
   * nobody chose — the policy default is in `defaultTier`.
   */
  requestedFrom: 'flag' | 'plan' | 'default';
  /** The tier used when nobody asked for one. */
  defaultTier: EffortTier;
  /** What the epic actually runs at, after the security floor. */
  effective: EffortTier;
  /** True when the floor raised `effective` above what was asked for. */
  floorApplied: boolean;
  securityFloor: EffortTier;
  /**
   * Whether the floor was *checked at all*. False when no plan was supplied
   * (`/bs plan` asks this before a plan file exists), and then an empty
   * `securityTriggers` means "not looked at", not "looked at and clean" —
   * a distinction this codebase draws everywhere else too (`smith epic
   * spec-review` runs on a clean review precisely so the verdict can tell
   * "ran and found nothing" from "never ran").
   */
  securityFloorEvaluated: boolean;
  /**
   * Every security trigger the plan's live tasks fired — reported whether or
   * not the floor changed anything, because "we checked and this epic is
   * security-sensitive" is worth surfacing even at `huge`.
   */
  securityTriggers: PlanQuorumSecurityTrigger[];
  /** One sentence naming why `effective` is what it is. */
  reason: string;
  profile: EffortProfile;
  /** effort.yml's `invariants:`, verbatim — what no tier may touch. */
  invariants: string[];
}

export interface EffortResolveOpts {
  /**
   * The plan whose live tasks decide the security floor. Absent means the
   * floor is not evaluated, not that it did not fire.
   */
  plan?: PlanFile;
  /**
   * A tier asked for outside the plan file, and the winner when both are
   * present. `/bs plan` needs this: the tier is chosen several steps before
   * the plan file that will carry it exists, so the planner has to be able to
   * ask what a tier costs before committing to it.
   */
  override?: string;
}

/**
 * Pure, no I/O: decide which tier an epic runs at and hand back the profile
 * plus the evidence for the decision.
 *
 * The floor only ever raises. An operator who asks for `huge` on a
 * security-sensitive epic gets `huge`; one who asks for `small` gets the
 * floor, and `floorApplied` says so rather than leaving them to notice their
 * request was overridden by comparing two tables. Security sensitivity is read
 * from the plan's LIVE tasks (D-113/D-185), never `plan.tasks`: a superseded
 * task is history, and an epic must not be held at a higher tier by an ask it
 * has already withdrawn.
 */
export function resolveEffort(
  policy: EffortPolicy,
  securityPolicy: PlanQuorumPolicy,
  opts: EffortResolveOpts = {},
): EffortResolution {
  // A typo'd --effort must not degrade into the default: that is the same
  // silence validatePlan rejects a typo'd plan field for.
  if (opts.override !== undefined && !isEffortTier(opts.override)) {
    throw new EffortError(
      'effort.unknown-tier',
      `Effort tier "${opts.override}" is not one of ${EFFORT_TIERS.join(', ')} (factory/policies/effort.yml).`,
      { tier: opts.override, allowed: [...EFFORT_TIERS] },
    );
  }

  const fromPlan = isEffortTier(opts.plan?.effort) ? opts.plan.effort : null;
  const requested: EffortTier | null = opts.override ?? fromPlan;
  const requestedFrom: EffortResolution['requestedFrom'] =
    opts.override !== undefined ? 'flag' : fromPlan !== null ? 'plan' : 'default';
  const base = requested ?? policy.defaultTier;

  const securityFloorEvaluated = opts.plan !== undefined;
  const securityTriggers = opts.plan ? evaluatePlanSecurityTriggers(opts.plan, securityPolicy) : [];

  const floorApplied =
    securityTriggers.length > 0 && tierRank(base) < tierRank(policy.securityFloor);
  const effective = floorApplied ? policy.securityFloor : base;

  return {
    requested,
    requestedFrom,
    defaultTier: policy.defaultTier,
    effective,
    floorApplied,
    securityFloor: policy.securityFloor,
    securityFloorEvaluated,
    securityTriggers,
    reason: explain({
      base,
      effective,
      floorApplied,
      requestedFrom,
      securityFloor: policy.securityFloor,
      securityFloorEvaluated,
      triggerCount: securityTriggers.length,
    }),
    profile: policy.tiers[effective],
    invariants: policy.invariants,
  };
}

function explain(facts: {
  base: EffortTier;
  effective: EffortTier;
  floorApplied: boolean;
  requestedFrom: EffortResolution['requestedFrom'];
  securityFloor: EffortTier;
  securityFloorEvaluated: boolean;
  triggerCount: number;
}): string {
  const source =
    facts.requestedFrom === 'default'
      ? `nobody named a tier, so the policy default "${facts.base}" applies`
      : `the ${facts.requestedFrom} asked for "${facts.base}"`;

  if (!facts.securityFloorEvaluated) {
    return `${source}; the security floor was not evaluated — no plan was supplied, so this is the tier's profile and not a decision about a specific epic.`;
  }
  if (facts.floorApplied) {
    return `${source}; raised to "${facts.effective}" by the security floor — ${facts.triggerCount} security trigger(s) fired on this plan's live tasks (crosscheck.yml plan_quorum).`;
  }
  if (facts.triggerCount === 0) {
    return `${source}; no security trigger fired on this plan's live tasks, so the floor changed nothing.`;
  }
  return `${source}; ${facts.triggerCount} security trigger(s) fired, but "${facts.base}" is already at or above the "${facts.securityFloor}" floor.`;
}
