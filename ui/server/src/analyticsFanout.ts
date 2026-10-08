/**
 * Cost & quality across stores: the per-store `analytics()` results combined in
 * TypeScript. A rate or a mean is never averaged: it is recomputed from the
 * summed numerator and denominator, and keeps the query's own answer at a zero
 * denominator (`null`, or 0 where the query says 0). A row's numerator is
 * recovered from its rate and denominator (both are counts over that
 * denominator, so `Math.round` returns the integer).
 */

import type {
  AnalyticsResult,
  CostBucket,
  DailyTokenBucket,
  ProviderAgreementStat,
  RoleModelTierBucket,
} from '../../../factory/orchestrator/dist/db/queries.js';
import type { StoreRef } from './stores.js';

const byKey = <T>(rows: T[][], key: (r: T) => string, fold: (into: T | undefined, r: T) => T) => {
  const out = new Map<string, T>();
  for (const list of rows) for (const r of list) out.set(key(r), fold(out.get(key(r)), r));
  return out;
};
const byString = (a: string, b: string) => a.localeCompare(b);
const sorted = <T>(m: Map<string, T>): T[] =>
  [...m.entries()].sort(([a], [b]) => byString(a, b)).map(([, v]) => v);
const addTo = (into: Record<string, number>, from: Record<string, number>) => {
  const out = { ...into };
  for (const [k, n] of Object.entries(from)) out[k] = (out[k] ?? 0) + n;
  return out;
};

const mergeProvider = (rows: ProviderAgreementStat[][]): ProviderAgreementStat[] => {
  const acc = new Map<
    string,
    {
      provider: string;
      runs: number;
      verdicts: number;
      agreements: number;
      latencySamples: number;
      latencySum: number;
      schema: number;
      transport: number;
      failuresByCode: Record<string, number>;
    }
  >();
  for (const r of rows.flat()) {
    const a = acc.get(r.provider) ?? {
      provider: r.provider,
      runs: 0,
      verdicts: 0,
      agreements: 0,
      latencySamples: 0,
      latencySum: 0,
      schema: 0,
      transport: 0,
      failuresByCode: {},
    };
    a.runs += r.runs;
    a.verdicts += r.verdicts;
    a.agreements += Math.round((r.agreementRate ?? 0) * r.verdicts);
    a.latencySamples += r.latencySamples;
    a.latencySum += (r.meanLatencyMs ?? 0) * r.latencySamples;
    a.schema += Math.round(r.schemaFailureRate * r.runs);
    a.transport += Math.round(r.transportFailureRate * r.runs);
    a.failuresByCode = addTo(a.failuresByCode, r.failuresByCode);
    acc.set(r.provider, a);
  }
  return sorted(acc).map((a) => ({
    provider: a.provider,
    runs: a.runs,
    verdicts: a.verdicts,
    agreementRate: a.verdicts > 0 ? a.agreements / a.verdicts : null,
    latencySamples: a.latencySamples,
    meanLatencyMs: a.latencySamples > 0 ? a.latencySum / a.latencySamples : null,
    schemaFailureRate: a.runs > 0 ? a.schema / a.runs : 0,
    transportFailureRate: a.runs > 0 ? a.transport / a.runs : 0,
    failuresByCode: a.failuresByCode,
  }));
};

/** One store's result passes through untouched; several are summed key by key. */
export function mergeAnalytics(
  parts: { store: StoreRef; data: AnalyticsResult }[],
): AnalyticsResult {
  if (parts.length === 1) return (parts[0] as (typeof parts)[number]).data;
  const all = parts.map((p) => p.data);
  const key2 = (a: string, b: string) => `${a}\u0000${b}`;

  const cost = byKey<CostBucket>(
    all.map((d) => d.costByModelTierAndProvider),
    (r) => key2(r.modelTier, r.provider),
    (into, r) => ({
      ...r,
      taskCount: (into?.taskCount ?? 0) + r.taskCount,
      totalTokens: (into?.totalTokens ?? 0) + r.totalTokens,
      unmeasuredTaskCount: (into?.unmeasuredTaskCount ?? 0) + r.unmeasuredTaskCount,
    }),
  );
  const costRows = [...cost.values()].map((r) => {
    const measured = r.taskCount - r.unmeasuredTaskCount;
    return { ...r, avgTokensPerTask: measured > 0 ? r.totalTokens / measured : 0 };
  });

  const mistakes = byKey(
    all.map((d) => d.sameMistakeRateByDay),
    (r) => r.day,
    (into, r) => ({
      ...r,
      decisions: (into?.decisions ?? 0) + r.decisions,
      sameMistake: (into?.sameMistake ?? 0) + r.sameMistake,
    }),
  );
  const throughput = byKey(
    all.map((d) => d.throughput),
    (r) => r.day,
    (into, r) => ({ day: r.day, completed: (into?.completed ?? 0) + r.completed }),
  );
  const rechecks = byKey(
    all.map((d) => d.recheckOutcomes),
    (r) => r.taskStatus,
    (into, r) => ({ taskStatus: r.taskStatus, count: (into?.count ?? 0) + r.count }),
  );

  const withDays = all.some((d) => d.tokensByDay !== undefined);
  const withRoles = all.some((d) => d.tokensByRoleAndModelTier !== undefined);
  const days = byKey<DailyTokenBucket>(
    all.map((d) => d.tokensByDay ?? []),
    (r) => r.day,
    (into, r) => ({
      day: r.day,
      tokensByRole: addTo(into?.tokensByRole ?? {}, r.tokensByRole),
      tokensByModelTier: addTo(into?.tokensByModelTier ?? {}, r.tokensByModelTier),
      unmeasuredRunCount: (into?.unmeasuredRunCount ?? 0) + r.unmeasuredRunCount,
    }),
  );
  const roleTier = byKey<RoleModelTierBucket>(
    all.map((d) => d.tokensByRoleAndModelTier ?? []),
    (r) => key2(r.role, r.modelTier),
    (into, r) => ({
      ...r,
      runCount: (into?.runCount ?? 0) + r.runCount,
      tokens: (into?.tokens ?? 0) + r.tokens,
      unmeasuredRunCount: (into?.unmeasuredRunCount ?? 0) + r.unmeasuredRunCount,
    }),
  );

  return {
    throughput: sorted(throughput),
    costByModelTierAndProvider: costRows,
    sameMistakeRateByDay: sorted(mistakes).map((r) => ({
      ...r,
      rate: r.decisions > 0 ? r.sameMistake / r.decisions : null,
    })),
    recheckOutcomes: sorted(rechecks),
    providerAgreement: mergeProvider(all.map((d) => d.providerAgreement)),
    ...(withDays ? { tokensByDay: sorted(days) } : {}),
    ...(withRoles
      ? {
          tokensByRoleAndModelTier: [...roleTier.values()].map((r) => {
            const measured = r.runCount - r.unmeasuredRunCount;
            return { ...r, avgTokensPerRun: measured > 0 ? r.tokens / measured : null };
          }),
        }
      : {}),
  };
}
