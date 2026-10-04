// The numbers behind the Analytics §5.8 MetricGrid and its two cost charts.
// Every one of them can legitimately have no denominator, and a metric that
// reads 0% or `0 tok` is a claim ("we repeated nothing", "nothing passed",
// "we spent nothing") rather than a blank — so each returns `null` for
// "nobody measured this" and the format helpers turn that into an em dash.
// The page must not re-derive any of them inline: .vue files are checked by
// neither tsc nor biome here, so this module is the only place these numbers
// can be tested.
import type {
  CostBucket,
  DailyTokenBucket,
  ProviderAgreementStat,
  RecheckOutcome,
  RoleModelTierBucket,
  SameMistakeDay,
} from './api.js';
import { formatCompactNumber } from './format.js';
import { roleLabel, tierLabel } from './roleLabels.js';
import { taskOutcome } from './taxonomy.js';

/**
 * The most recent day's same-mistake rate, or `null` when that day recorded
 * gate intakes but decided nothing. queries.ts's SameMistakeDay.rate docblock
 * requires this of every reader: a day the gate decided nothing on must not
 * be plotted at zero, because that is indistinguishable from a day it cleared
 * every finding it saw (D-31 — silence is not assent). Reaching further back
 * for the last measured day would be the same lie in the other direction: the
 * card is labelled "latest day".
 */
export function latestSameMistakeRate(days: readonly SameMistakeDay[]): number | null {
  return days[days.length - 1]?.rate ?? null;
}

export interface RecheckPassRate {
  /** Rechecks that reached a passing status. */
  passed: number;
  /** Rechecks that reached any verdict at all — the denominator. */
  settled: number;
  /** `passed / settled`, or `null` while no recheck has settled. */
  rate: number | null;
}

/**
 * Pass rate over the rechecks that have actually settled. In-flight rechecks
 * are not failures yet and superseded ones never answered, so neither belongs
 * in the denominator; `taskOutcome` owns that partition.
 */
export function recheckPassRate(outcomes: readonly RecheckOutcome[]): RecheckPassRate {
  let passed = 0;
  let settled = 0;
  for (const outcome of outcomes) {
    const verdict = taskOutcome(outcome.taskStatus);
    if (verdict !== 'passed' && verdict !== 'failed') continue;
    settled += outcome.count;
    if (verdict === 'passed') passed += outcome.count;
  }
  return { passed, settled, rate: settled > 0 ? passed / settled : null };
}

/** "75%" — or an em dash when there was no denominator to divide by. */
export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/**
 * Cost per task rolled up along one dimension of `costByModelTierAndProvider`.
 *
 * queries.ts buckets that series by the (model_tier, provider) PAIR, so a tier
 * that ran on two providers arrives as two rows. Charting those rows directly
 * and labelling each with one half of its key draws two bars under the same
 * name — neither of them that half's cost per task — and hands BarChart, which
 * keys its `v-for` on the label, a duplicate key. Rolling up first also keeps
 * the series inside BarChart's silent 8-series cap: the pairs can reach 3 × 3,
 * either dimension alone cannot.
 *
 * The roll-up divides summed tokens by summed tasks rather than averaging the
 * buckets' own averages, so a provider that ran one task cannot outweigh one
 * that ran forty and the bars reconcile with the "Cost per task" StatCard.
 * Labels come out in first-seen order so a refresh cannot reshuffle the chart.
 *
 * A bucket's `taskCount` can include results whose `token_usage` was
 * `{ measured: false }` (issue #220) — `unmeasuredTaskCount` says how many.
 * Those tasks are excluded from the denominator so they cannot dilute the
 * average, and a label whose every task went unmeasured is omitted outright
 * rather than plotted as a fabricated 0 — the same "no denominator" case
 * `costPerTask` returns `null` for, but BarChart's `{ label, value: number }`
 * bars have no null slot, so here the bar itself is dropped.
 */
