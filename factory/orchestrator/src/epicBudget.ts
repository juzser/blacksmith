// budgets.yml sized for one epic's effort tier.
//
// budgets.ts cannot read a plan itself — plan.ts imports it — so the step
// from "an epic id seen in the event log" to "the policy for that epic's tier"
// lives here, one level up. A reader that already holds the plan passes
// `plan.effort` to loadBudgetPolicy directly and needs none of this.
import { type BudgetPolicy, loadBudgetPolicy } from './budgets.js';
import { BUDGETS_POLICY_PATH } from './paths.js';
import { latestPlanVersion, loadPlan, type PlanOpts } from './plan.js';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * An epic id is a directory name under the specs dir. One read out of the
 * event log is data, not a path: anything that is not a plain name is treated
 * as "no plan found" rather than joined onto a filesystem path.
 */
const PLAIN_EPIC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The `effort` of the epic's latest plan, or undefined when there is no plan
 * to read — a log from another project, an epic planned outside this specs
 * dir, an unreadable file. undefined sizes the budget at effort.yml's
 * `default_tier`, which is what every reader did before tiers existed.
 */
export function latestPlanEffort(epicId: string, planOpts: PlanOpts = {}): unknown {
  if (!PLAIN_EPIC_ID.test(epicId) || epicId.includes('..')) return undefined;
  try {
    const version = latestPlanVersion(epicId, planOpts);
    return version === null ? undefined : loadPlan(epicId, version, planOpts).effort;
  } catch {
    return undefined;
  }
}

export interface EpicBudgetOptions {
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
  const byTier = new Map<string, BudgetPolicy>();
  const byEpic = new Map<string, BudgetPolicy>();
  return (epicId) => {
    const cached = byEpic.get(epicId);
    if (cached !== undefined) return cached;
    const effort = latestPlanEffort(epicId, opts.planOpts);
    const key = typeof effort === 'string' ? effort : '';
    let policy = byTier.get(key);
    if (policy === undefined) {
      policy = loadBudgetPolicy(policyFile, env, effort);
      byTier.set(key, policy);
    }
    byEpic.set(epicId, policy);
    return policy;
  };
}
