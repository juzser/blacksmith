// Cost & quality across stores: rates and means are recomputed from summed
// numerators and denominators, never averaged, and keep the query's own answer
// at a zero denominator.
import { describe, expect, it } from 'vitest';
import type { AnalyticsResult } from '../../../factory/orchestrator/src/db/queries.js';
import { mergeAnalytics } from '../src/analyticsFanout.js';

const empty: AnalyticsResult = {
  throughput: [],
  costByModelTierAndProvider: [],
  sameMistakeRateByDay: [],
  recheckOutcomes: [],
  providerAgreement: [],
};
const part = (id: string, over: Partial<AnalyticsResult>) => ({
  store: { id, label: id },
  data: { ...empty, ...over },
});

describe('mergeAnalytics', () => {
  it('passes a single store through untouched', () => {
    const data = { ...empty, throughput: [{ day: '2026-10-02', completed: 3 }] };
    expect(mergeAnalytics([{ store: { id: 'home', label: 'a' }, data }])).toBe(data);
  });

  it('answers an empty merge with the period keys only when a period was asked', () => {
    const withPeriod = mergeAnalytics([], { period: true });
    expect(withPeriod.tokensByDay).toEqual([]);
    expect(withPeriod.tokensByRoleAndModelTier).toEqual([]);
    const without = mergeAnalytics([]);
    expect(without).not.toHaveProperty('tokensByDay');
    expect(without).not.toHaveProperty('tokensByRoleAndModelTier');
  });

  it('sums cost buckets by tier and provider and recomputes the mean over measured tasks', () => {
    const r = mergeAnalytics([
      part('home', {
        costByModelTierAndProvider: [
          {
            modelTier: 'mid',
            provider: 'claude',
            taskCount: 4,
            totalTokens: 300,
            avgTokensPerTask: 100,
            unmeasuredTaskCount: 1,
          },
          {
            modelTier: 'low',
            provider: 'claude',
            taskCount: 1,
            totalTokens: 0,
            avgTokensPerTask: 0,
            unmeasuredTaskCount: 1,
          },
        ],
      }),
      part('ab12cd34', {
        costByModelTierAndProvider: [
          {
            modelTier: 'mid',
            provider: 'claude',
            taskCount: 2,
            totalTokens: 100,
            avgTokensPerTask: 50,
            unmeasuredTaskCount: 0,
          },
          {
            modelTier: 'high',
            provider: 'codex',
            taskCount: 1,
            totalTokens: 10,
            avgTokensPerTask: 10,
            unmeasuredTaskCount: 0,
          },
        ],
      }),
    ]);
    expect(r.costByModelTierAndProvider).toEqual([
      {
        modelTier: 'mid',
        provider: 'claude',
        taskCount: 6,
        totalTokens: 400,
        avgTokensPerTask: 400 / 5,
        unmeasuredTaskCount: 1,
      },
      {
        modelTier: 'low',
        provider: 'claude',
        taskCount: 1,
        totalTokens: 0,
        avgTokensPerTask: 0,
        unmeasuredTaskCount: 1,
      },
      {
        modelTier: 'high',
        provider: 'codex',
        taskCount: 1,
        totalTokens: 10,
        avgTokensPerTask: 10,
        unmeasuredTaskCount: 0,
      },
    ]);
  });

  it('sums role and tier rows, null mean at zero measured runs, and keeps absent when no store has a period', () => {
    const row = (runCount: number, tokens: number, unmeasuredRunCount: number) => ({
      role: 'coder',
      modelTier: 'mid',
      runCount,
      tokens,
      avgTokensPerRun: null,
      unmeasuredRunCount,
    });
    const r = mergeAnalytics([
      part('home', { tokensByRoleAndModelTier: [row(2, 0, 2)] }),
      part('ab12cd34', { tokensByRoleAndModelTier: [row(3, 90, 1)] }),
    ]);
    expect(r.tokensByRoleAndModelTier).toEqual(
      [row(5, 90, 3)].map((x) => ({ ...x, avgTokensPerRun: 45 })),
    );
    const none = mergeAnalytics([
      part('home', { tokensByRoleAndModelTier: [row(2, 0, 2)] }),
      part('ab12cd34', { tokensByRoleAndModelTier: [] }),
    ]);
    expect(none.tokensByRoleAndModelTier?.[0]?.avgTokensPerRun).toBeNull();
    const bare = mergeAnalytics([part('home', {}), part('ab12cd34', {})]);
    expect(bare).not.toHaveProperty('tokensByDay');
    expect(bare).not.toHaveProperty('tokensByRoleAndModelTier');
  });

  it('recomputes the same-mistake rate per day, null at zero decisions, days oldest first', () => {
    const r = mergeAnalytics([
      part('home', {
        sameMistakeRateByDay: [
          { day: '2026-10-03', decisions: 4, sameMistake: 1, rate: 0.25 },
          { day: '2026-10-05', decisions: 0, sameMistake: 0, rate: null },
        ],
      }),
      part('ab12cd34', {
        sameMistakeRateByDay: [
          { day: '2026-10-01', decisions: 1, sameMistake: 1, rate: 1 },
          { day: '2026-10-03', decisions: 2, sameMistake: 1, rate: 0.5 },
          { day: '2026-10-05', decisions: 0, sameMistake: 0, rate: null },
        ],
      }),
    ]);
    expect(r.sameMistakeRateByDay).toEqual([
      { day: '2026-10-01', decisions: 1, sameMistake: 1, rate: 1 },
      { day: '2026-10-03', decisions: 6, sameMistake: 2, rate: 2 / 6 },
      { day: '2026-10-05', decisions: 0, sameMistake: 0, rate: null },
    ]);
  });

  it('sums throughput, recheck outcomes and daily tokens by key, with every role and tier key', () => {
    const day = (
      d: string,
      role: Record<string, number>,
      tier: Record<string, number>,
      u: number,
    ) => ({
      day: d,
      tokensByRole: role,
      tokensByModelTier: tier,
      unmeasuredRunCount: u,
    });
    const r = mergeAnalytics([
      part('home', {
        throughput: [{ day: '2026-10-02', completed: 1 }],
        recheckOutcomes: [{ taskStatus: 'completed', count: 2 }],
        tokensByDay: [day('2026-10-01', { coder: 5 }, { mid: 5 }, 1), day('2026-10-02', {}, {}, 0)],
      }),
      part('ab12cd34', {
        throughput: [
          { day: '2026-10-01', completed: 4 },
          { day: '2026-10-02', completed: 2 },
        ],
        recheckOutcomes: [
          { taskStatus: 'blocked', count: 1 },
          { taskStatus: 'completed', count: 1 },
        ],
        tokensByDay: [
          day('2026-10-01', { coder: 7, tester: 1 }, { mid: 7, low: 1 }, 2),
          day('2026-10-02', {}, {}, 0),
        ],
      }),
    ]);
    expect(r.throughput).toEqual([
      { day: '2026-10-01', completed: 4 },
      { day: '2026-10-02', completed: 3 },
    ]);
    expect(r.recheckOutcomes).toEqual([
      { taskStatus: 'blocked', count: 1 },
      { taskStatus: 'completed', count: 3 },
    ]);
    expect(r.tokensByDay).toEqual([
      day('2026-10-01', { coder: 12, tester: 1 }, { mid: 12, low: 1 }, 3),
      day('2026-10-02', {}, {}, 0),
    ]);
  });

  describe('provider agreement', () => {
    const stat = (over: Record<string, unknown>) => ({
      provider: 'codex',
      runs: 0,
      verdicts: 0,
      agreementRate: null,
      latencySamples: 0,
      meanLatencyMs: null,
      schemaFailureRate: 0,
      transportFailureRate: 0,
      failuresByCode: {},
      ...over,
    });

    it('recovers counts from rates and recomputes over the summed denominators', () => {
      const r = mergeAnalytics([
        part('home', {
          providerAgreement: [
            stat({
              runs: 10,
              verdicts: 3,
              agreementRate: 2 / 3,
              latencySamples: 4,
              meanLatencyMs: 100,
              schemaFailureRate: 0.1,
              transportFailureRate: 0.6,
              failuresByCode: { timeout: 6, bad_json: 1 },
            }),
          ],
        }),
        part('ab12cd34', {
          providerAgreement: [
            stat({
              runs: 5,
              verdicts: 5,
              agreementRate: 0.2,
              latencySamples: 1,
              meanLatencyMs: 400,
              schemaFailureRate: 0.2,
              failuresByCode: { bad_json: 1 },
            }),
            stat({
              provider: 'deepseek',
              runs: 2,
              transportFailureRate: 1,
              failuresByCode: { no_key: 2 },
            }),
          ],
        }),
      ]);
      expect(r.providerAgreement).toEqual([
        stat({
          runs: 15,
          verdicts: 8,
          agreementRate: 3 / 8,
          latencySamples: 5,
          meanLatencyMs: 160,
          schemaFailureRate: 2 / 15,
          transportFailureRate: 6 / 15,
          failuresByCode: { timeout: 6, bad_json: 2 },
        }),
        stat({
          provider: 'deepseek',
          runs: 2,
          transportFailureRate: 1,
          failuresByCode: { no_key: 2 },
        }),
      ]);
    });

    it('keeps null rates null and zero failure rates zero when nothing was observed', () => {
      const r = mergeAnalytics([
        part('home', { providerAgreement: [stat({ runs: 1 })] }),
        part('ab12cd34', { providerAgreement: [stat({ runs: 2 })] }),
      ]);
      expect(r.providerAgreement).toEqual([stat({ runs: 3 })]);
    });
  });
});
