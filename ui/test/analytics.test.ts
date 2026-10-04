import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  breakdownTokensText,
  chartSeries,
  costPerTask,
  costPerTaskBy,
  dailySeriesKeys,
  dailyStackedBars,
  formatAvgTokensPerRun,
  formatRate,
  formatSeconds,
  formatTokens,
  frontierMidRatio,
  hasMultipleProviders,
  latestSameMistakeRate,
  notMeasuredCaption,
  phoneRoleShare,
  rateDisplay,
  ratioTakeaway,
  recheckPassRate,
  secondOpinionSummary,
  secondOpinionTakeaway,
  sumUnmeasuredRuns,
  tokenTotalsBy,
} from '../src/lib/analytics.js';
import type {
  CostBucket,
  DailyTokenBucket,
  ProviderAgreementStat,
  RoleModelTierBucket,
} from '../src/lib/api.js';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'AnalyticsPage.vue'),
  'utf8',
);
const PERIOD_SWITCH = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'components',
    'kit',
    'PeriodSwitch.vue',
  ),
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
  unmeasuredTaskCount = 0,
): CostBucket {
  const measuredTaskCount = taskCount - unmeasuredTaskCount;
  return {
    modelTier,
    provider,
    taskCount,
    totalTokens,
    unmeasuredTaskCount,
    avgTokensPerTask: measuredTaskCount > 0 ? totalTokens / measuredTaskCount : 0,
  };
}

describe('lib/analytics.ts — costPerTaskBy', () => {
  it('collapses one tier spread across providers into a single bar', () => {
    const series = costPerTaskBy(
      [bucket('mid', 'claude', 1, 2000), bucket('mid', 'codex', 3, 6000)],
      'modelTier',
    );
    expect(series).toEqual([{ label: 'mid', value: 2000 }]);
  });

  it('weights by task count rather than averaging the buckets’ averages', () => {
    const series = costPerTaskBy(
      [bucket('mid', 'claude', 1, 6000), bucket('mid', 'codex', 39, 39000)],
      'modelTier',
    );
    expect(series).toEqual([{ label: 'mid', value: 1125 }]);
  });

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

  it('omits a label whose every task went unmeasured, rather than plotting a fabricated 0', () => {
    const series = costPerTaskBy([bucket('mid', 'claude', 3, 0, 3)], 'modelTier');
    expect(series).toEqual([]);
  });

  it('does not dilute a label’s cost per task by the tasks nobody measured', () => {
    const series = costPerTaskBy(
      [bucket('mid', 'claude', 2, 4000, 0), bucket('mid', 'codex', 1, 0, 1)],
      'modelTier',
    );
    expect(series).toEqual([{ label: 'mid', value: 2000 }]);
  });
});

describe('lib/analytics.ts — costPerTask', () => {
  it('divides total tokens by total tasks across every bucket', () => {
    expect(costPerTask([bucket('mid', 'claude', 1, 2000), bucket('small', 'codex', 3, 6000)])).toBe(
      2000,
    );
  });

  it('returns null when no task has reported usage, rather than zero', () => {
    expect(costPerTask([])).toBeNull();
    expect(costPerTask([bucket('mid', 'claude', 0, 0)])).toBeNull();
  });

  it('returns null when every task in scope went unmeasured, even though taskCount is positive', () => {
    expect(costPerTask([bucket('mid', 'claude', 3, 0, 3)])).toBeNull();
  });
});