export function costPerTaskBy(
  buckets: readonly CostBucket[],
  by: 'modelTier' | 'provider',
): { label: string; value: number }[] {
  const totals = new Map<string, { tokens: number; tasks: number; measuredTasks: number }>();
  for (const bucket of buckets) {
    const label = bucket[by];
    const running = totals.get(label) ?? { tokens: 0, tasks: 0, measuredTasks: 0 };
    running.tokens += bucket.totalTokens;
    running.tasks += bucket.taskCount;
    running.measuredTasks += bucket.taskCount - bucket.unmeasuredTaskCount;
    totals.set(label, running);
  }
  const series: { label: string; value: number }[] = [];
  for (const [label, { tokens, tasks, measuredTasks }] of totals) {
    if (measuredTasks > 0) {
      series.push({ label, value: Math.round(tokens / measuredTasks) });
    } else if (tasks === 0) {
      series.push({ label, value: 0 });
    }
  }
  return series;
}

/**
 * Tokens per task across the whole factory, or `null` while no task has
 * reported any usage. Zero would read as "we spent nothing" on a card that
 * exists to report spend — the same claim-from-silence D-219 took off the
 * recheck card next to it. A bucket's `unmeasuredTaskCount` (issue #220,
 * results with `token_usage: { measured: false }`) is excluded from the
 * denominator, so a factory that ran tasks but measured none of them also
 * reads `null` rather than a fabricated 0.
 */
export function costPerTask(buckets: readonly CostBucket[]): number | null {
  let tokens = 0;
  let measuredTasks = 0;
  for (const bucket of buckets) {
    tokens += bucket.totalTokens;
    measuredTasks += bucket.taskCount - bucket.unmeasuredTaskCount;
  }
  return measuredTasks > 0 ? Math.round(tokens / measuredTasks) : null;
}

/** "1.2K tok" — or an em dash when no task reported any usage to divide. */
export function formatTokens(tokens: number | null): string {
  return tokens === null ? '—' : `${formatCompactNumber(tokens)} tok`;
}

/**
 * Whether "Cost per task by provider" has anything worth comparing. Most
 * projects run a single provider end to end, so a lone bar answers a
 * question nobody asked and just repeats the "Cost per task" StatCard next
 * to it — the card is hidden entirely below two providers rather than drawn
 * with one bar (D-31: no claim with nothing to contrast it against).
 *
 * DS7 §4.4: operates on the raw buckets, not the rolled-up bars —
 * `costPerTaskBy` can push a `{ label, value: 0 }` stub for a provider whose
 * every task went unmeasured (so the bar list length alone over-counts); the
 * gate is "providers with totalTokens > 0", summed across every tier.
 */
export function hasMultipleProviders(buckets: readonly CostBucket[]): boolean {
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    totals.set(bucket.provider, (totals.get(bucket.provider) ?? 0) + bucket.totalTokens);
  }
  let withTokens = 0;
  for (const tokens of totals.values()) {
    if (tokens > 0) withTokens += 1;
  }
  return withTokens >= 2;
}

/**
 * DS7 §4.4 items 2/3: same not-enough-data rule for both the same-mistake
 * rate and the recheck pass rate. The spec names the copy but not a
 * threshold; this one shared constant is the single place that number lives.
 */
export const MIN_SETTLED_FOR_RATE = 5;

/**
 * The metric value line for the same-mistake/recheck-pass cards — "75%", or
 * the mock's short "Not enough data yet" rather than the bare em dash
 * `formatRate` prints on its own. The reason sits on each card's own
 * takeaway sentence in the template (mock copy differs per card), so this
 * stays the value alone (DS7 PR2 round 3 defect 4 — the value previously
 * crammed the parenthetical in).
 */
export function rateDisplay(rate: number | null): string {
  return rate === null ? 'Not enough data yet' : formatRate(rate);
}

/**
 * Tokens-per-task ratio of the flagship tier over the standard tier — the
 * "Tokens per task" card's takeaway line (DS7 §4.4 item 1). `null` when
 * either tier has no cost-per-task bar to divide (no denominator).
 */
