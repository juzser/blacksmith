/**
 * How much judgment an epic buys, cheapest first — factory/policies/effort.yml
 * declares what each tier means; this is only the closed list of names.
 *
 * A leaf module on purpose: plan.ts types `PlanFile.effort` with it, budgets.ts
 * sizes its caps by it, and effort.ts is the semantic owner. plan.ts imports
 * budgets.ts and effort.ts (transitively) imports plan.ts, so the list can live
 * in none of them without an import cycle. plan.ts and effort.ts re-export it.
 */
export const EFFORT_TIERS = ['small', 'medium', 'huge'] as const;

export type EffortTier = (typeof EFFORT_TIERS)[number];

export function isEffortTier(value: unknown): value is EffortTier {
  return typeof value === 'string' && (EFFORT_TIERS as readonly string[]).includes(value);
}