describe('lib/analytics.ts — formatTokens', () => {
  it('renders an em dash for a cost nobody measured', () => {
    expect(formatTokens(null)).toBe('—');
  });

  it('renders a measured cost with its unit, compacted past a thousand', () => {
    expect(formatTokens(0)).toBe('0 tok');
    expect(formatTokens(1234)).toBe('1.2K tok');
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

// DS7 §4.4: hidden entirely below two providers with real tokens — now reads
// the raw buckets rather than the rolled-up bars, so a 0-token stub row
// (every task unmeasured) cannot count as a provider.
describe('lib/analytics.ts — hasMultipleProviders', () => {
  it('is false for zero or one provider', () => {
    expect(hasMultipleProviders([])).toBe(false);
    expect(hasMultipleProviders([bucket('mid', 'claude', 1, 100)])).toBe(false);
  });

  it('is true once a second provider has real tokens', () => {
    expect(
      hasMultipleProviders([bucket('mid', 'claude', 1, 100), bucket('mid', 'codex', 1, 50)]),
    ).toBe(true);
  });

  it('does not count a provider whose every bucket is a zero-token stub', () => {
    expect(
      hasMultipleProviders([
        bucket('mid', 'claude', 4, 400),
        bucket('mid', 'codex', 0, 0),
        bucket('small', 'deepseek', 0, 0),
      ]),
    ).toBe(false);
  });

  it('sums a provider across tiers before counting it', () => {
    expect(
      hasMultipleProviders([
        bucket('mid', 'claude', 1, 100),
        bucket('small', 'claude', 1, 100),
        bucket('mid', 'codex', 1, 50),
      ]),
    ).toBe(true);
  });
});

describe('lib/analytics.ts — rateDisplay', () => {
  it('shows the short not-enough-data copy as the value, not an em dash', () => {
    expect(rateDisplay(null)).toBe('Not enough data yet');
  });

  it('formats a real rate as a percentage', () => {
    expect(rateDisplay(0.5)).toBe('50%');
  });
});

describe('lib/analytics.ts — frontierMidRatio / ratioTakeaway', () => {
  it('divides the frontier tier bar by the mid tier bar', () => {
    expect(
      frontierMidRatio([
        { label: 'frontier', value: 27000 },
        { label: 'mid', value: 1000 },
      ]),
    ).toBe(27);
  });

  it('returns null when either tier has no bar', () => {
    expect(frontierMidRatio([{ label: 'frontier', value: 27000 }])).toBeNull();
    expect(frontierMidRatio([])).toBeNull();
  });

  it('builds the takeaway sentence from the ratio, rounded', () => {
    expect(ratioTakeaway(27.4)).toBe(
      'The strongest model costs about 27x the standard one per task.',
    );
  });

  it('falls back to short copy when there is no ratio to report, never no takeaway at all', () => {
    expect(ratioTakeaway(null)).toBe('Needs runs on both frontier and mid tiers to compare.');
  });
});

describe('lib/analytics.ts — formatSeconds', () => {
  it('rounds milliseconds to the nearest second', () => {
    expect(formatSeconds(27400)).toBe('27 s');
    expect(formatSeconds(500)).toBe('1 s');
  });
});

describe('lib/analytics.ts — secondOpinionSummary / secondOpinionTakeaway', () => {
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

  it('weights agreement by each provider’s own verdict count', () => {
    const summary = secondOpinionSummary([
      stat({ provider: 'codex', verdicts: 1, agreementRate: 1 }),
      stat({ provider: 'deepseek', verdicts: 3, agreementRate: 0 }),
    ]);
    expect(summary.agreementRate).toBe(0.25);
  });

  it('returns a null agreement rate when nothing has verdicts', () => {
    expect(
      secondOpinionSummary([stat({ verdicts: 0, agreementRate: null })]).agreementRate,
    ).toBeNull();
    expect(secondOpinionSummary([]).agreementRate).toBeNull();
  });

  it('weights mean latency by each provider’s own sample count', () => {
    const summary = secondOpinionSummary([
      stat({ latencySamples: 1, meanLatencyMs: 100 }),
      stat({ latencySamples: 3, meanLatencyMs: 300 }),
    ]);
    expect(summary.meanLatencyMs).toBe(250);
  });

  it('takeaway converts the mean latency to seconds', () => {
    expect(secondOpinionTakeaway({ agreementRate: 0.37, meanLatencyMs: 27000 })).toBe(
      'agreed with the main reviewer; 27 s average.',
    );
  });

  it('takeaway drops the latency clause when nothing reported one', () => {
    expect(secondOpinionTakeaway({ agreementRate: null, meanLatencyMs: null })).toBe(
      'agreed with the main reviewer.',
    );
  });
});

function dayBucket(over: Partial<DailyTokenBucket> = {}): DailyTokenBucket {
  return {
    day: '2026-09-01',
    tokensByRole: {},
    tokensByModelTier: {},
    unmeasuredRunCount: 0,
    ...over,
  };
}

describe('lib/analytics.ts — dailySeriesKeys / dailyStackedBars / chartSeries', () => {
  it('lists role series in first-seen order, labelled through roleLabel', () => {
    const keys = dailySeriesKeys(
      [
        dayBucket({ tokensByRole: { coder: 100 } }),
        dayBucket({ tokensByRole: { reviewer: 50, coder: 10 } }),
      ],
      'role',
    );
    expect(keys).toEqual(['Builder', 'Code reviewer']);
  });

  it('never appends a "Not measured" key — a run count has no place on the token axis', () => {
    expect(dailySeriesKeys([dayBucket({ tokensByRole: { coder: 1 } })], 'role')).toEqual([
      'Builder',
    ]);
    expect(
      dailySeriesKeys([dayBucket({ tokensByRole: { coder: 1 }, unmeasuredRunCount: 2 })], 'role'),
    ).toEqual(['Builder']);
  });

  it('never plots an unmeasured run count as a token-axis segment', () => {
    const bars = dailyStackedBars([dayBucket({ unmeasuredRunCount: 4 })], 'role');
    expect(bars[0]?.values['Not measured']).toBeUndefined();
  });

  it('builds stacked bars keyed the same way the toggle labels its series, by tier too', () => {
    const bars = dailyStackedBars(
      [dayBucket({ day: '2026-09-02', tokensByModelTier: { frontier: 900, mid: 100 } })],
      'modelTier',
    );
    expect(bars).toEqual([
      { label: '2026-09-02', values: { 'flagship model': 900, 'standard model': 100 } },
    ]);
  });

  it('every chart key gets one of the cycling chart tones', () => {
    const series = chartSeries(['Builder', 'Code reviewer']);
    expect(series[0]?.tone).toMatch(/^var\(--bs-chart-/);
    expect(series[1]?.tone).toMatch(/^var\(--bs-chart-/);
  });
});

describe('lib/analytics.ts — sumUnmeasuredRuns / notMeasuredCaption', () => {
  it('sums unmeasuredRunCount across the given buckets', () => {
    expect(
      sumUnmeasuredRuns([
        dayBucket({ unmeasuredRunCount: 2 }),
        dayBucket({ unmeasuredRunCount: 3 }),
      ]),
    ).toBe(5);
    expect(sumUnmeasuredRuns([])).toBe(0);
  });

  it('returns null (no caption) when the count is zero', () => {
    expect(notMeasuredCaption(0)).toBeNull();
  });

  it('pluralises the caption for more than one run', () => {
    expect(notMeasuredCaption(1)).toBe('1 run not measured.');
    expect(notMeasuredCaption(3)).toBe('3 runs not measured.');
  });
});

function roleTierBucket(over: Partial<RoleModelTierBucket> = {}): RoleModelTierBucket {
  return {
    role: 'coder',
    modelTier: 'mid',
    runCount: 1,
    tokens: 100,
    avgTokensPerRun: 100,
    unmeasuredRunCount: 0,
    ...over,
  };
}

describe('lib/analytics.ts — tokenTotalsBy', () => {
  it('sums tokens per role across model tiers', () => {
    expect(
      tokenTotalsBy(
        [
          roleTierBucket({ role: 'coder', tokens: 100 }),
          roleTierBucket({ role: 'coder', modelTier: 'small', tokens: 50 }),
        ],
        'role',
      ),
    ).toEqual([{ label: 'Builder', value: 150 }]);
  });

  it('labels an attributionless row as Unattributed', () => {
    expect(tokenTotalsBy([roleTierBucket({ role: 'unattributed' })], 'role')).toEqual([
      { label: 'Unattributed', value: 100 },
    ]);
  });

  it('never appends a Not measured bar — a run count has no place on the token axis', () => {
    expect(tokenTotalsBy([roleTierBucket({ tokens: 100, unmeasuredRunCount: 3 })], 'role')).toEqual(
      [{ label: 'Builder', value: 100 }],
    );
  });
});

describe('lib/analytics.ts — phoneRoleShare', () => {
  it('sums tokens per role, same as tokenTotalsBy', () => {
    expect(
      phoneRoleShare([
        roleTierBucket({ role: 'coder', tokens: 100 }),
        roleTierBucket({ role: 'coder', modelTier: 'small', tokens: 50 }),
      ]),
    ).toEqual([{ label: 'Builder', value: 150 }]);
  });

  it('appends a Not measured row sized by unmeasured run count when any run went unmeasured', () => {
    expect(phoneRoleShare([roleTierBucket({ tokens: 100, unmeasuredRunCount: 3 })])).toEqual([
      { label: 'Builder', value: 100 },
      { label: 'Not measured', value: 3 },
    ]);
  });

  it('omits the Not measured row when every run was measured', () => {
    expect(phoneRoleShare([roleTierBucket({ tokens: 100, unmeasuredRunCount: 0 })])).toEqual([
      { label: 'Builder', value: 100 },
    ]);
  });
});

describe('lib/analytics.ts — formatAvgTokensPerRun', () => {
  it('renders "not measured" for a null average, never 0', () => {
    expect(formatAvgTokensPerRun(null)).toBe('not measured');
  });

  it('renders a real average with its unit', () => {
    expect(formatAvgTokensPerRun(1234)).toBe('1.2K tok');
  });
});

describe('lib/analytics.ts — breakdownTokensText', () => {
  it('formats the real total when at least one run was measured', () => {
    expect(
      breakdownTokensText(roleTierBucket({ tokens: 100, runCount: 2, unmeasuredRunCount: 1 })),
    ).toBe('100 tok');
  });

  it('reads "Not measured" when every run in the pair went unmeasured', () => {
    expect(
      breakdownTokensText(roleTierBucket({ tokens: 0, runCount: 2, unmeasuredRunCount: 2 })),
    ).toBe('Not measured');
  });
});

describe('kit/PeriodSwitch.vue', () => {
  it('takes a modelValue/options/label prop and emits update:modelValue, no RouterLink', () => {
    expect(PERIOD_SWITCH).toMatch(/modelValue:\s*string/);
    expect(PERIOD_SWITCH).toMatch(/options:\s*PeriodSwitchOption\[\]/);
    expect(PERIOD_SWITCH).toMatch(
      /defineEmits<\{\s*'update:modelValue':\s*\[value:\s*string\];?\s*\}>/,
    );
    expect(PERIOD_SWITCH).not.toContain('<RouterLink');
  });

  it('renders a button group with aria-pressed on the active option', () => {
    expect(PERIOD_SWITCH).toMatch(/role="group"/);
    expect(PERIOD_SWITCH).toMatch(/:aria-pressed="option\.value === modelValue"/);
  });
});

describe('AnalyticsPage.vue — period is read from and written to the URL', () => {
  it('reads ?period= off the route and defaults to 30d', () => {
    expect(SFC).toMatch(/route\.query\.period/);
    expect(SFC).toContain("'30d'");
  });

  it('writes the period back through router.replace rather than router.push', () => {
    expect(SFC).toMatch(/router\.replace\(\{\s*query:\s*\{\s*\.\.\.route\.query,\s*period/);
  });

  it('fetches analytics with the selected period', () => {
    expect(SFC).toMatch(/fetchAnalytics\([^)]*period[^)]*\)/);
  });
});

describe('AnalyticsPage.vue — daily stacked chart toggles role/tier with no refetch', () => {
  it('builds the stacked bars and series from lib/analytics.ts, not inline', () => {
    expect(SFC).toContain('dailyStackedBars(');
    expect(SFC).toContain('dailySeriesKeys(');
    expect(SFC).toContain('chartSeries(');
  });

  it('the toggle is a plain ref, not a second fetch call', () => {
    expect(SFC).toMatch(/const stackBy = ref/);
    // load() is the only fetchAnalytics call site; the toggle must not add one.
    expect(SFC.match(/fetchAnalytics\(/g)?.length).toBe(1);
  });

  it('passes the BarChart its stacked/series/stackedBars props', () => {
    expect(SFC).toMatch(/<BarChart[\s\S]{0,400}stacked[\s\S]{0,400}\/>/);
  });
});

describe('AnalyticsPage.vue — provider block hides below two real providers', () => {
  it('gates on the raw buckets through the fixed hasMultipleProviders', () => {
    expect(SFC).toMatch(/hasMultipleProviders\(costBuckets\)/);
  });
});

describe('AnalyticsPage.vue — not-enough-data and ratio takeaways', () => {
  it('sources the same-mistake and recheck-pass cards through rateDisplay', () => {
    expect(SFC).toContain('rateDisplay(');
  });

  it('sources the tokens-per-task ratio takeaway from the lib', () => {
    expect(SFC).toContain('frontierMidRatio(');
    expect(SFC).toContain('ratioTakeaway(');
  });
});

describe('AnalyticsPage.vue — breakdown table shows "not measured" for a null average', () => {
  it('formats the average column through formatAvgTokensPerRun', () => {
    expect(SFC).toContain('formatAvgTokensPerRun(');
  });
});

describe('AnalyticsPage.vue — second-opinion reviewers card', () => {
  it('sources its ring and takeaway from secondOpinionSummary', () => {
    expect(SFC).toContain('secondOpinionSummary(');
    expect(SFC).toContain('secondOpinionTakeaway(');
    expect(SFC).toContain('ProgressRing');
  });

  it('no longer renders the old cross-check quorum rail card', () => {
    expect(SFC).not.toContain('quorumRows(');
    expect(SFC).not.toContain('Cross-check quorum');
  });
});

describe('AnalyticsPage.vue — cut blocks are gone', () => {
  it('drops the old Throughput stat and trend chart', () => {
    expect(SFC).not.toMatch(/label="Throughput"/);
    expect(SFC).not.toContain('Throughput trend');
  });

  it('drops the old Recheck outcomes rail card', () => {
    expect(SFC).not.toContain('Recheck outcomes');
  });

  it('uses kit components, not ds', () => {
    expect(SFC).not.toMatch(/from '\.\.\/components\/ds\//);
  });

  it('PageHeader renders sr-only — no visible title row, title stays accessible', () => {
    expect(SFC).toMatch(/<PageHeader title="Cost & quality" \/>/);
  });
});

// DS7 PR2 round 3: match the mock's layout and phone behavior.
describe('AnalyticsPage.vue — page gutter (defect 1)', () => {
  it('uses the shared app-page container, the same gutter every other page uses', () => {
    expect(SFC).toMatch(/<div class="app-page">/);
  });
});

describe('AnalyticsPage.vue — no em-dash placeholder (defect 3)', () => {
  it('never renders a bare em dash for a missing tokens-per-task value', () => {
    expect(SFC).not.toContain('<span v-else>—</span>');
  });
});

describe('AnalyticsPage.vue — metric card takeaways and tooltip (defect 4)', () => {
  it("splits the not-enough-data reason onto each card's own takeaway line", () => {
    expect(SFC).toContain('Needs more settled rechecks.');
    expect(SFC).toContain('Same rule as above.');
  });

  it('adds an Info tooltip to Tokens per task, like Second-opinion reviewers already has', () => {
    const tokensPerTaskCard = SFC.slice(
      SFC.indexOf('title="Tokens per task"'),
      SFC.indexOf('title="Repeated mistakes'),
    );
    expect(tokensPerTaskCard).toContain('IconButton');
    expect(tokensPerTaskCard).toContain(':icon="Info"');
  });
});

describe('AnalyticsPage.vue — cost note styled inside the gutter (defect 5)', () => {
  it('keeps the note between the charts/table and the metric cards', () => {
    const tableIdx = SFC.indexOf('Tokens by role and model tier');
    const noteIdx = SFC.indexOf('bs-analytics-page__note');
    const metricsIdx = SFC.indexOf('bs-analytics-page__metrics');
    expect(tableIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeGreaterThan(tableIdx);
    expect(metricsIdx).toBeGreaterThan(noteIdx);
  });
});

describe('AnalyticsPage.vue — phone layout (defect 6)', () => {
  it('branches on the shared isPhoneWidth composable, not a new breakpoint', () => {
    expect(SFC).toContain('useViewport');
    expect(SFC).toContain('isPhoneWidth');
  });

  it('renders a phone-only 2-column metrics grid and role list', () => {
    expect(SFC).toContain('bs-analytics-page__phone-metrics');
    expect(SFC).toContain('bs-analytics-page__phone-roles');
    expect(SFC).toContain('phoneRoleShare(');
  });
});