export function frontierMidRatio(
  costByTierData: readonly { label: string; value: number }[],
): number | null {
  const frontier = costByTierData.find((b) => b.label === 'frontier')?.value;
  const mid = costByTierData.find((b) => b.label === 'mid')?.value;
  if (!frontier || !mid) return null;
  return frontier / mid;
}

/**
 * "The strongest model costs about 27x the standard one per task." — or a
 * fallback line when the ratio has no denominator (e.g. only one tier has
 * run), since §4.4 requires every card to carry a takeaway, never none at all.
 */
export function ratioTakeaway(ratio: number | null): string {
  if (ratio === null) return 'Needs runs on both frontier and mid tiers to compare.';
  return `The strongest model costs about ${Math.round(ratio)}x the standard one per task.`;
}

/** "27 s" — ms rounded to the nearest second, per DS7 §4.4's phone copy. */
export function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

/** The "Second-opinion reviewers" card's two aggregate numbers (DS7 §4.4 item 4). */
export interface SecondOpinionSummary {
  /** Verdicts-weighted agreement rate, or `null` when nothing answered. */
  agreementRate: number | null;
  /** Latency-samples-weighted mean, or `null` when no run reported one. */
  meanLatencyMs: number | null;
}

/**
 * Rolls every judge provider's calibration (per-provider in
 * `ProviderAgreementStat`) into the single ring this card now shows, in
 * place of the old one-row-per-provider rail list. Each average is weighted
 * by its own denominator so a provider with one run cannot outweigh one with
 * forty (same reasoning as `costPerTaskBy`'s task-count weighting).
 */
export function secondOpinionSummary(
  stats: readonly ProviderAgreementStat[],
): SecondOpinionSummary {
  let verdicts = 0;
  let agreements = 0;
  let latencySamples = 0;
  let latencyTotal = 0;
  for (const stat of stats) {
    verdicts += stat.verdicts;
    if (stat.agreementRate !== null) agreements += stat.agreementRate * stat.verdicts;
    if (stat.meanLatencyMs !== null) {
      latencyTotal += stat.meanLatencyMs * stat.latencySamples;
      latencySamples += stat.latencySamples;
    }
  }
  return {
    agreementRate: verdicts > 0 ? agreements / verdicts : null,
    meanLatencyMs: latencySamples > 0 ? latencyTotal / latencySamples : null,
  };
}

/** "agreed with the main reviewer; 27 s average." */
export function secondOpinionTakeaway(summary: SecondOpinionSummary): string {
  if (summary.meanLatencyMs === null) return 'agreed with the main reviewer.';
  return `agreed with the main reviewer; ${formatSeconds(summary.meanLatencyMs)} average.`;
}

const CHART_TONES = [
  'var(--bs-chart-1)',
  'var(--bs-chart-2)',
  'var(--bs-chart-3)',
  'var(--bs-chart-4)',
  'var(--bs-chart-5)',
  'var(--bs-chart-6)',
];

/**
 * The series keys the daily stacked chart needs for `by`, in first-seen
 * order across the window so a poll cannot reshuffle the legend.
 *
 * An unmeasured run is a run COUNT, not a token total: mixed into a token
 * series it renders as an invisible sliver next to real token totals — the
 * same claim-from-silence the spec forbids, just drawn too small to see
 * rather than at zero. It is surfaced instead through `sumUnmeasuredRuns` /
 * `notMeasuredCaption` (a caption under the chart) and `breakdownTokensText`
 * (the breakdown table), never as a bar segment here.
 */
export function dailySeriesKeys(
  days: readonly DailyTokenBucket[],
  by: 'role' | 'modelTier',
): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const day of days) {
    const source = by === 'role' ? day.tokensByRole : day.tokensByModelTier;
    for (const rawKey of Object.keys(source)) {
      const label = by === 'role' ? roleLabel(rawKey) : tierLabel(rawKey);
      if (!seen.has(label)) {
        seen.add(label);
        keys.push(label);
      }
    }
  }
  return keys;
}

