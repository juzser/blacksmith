import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  costPerTask,
  costPerTaskBy,
  formatRate,
  formatTokens,
  latestSameMistakeRate,
  quorumRows,
  recheckPassRate,
} from '../src/lib/analytics.js';
import type { CostBucket, ProviderAgreementStat } from '../src/lib/api.js';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'AnalyticsPage.vue'),
  'utf8',
);

describe('lib/analytics.ts — latestSameMistakeRate', () => {
  it('reads the rate of the most recent day', () => {
    expect(
      latestSameMistakeRate([
        { day: '2026-08-19', decisions: 4, sameMistake: 1, rate: 0.25 },
        { day: '2026-08-20', decisions: 2, sameMistake: 1, rate: 0.5 },
      ]),
    ).toBe(0.5);
  });

  it('returns null on a day that decided nothing, rather than 0', () => {
    // queries.ts's SameMistakeDay.rate docblock: a day with gate intakes but no
    // decisions has no denominator, so it has no rate (D-31, silence is not
    // assent). Rendering it as 0 claims a perfect day.
    expect(
      latestSameMistakeRate([
        { day: '2026-08-19', decisions: 4, sameMistake: 1, rate: 0.25 },
        { day: '2026-08-20', decisions: 0, sameMistake: 0, rate: null },
      ]),
    ).toBeNull();
  });

  it('returns null for an empty series', () => {
    expect(latestSameMistakeRate([])).toBeNull();
  });
});

describe('lib/analytics.ts — recheckPassRate', () => {
  it('counts a waived recheck as a pass, not only a completed one', () => {
    // queries.ts's MILESTONE_COMPLETE_TASK_STATUSES and epic.ts's
    // TERMINAL_OK_TASK_STATUSES both declare {completed, waived} as the pair
    // that means the work landed.
    const r = recheckPassRate([
      { taskStatus: 'completed', count: 2 },
      { taskStatus: 'waived', count: 1 },
      { taskStatus: 'failed', count: 1 },
    ]);
    expect(r.passed).toBe(3);
    expect(r.settled).toBe(4);
    expect(r.rate).toBe(0.75);
  });

  it('divides by settled rechecks only — in-flight ones are not yet a verdict', () => {
    const r = recheckPassRate([
      { taskStatus: 'completed', count: 3 },
      { taskStatus: 'failed', count: 1 },
      { taskStatus: 'in-progress', count: 10 },
      { taskStatus: 'blocked', count: 5 },
      { taskStatus: 'escalated', count: 2 },
      { taskStatus: 'superseded', count: 4 },
    ]);
    expect(r.settled).toBe(4);
    expect(r.rate).toBe(0.75);
  });

  it('returns a null rate when nothing has settled', () => {
    expect(recheckPassRate([{ taskStatus: 'in-progress', count: 3 }]).rate).toBeNull();
    expect(recheckPassRate([]).rate).toBeNull();
  });

  it('treats an unknown status as in-flight rather than as a verdict', () => {
    const r = recheckPassRate([
      { taskStatus: 'completed', count: 1 },
      { taskStatus: 'not-a-real-status', count: 9 },
    ]);
    expect(r.settled).toBe(1);
    expect(r.rate).toBe(1);
  });
});

function bucket(
  modelTier: string,
  provider: string,
  taskCount: number,
  totalTokens: number,
): CostBucket {
  return {
    modelTier,
    provider,
    taskCount,
    totalTokens,
    avgTokensPerTask: taskCount > 0 ? totalTokens / taskCount : 0,
  };
}

