// The numbers behind the Analytics §5.8 MetricGrid and its two cost charts.
// Every one of them can legitimately have no denominator, and a metric that
// reads 0% or `0 tok` is a claim ("we repeated nothing", "nothing passed",
// "we spent nothing") rather than a blank — so each returns `null` for
// "nobody measured this" and the format helpers turn that into an em dash.
// The page must not re-derive any of them inline: .vue files are checked by
// neither tsc nor biome here, so this module is the only place these numbers
// can be tested.
import type { CostBucket, ProviderAgreementStat, RecheckOutcome, SameMistakeDay } from './api.js';
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
 */
export function costPerTaskBy(
  buckets: readonly CostBucket[],
  by: 'modelTier' | 'provider',
): { label: string; value: number }[] {
  const totals = new Map<string, { tokens: number; tasks: number }>();
  for (const bucket of buckets) {
    const label = bucket[by];
    const running = totals.get(label) ?? { tokens: 0, tasks: 0 };
    running.tokens += bucket.totalTokens;
    running.tasks += bucket.taskCount;
    totals.set(label, running);
  }
  return [...totals].map(([label, { tokens, tasks }]) => ({
    label,
    value: tasks > 0 ? Math.round(tokens / tasks) : 0,
  }));
}

/**
 * Tokens per task across the whole factory, or `null` while no task has
 * reported any usage. Zero would read as "we spent nothing" on a card that
 * exists to report spend — the same claim-from-silence D-219 took off the
 * recheck card next to it.
 */
export function costPerTask(buckets: readonly CostBucket[]): number | null {
  let tokens = 0;
  let tasks = 0;
  for (const bucket of buckets) {
    tokens += bucket.totalTokens;
    tasks += bucket.taskCount;
  }
  return tasks > 0 ? Math.round(tokens / tasks) : null;
}

/** "1234 tok" — or an em dash when no task reported any usage to divide. */
export function formatTokens(tokens: number | null): string {
  return tokens === null ? '—' : `${tokens} tok`;
}

/** One rendered line of the Analytics rail's "Cross-check quorum" card. */
export interface QuorumRow {
  provider: string;
  /** "2 of 4 answered" — the denominator the rate is a fraction of. */
  answered: string;
  /** "50% agree", or "no verdict" when nothing answered. */
  agreement: string;
  /** "120 ms avg", or `null` when no run reported a latency to average. */
  latency: string | null;
  /** "provider.missing-api-key ×2" per code, busiest first; empty when all answered. */
  failures: string[];
}

/**
 * The Analytics rail's cross-check quorum lines (design-spec §5.8), one per
 * judge provider, in the order the API sent them (already provider-sorted).
 *
 * This card is the page's only surface for a non-claude provider, and the
 * reason it has to exist: the cost charts are built from
 * `task-result-recorded`, which only a builder writes, and every external
 * provider in this factory judges rather than builds — so cost names claude
 * in every session ever logged while codex and deepseek judge in the same log
 * (D-255).
 *
 * A provider that never returned a schema-valid verdict reads "no verdict",
 * never "0% agree": the rate has no denominator, and 0% would report a
 * provider that never got to speak as one that disagreed with every native
 * call — the opposite reading, on the card an operator uses to decide whether
 * a cross-check is worth paying for (D-168/D-31).
 */
export function quorumRows(stats: readonly ProviderAgreementStat[]): QuorumRow[] {
  return stats.map((stat) => ({
    provider: stat.provider,
    answered: `${stat.verdicts} of ${stat.runs} answered`,
    agreement:
      stat.agreementRate === null ? 'no verdict' : `${formatRate(stat.agreementRate)} agree`,
    latency: stat.meanLatencyMs === null ? null : `${Math.round(stat.meanLatencyMs)} ms avg`,
    // Busiest code first: the rail card is one column wide, so the failure an
    // operator most needs to see has to be the one that survives truncation.
    failures: Object.entries(stat.failuresByCode)
      .sort(([codeA, a], [codeB, b]) => b - a || codeA.localeCompare(codeB))
      .map(([code, n]) => `${code} ×${n}`),
  }));
}