/**
 * Fixed role/tier -> tone assignments, matching the mock's legend (c1
 * Builder, c2 Tester, c3 Code reviewer, c4 Quality grader). A key outside
 * this map still gets a tone, deterministically, from `hashedTone` below —
 * never from its position in whatever list happened to be built first.
 */
const ROLE_TIER_TONES: Record<string, string> = {
  Builder: 'var(--bs-chart-1)',
  Tester: 'var(--bs-chart-2)',
  'Code reviewer': 'var(--bs-chart-3)',
  'Quality grader': 'var(--bs-chart-4)',
};

/** Deterministic fallback tone for a key with no fixed assignment above. */
function hashedTone(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) & 0xffffffff;
  }
  const index = Math.abs(hash) % CHART_TONES.length;
  return CHART_TONES[index] ?? 'var(--bs-chart-1)';
}

/**
 * The one place a role/tier label maps to a chart tone (DS7 PR2 round 5
 * item 1). Keyed by the label itself, not by position in any one chart's
 * series, so the same role reads the same colour in the daily chart, the
 * by-role chart, the phone mini-bars and every legend regardless of which
 * other roles are present or in what order.
 */
export function toneForKey(key: string): string {
  return ROLE_TIER_TONES[key] ?? hashedTone(key);
}

/** Pairs `dailySeriesKeys`' output with each key's stable tone from `toneForKey`. */
export function chartSeries(keys: readonly string[]): { key: string; tone: string }[] {
  return keys.map((key) => ({ key, tone: toneForKey(key) }));
}

/**
 * One stacked bar per day, keyed the same way `dailySeriesKeys` labels its
 * series, so `kit/BarChart.vue`'s `entry.values[series[i].key]` lookup
 * matches. Never carries an unmeasured-run segment — see `dailySeriesKeys`.
 */
export function dailyStackedBars(
  days: readonly DailyTokenBucket[],
  by: 'role' | 'modelTier',
): { label: string; values: Record<string, number> }[] {
  return days.map((day) => {
    const source = by === 'role' ? day.tokensByRole : day.tokensByModelTier;
    const values: Record<string, number> = {};
    for (const [rawKey, tokens] of Object.entries(source)) {
      values[by === 'role' ? roleLabel(rawKey) : tierLabel(rawKey)] = tokens;
    }
    return { label: day.day, values };
  });
}

/**
 * Sums `unmeasuredRunCount` across any bucket shape that carries one — the
 * daily buckets for the chart caption, the role/tier buckets for the
 * breakdown-table caption.
 */
export function sumUnmeasuredRuns(buckets: readonly { unmeasuredRunCount: number }[]): number {
  return buckets.reduce((sum, b) => sum + b.unmeasuredRunCount, 0);
}

/**
 * "N run(s) not measured." under a chart, or `null` to hide the caption
 * outright when every run in range was measured (DS7 §4.4 item 1) — the
 * form an unmeasured run surfaces in now that it no longer rides the token
 * axis as a bar segment.
 */
export function notMeasuredCaption(count: number): string | null {
  if (count === 0) return null;
  return `${count} ${count === 1 ? 'run' : 'runs'} not measured.`;
}

/**
 * Total tokens per role or model tier over the selected period, rolled up
 * from `tokensByRoleAndModelTier` (one row per role/model-tier pair) — the
 * horizontal chart's bars (DS7 §4.4 item 3). Never carries an unmeasured-run
 * bar; see `dailySeriesKeys`.
 */
export function tokenTotalsBy(
  buckets: readonly RoleModelTierBucket[],
  by: 'role' | 'modelTier',
): { label: string; value: number }[] {
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    const label = by === 'role' ? roleLabel(bucket.role) : tierLabel(bucket.modelTier);
    totals.set(label, (totals.get(label) ?? 0) + bucket.tokens);
  }
  return [...totals].map(([label, value]) => ({ label, value }));
}

/** One row of the horizontal by-role/by-tier totals chart (DS7 PR2 round 5 item 2). */
export interface HorizontalBar {
  label: string;
  value: number;
  /** Width relative to the largest row, 0-100, as in the mock. */
  pct: number;
  tone: string;
}