describe('lib/analytics.ts — costPerTaskBy', () => {
  /**
   * D-221. queries.ts buckets cost by the (model_tier, provider) PAIR, so a
   * tier that ran on two providers is two rows. The page used to map those
   * rows straight onto bars labelled with the tier alone, which put two bars
   * called "mid" side by side under a card titled "Cost per task by model
   * tier" — neither of them the tier's cost per task, and nothing on the
   * chart saying which provider either belonged to.
   */
  it('collapses one tier spread across providers into a single bar', () => {
    const series = costPerTaskBy(
      [bucket('mid', 'claude', 1, 2000), bucket('mid', 'codex', 3, 6000)],
      'modelTier',
    );
    expect(series).toEqual([{ label: 'mid', value: 2000 }]);
  });

  /**
   * 8000 tokens over 4 tasks is 2000 a task. Averaging the buckets' own
   * averages instead (2000 and 2000 -> 2000 here, but 2000 and 6000 -> 4000
   * below) lets a provider that ran one task outvote one that ran forty.
   */
  it('weights by task count rather than averaging the buckets’ averages', () => {
    const series = costPerTaskBy(
      [bucket('mid', 'claude', 1, 6000), bucket('mid', 'codex', 39, 39000)],
      'modelTier',
    );
    // Mean of the two bucket averages would be (6000 + 1000) / 2 = 3500.
    expect(series).toEqual([{ label: 'mid', value: 1125 }]);
  });

  /**
   * The sibling card is titled "Cost per task by provider" in
   * design-spec.md §5.8 too, and the StatCard above both of them reads
   * "Cost per task". It used to plot each provider's total token spend, so
   * the busier provider always looked the more expensive one and the two
   * cards sat side by side in different units.
   */
  it('reports tokens per task by provider, not the provider’s total spend', () => {
    const series = costPerTaskBy(
      [bucket('mid', 'claude', 2, 4000), bucket('small', 'claude', 2, 1000)],
      'provider',
    );
    expect(series).toEqual([{ label: 'claude', value: 1250 }]);
  });

  it('keeps every label distinct — BarChart keys its v-for on the label', () => {
    const series = costPerTaskBy(
      [
        bucket('mid', 'claude', 1, 1000),
        bucket('mid', 'codex', 1, 2000),
        bucket('small', 'claude', 1, 3000),
        bucket('small', 'codex', 1, 4000),
      ],
      'modelTier',
    );
    expect(series.map((s) => s.label)).toEqual(['mid', 'small']);
    expect(new Set(series.map((s) => s.label)).size).toBe(series.length);
  });

  it('renders bars in first-seen order so a poll cannot reshuffle the chart', () => {
    const series = costPerTaskBy(
      [bucket('small', 'codex', 1, 1000), bucket('mid', 'claude', 1, 2000)],
      'modelTier',
    );
    expect(series.map((s) => s.label)).toEqual(['small', 'mid']);
  });

  it('reports zero rather than NaN for a group that recorded no tasks', () => {
    expect(costPerTaskBy([bucket('mid', 'claude', 0, 0)], 'modelTier')).toEqual([
      { label: 'mid', value: 0 },
    ]);
  });

  it('returns nothing for no buckets', () => {
    expect(costPerTaskBy([], 'modelTier')).toEqual([]);
    expect(costPerTaskBy([], 'provider')).toEqual([]);
  });
});

describe('lib/analytics.ts — costPerTask', () => {
  it('divides total tokens by total tasks across every bucket', () => {
    expect(costPerTask([bucket('mid', 'claude', 1, 2000), bucket('small', 'codex', 3, 6000)])).toBe(
      2000,
    );
  });

  /**
   * D-219 fixed exactly this on the recheck card next door: a card labelled
   * with a cost must not print `0 tok` for a factory that has reported no
   * usage, because that is a claim ("we spent nothing") rather than a blank.
   */
  it('returns null when no task has reported usage, rather than zero', () => {
    expect(costPerTask([])).toBeNull();
    expect(costPerTask([bucket('mid', 'claude', 0, 0)])).toBeNull();
  });
});

describe('lib/analytics.ts — formatTokens', () => {
  it('renders an em dash for a cost nobody measured', () => {
    expect(formatTokens(null)).toBe('—');
  });

  it('renders a measured cost with its unit', () => {
    expect(formatTokens(0)).toBe('0 tok');
    expect(formatTokens(1234)).toBe('1234 tok');
  });
});

describe('lib/analytics.ts — formatRate', () => {
  it('renders an em dash for a rate nobody measured', () => {
    expect(formatRate(null)).toBe('—');
  });

  it('renders a measured rate as a rounded percentage', () => {
    expect(formatRate(0.75)).toBe('75%');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.666)).toBe('67%');
  });
});

