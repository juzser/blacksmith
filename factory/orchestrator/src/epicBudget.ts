// budgets.yml sized for one epic's effort tier.
//
// budgets.ts cannot read a plan or effort.yml's resolution itself — plan.ts
// imports it, and effort.ts imports plan.ts — so the step from "a plan" or
// "an epic id seen in the event log" to "the policy for that epic's tier"
// lives here, one level up. Every budget reader that knows its plan goes
// through `budgetTierForPlan`: the tier a budget is sized for is the tier the
// epic RUNS at, after effort.yml's security floor, not the plan's raw ask.
import { type BudgetPolicy, loadBudgetPolicy, resolveBudgetTier } from './budgets.js';
import { loadCrosscheckPolicy, type PlanQuorumPolicy } from './crosscheck.js';
import { type EffortPolicy, loadEffortPolicy, resolveEffort } from './effort.js';
import { BUDGETS_POLICY_PATH } from './paths.js';
import {
  type EffortTier,
  isEffortTier,
  latestPlanVersion,
  loadPlan,
  type PlanFile,
  type PlanOpts,
} from './plan.js';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * An epic id is a directory name under the specs dir. One read out of the
 * event log is data, not a path: anything that is not a plain name is treated
 * as "no plan found" rather than joined onto a filesystem path.
 */
const PLAIN_EPIC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BudgetTierOptions {
  /** effort.yml; the shipped one when absent. */
  effortPolicyFile?: string;
  /** crosscheck.yml, read for its `plan_quorum` security triggers. */
  crosscheckPolicyFile?: string;
  /** Already-loaded security triggers, for a caller that holds crosscheck.yml. */
  securityPolicy?: PlanQuorumPolicy;
}

/**
 * The effort tier `plan` is budgeted at: effort.ts `resolveEffort(...).effective`,
 * so a `small` plan whose live tasks trip a crosscheck.yml security trigger is
 * budgeted at effort.yml's `security_floor`, exactly the tier it runs at.
 *
 * A budget reader must not fail a run over a policy it only consults: when
 * effort.yml or crosscheck.yml cannot be read, or the plan's tasks cannot be
 * walked, the tier falls back to the plan's own `effort`, else effort.yml's
 * `default_tier` (which budgets.ts refuses to guess when that is broken too).
 */
export function budgetTierForPlan(
  plan: PlanFile | null | undefined,
  opts: BudgetTierOptions = {},
): EffortTier {
  let effortPolicy: EffortPolicy;
  try {
    effortPolicy = loadEffortPolicy(opts.effortPolicyFile);
  } catch {
    return resolveBudgetTier(plan?.effort, opts.effortPolicyFile);
  }
  if (plan === null || plan === undefined) return effortPolicy.defaultTier;
  try {
    const securityPolicy =
      opts.securityPolicy ?? loadCrosscheckPolicy(opts.crosscheckPolicyFile).planQuorum;
    return resolveEffort(effortPolicy, securityPolicy, { plan }).effective;
  } catch {
    return isEffortTier(plan.effort) ? plan.effort : effortPolicy.defaultTier;
  }
}

export interface PlanBudgetOptions extends BudgetTierOptions {
  policyFile?: string;
  env?: Env;
}

/** budgets.yml sized for `plan`'s effective tier (see `budgetTierForPlan`). */
export function budgetPolicyForPlan(
  plan: PlanFile | null | undefined,
  opts: PlanBudgetOptions = {},
): BudgetPolicy {
  return loadBudgetPolicy(opts.policyFile, opts.env ?? process.env, budgetTierForPlan(plan, opts));
}

/**
 * The epic's latest plan, or undefined when there is no plan to read — a log
 * from another project, an epic planned outside this specs dir, an unreadable
 * file. undefined sizes the budget at effort.yml's `default_tier`, which is
 * what every reader did before tiers existed.
 */
export function latestPlan(epicId: string, planOpts: PlanOpts = {}): PlanFile | undefined {
  if (!PLAIN_EPIC_ID.test(epicId) || epicId.includes('..')) return undefined;
  try {
    const version = latestPlanVersion(epicId, planOpts);
    return version === null ? undefined : loadPlan(epicId, version, planOpts);
  } catch {
    return undefined;
  }
}

export interface EpicBudgetOptions extends BudgetTierOptions {
  policyFile?: string;
  env?: Env;
  planOpts?: PlanOpts;
}

/**
 * A lookup from epic id to that epic's budget policy, each tier loaded once.
 * Env overrides apply per tier (`<NAME>_<TIER>` before `<NAME>`), so two
 * epics of different tiers can be judged against different caps in one
 * report.
 */
export function epicBudgetPolicies(opts: EpicBudgetOptions = {}): (epicId: string) => BudgetPolicy {
  const policyFile = opts.policyFile ?? BUDGETS_POLICY_PATH;
  const env = opts.env ?? process.env;
  const byTier = new Map<EffortTier, BudgetPolicy>();
  const byEpic = new Map<string, BudgetPolicy>();
  return (epicId) => {
    const cached = byEpic.get(epicId);
    if (cached !== undefined) return cached;
    const tier = budgetTierForPlan(latestPlan(epicId, opts.planOpts), opts);
    let policy = byTier.get(tier);
    if (policy === undefined) {
      policy = loadBudgetPolicy(policyFile, env, tier);
      byTier.set(tier, policy);
    }
    byEpic.set(epicId, policy);
    return policy;
  };
}