/**
 * `tokenTotalsBy`'s rows, sorted largest-first and widthed relative to the
 * largest row, each carrying its `toneForKey` tone — the by-role "Total
 * tokens" chart's rows in the mock's horizontal layout.
 */
export function horizontalTotalsBars(
  buckets: readonly RoleModelTierBucket[],
  by: 'role' | 'modelTier',
): HorizontalBar[] {
  const rows = tokenTotalsBy(buckets, by);
  const max = Math.max(...rows.map((row) => row.value), 1);
  return [...rows]
    .sort((a, b) => b.value - a.value)
    .map((row) => ({
      ...row,
      pct: Math.max((row.value / max) * 100, 2),
      tone: toneForKey(row.label),
    }));
}

/**
 * The by-role chart's `role="img"` aria-label: names the highest row and its
 * token count, formatted through `formatTokens` like every other token
 * figure on the page, never a raw integer (DS7 PR2 round 7 item 1).
 */
export function totalsSummaryCaption(rows: readonly HorizontalBar[]): string {
  const top = rows[0];
  return top
    ? `Total tokens, highest ${top.label} at ${formatTokens(top.value)}.`
    : 'Total tokens: no data.';
}

/**
 * Share of RUNS (not tokens) that went unmeasured over the period, across
 * every role/tier bucket — the by-role chart's and the phone list's
 * "Not measured" row (DS7 PR2 round 5 items 2/5). An unmeasured run has no
 * token count, so its row is never sized by tokens and never reads as a
 * token-axis 0; it is sized by its share of all runs instead.
 */
export function notMeasuredRunShare(buckets: readonly RoleModelTierBucket[]): {
  unmeasured: number;
  total: number;
  pct: number;
} {
  let unmeasured = 0;
  let total = 0;
  for (const bucket of buckets) {
    unmeasured += bucket.unmeasuredRunCount;
    total += bucket.runCount;
  }
  return { unmeasured, total, pct: total > 0 ? Math.round((unmeasured / total) * 100) : 0 };
}

/**
 * "2 of 14 runs not measured." under the by-role chart, or `null` to hide it
 * when every run in range was measured — the row now carries this caption
 * itself, so the chart no longer needs a separate one.
 */
export function notMeasuredRunsCaption(unmeasured: number, total: number): string | null {
  if (unmeasured === 0) return null;
  return `${unmeasured} of ${total} runs not measured.`;
}

/**
 * The phone role list's rows — the phone list's only surface for an
 * unmeasured run, since the chart and table it stands in for on desktop are
 * both dropped at this width (DS7 PR2 round 3 defect 6). `roles` is
 * `tokenTotalsBy('role')`: a percentage share is only ever computed across
 * these token values. `unmeasuredRunCount` is a separate axis — a run
 * count, not a token count — so it never gets folded into that percentage
 * or rendered as a bar; the caller shows it as its own "N runs not
 * measured" row with no bar and no %, same rule as `tokenTotalsBy` above.
 */
export function phoneRoleShare(buckets: readonly RoleModelTierBucket[]): {
  roles: { label: string; value: number }[];
  unmeasuredRunCount: number;
} {
  return {
    roles: tokenTotalsBy(buckets, 'role'),
    unmeasuredRunCount: sumUnmeasuredRuns(buckets),
  };
}

/** "1.2K tok", or "not measured" for a pair with no average to report, never 0. */
export function formatAvgTokensPerRun(avg: number | null): string {
  return avg === null ? 'not measured' : `${formatCompactNumber(avg)} tok`;
}

/**
 * The breakdown table's tokens column: the real total, or "Not measured"
 * when every run in the pair went unmeasured — never a fabricated 0 (DS7
 * §4.4 item 1).
 */
export function breakdownTokensText(bucket: RoleModelTierBucket): string {
  if (bucket.runCount > 0 && bucket.unmeasuredRunCount === bucket.runCount) return 'Not measured';
  return formatTokens(bucket.tokens);
}