describe('AnalyticsPage.vue — §5.8 MetricGrid sources both rates from lib/analytics.ts', () => {
  // ui/tsconfig.json does not type-check .vue and biome.json does not lint it,
  // so the source text is the only place these two cards can be held to the
  // helpers that know what "no denominator" means (D-216).
  it('imports the rate helpers rather than hand-rolling them in the template', () => {
    expect(SFC).toMatch(/from '\.\.\/lib\/analytics\.js'/);
    expect(SFC).toContain('latestSameMistakeRate(');
    expect(SFC).toContain('recheckPassRate(');
    expect(SFC).toContain('formatRate(');
  });

  it('picks no pass status out of recheckOutcomes by hand', () => {
    expect(SFC).not.toMatch(/taskStatus === '/);
  });

  it('labels the recheck card by what it now renders', () => {
    expect(SFC).toMatch(/label="Recheck pass rate"/);
    expect(SFC).not.toMatch(/hint="rechecks completed"/);
  });
});

describe('AnalyticsPage.vue — §5.8 cost cards source their numbers from lib/analytics.ts', () => {
  it('rolls the (tier, provider) buckets up through costPerTaskBy', () => {
    expect(SFC).toContain('costPerTaskBy(');
    expect(SFC).toContain("'modelTier'");
    expect(SFC).toContain("'provider'");
  });

  it('reduces the cost buckets nowhere in the template', () => {
    // Both charts and the StatCard used to fold costByModelTierAndProvider
    // inline — the one layer neither tsc nor biome reads (D-221).
    expect(SFC).not.toMatch(/costByModelTierAndProvider\s*\?\?\s*\[\]\)\.(reduce|map)/);
    expect(SFC).not.toContain('b.totalTokens');
    expect(SFC).not.toContain('b.avgTokensPerTask');
  });

  it('prints the cost card through formatTokens so an unmeasured cost is blank', () => {
    expect(SFC).toContain('costPerTask(');
    expect(SFC).toContain('formatTokens(');
    expect(SFC).not.toMatch(/\$\{avgCostPerTask\}/);
  });

  it('titles both cost charts by the unit they now plot', () => {
    expect(SFC).toMatch(/title="Cost per task by model tier"/);
    expect(SFC).toMatch(/title="Cost per task by provider"/);
    expect(SFC).not.toMatch(/label="Total tokens by provider"/);
  });
});

describe('lib/analytics.ts - quorumRows', () => {
  function stat(over: Partial<ProviderAgreementStat> = {}): ProviderAgreementStat {
    return {
      provider: 'codex',
      runs: 1,
      verdicts: 1,
      agreementRate: 1,
      latencySamples: 1,
      meanLatencyMs: 120,
      schemaFailureRate: 0,
      transportFailureRate: 0,
      failuresByCode: {},
      ...over,
    };
  }

  it('names every provider that judged, in the order the API sent them', () => {
    expect(
      quorumRows([stat({ provider: 'codex' }), stat({ provider: 'deepseek' })]).map(
        (r) => r.provider,
      ),
    ).toEqual(['codex', 'deepseek']);
  });

  it('reads a rate that has a denominator as a percentage of the runs that answered', () => {
    const [row] = quorumRows([stat({ runs: 4, verdicts: 2, agreementRate: 0.5 })]);
    expect(row?.agreement).toBe('50% agree');
    expect(row?.answered).toBe('2 of 4 answered');
  });

  it('says a provider that never answered has no verdict, rather than 0% agreement', () => {
    // D-168/D-31: a null rate is an absent measurement. Printing it as 0%
    // would report a provider that never got to speak as one that always
    // disagreed -- the opposite reading, on the card an operator uses to
    // decide whether a cross-check is worth paying for.
    const [row] = quorumRows([
      stat({ runs: 2, verdicts: 0, agreementRate: null, transportFailureRate: 1 }),
    ]);
    expect(row?.agreement).toBe('no verdict');
    expect(row?.agreement).not.toContain('0%');
    expect(row?.answered).toBe('0 of 2 answered');
  });

  it('lists the failure codes busiest first so the loudest one is readable in a rail card', () => {
    const [row] = quorumRows([
      stat({
        runs: 4,
        verdicts: 1,
        failuresByCode: { 'provider.invalid-output': 1, 'provider.missing-api-key': 2 },
      }),
    ]);
    expect(row?.failures).toEqual(['provider.missing-api-key ×2', 'provider.invalid-output ×1']);
  });

  it('carries no failure line when every run answered', () => {
    expect(quorumRows([stat()])[0]?.failures).toEqual([]);
  });

  it('omits the latency when no run reported one', () => {
    expect(quorumRows([stat({ latencySamples: 0, meanLatencyMs: null })])[0]?.latency).toBeNull();
    expect(quorumRows([stat({ meanLatencyMs: 119.6 })])[0]?.latency).toBe('120 ms avg');
  });
});

describe('AnalyticsPage.vue - cross-check quorum card', () => {
  it('renders the judge stats the API now sends instead of claiming none exist', () => {
    // The card was hardcoded to an EmptyState while 16 judge runs sat in the
    // shipped logs, so the page reported a single-provider factory (D-255).
    expect(SFC).not.toContain('No quorum data wired yet');
    expect(SFC).toContain('quorumRows(');
    expect(SFC).toContain('providerAgreement');
  });

  it('derives the card numbers in the lib, not inline in the template', () => {
    expect(SFC).not.toContain('agreementRate');
    expect(SFC).not.toContain('failuresByCode');
  });
});
