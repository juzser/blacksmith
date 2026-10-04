<script setup lang="ts">
// Analytics — ds-spec.md §4.4 (DS7): cut to 4 metric cards plus a
// period-scoped token-trend section. Operator override beats the mock: no
// visible title row, the topbar carries the title alone (see useBreadcrumb
// below) — PageHeader is still used, sr-only, for the accessible h1
// (WorkPage.vue precedent);
// the daily chart's role/tier toggle never refetches — BarChart's own data
// derivation (lib/analytics.ts) runs client-side over whatever `period`
// already has loaded.
import { Coins, Info, RefreshCw } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Banner from '../components/kit/Banner.vue';
import BarChart from '../components/kit/BarChart.vue';
import Button from '../components/kit/Button.vue';
import Card from '../components/kit/Card.vue';
import CompactNumber from '../components/kit/CompactNumber.vue';
import EmptyState from '../components/kit/EmptyState.vue';
import IconButton from '../components/kit/IconButton.vue';
import PageHeader from '../components/kit/PageHeader.vue';
import PeriodSwitch from '../components/kit/PeriodSwitch.vue';
import ProgressBarMini from '../components/kit/ProgressBarMini.vue';
import ProgressRing from '../components/kit/ProgressRing.vue';
import Skeleton from '../components/kit/Skeleton.vue';
import Table from '../components/kit/Table.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useSessionContext } from '../composables/useSessionContext.js';
import { useViewport } from '../composables/useViewport.js';
import {
  breakdownTokensText,
  chartSeries,
  costPerTask,
  costPerTaskBy,
  dailySeriesKeys,
  dailyStackedBars,
  formatAvgTokensPerRun,
  frontierMidRatio,
  hasMultipleProviders,
  horizontalTotalsBars,
  MIN_SETTLED_FOR_RATE,
  notMeasuredCaption,
  notMeasuredRunShare,
  notMeasuredRunsCaption,
  phoneRoleShare,
  rateDisplay,
  ratioTakeaway,
  recheckPassRate,
  secondOpinionSummary,
  secondOpinionTakeaway,
  sumUnmeasuredRuns,
} from '../lib/analytics.js';
import { type AnalyticsPeriod, type AnalyticsResult, fetchAnalytics } from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { roleLabel, tierLabel } from '../lib/roleLabels.js';

const router = useRouter();
const route = useRoute();
const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Cost & quality' }]);
const { project } = useProjectContext();
const { sessionScope, sessionKey } = useSessionContext();
const { isPhoneWidth } = useViewport();

const PERIOD_OPTIONS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

function readPeriod(): AnalyticsPeriod {
  const q = route.query.period;
  return q === '7d' || q === '30d' || q === '90d' ? q : '30d';
}

const period = ref<AnalyticsPeriod>(readPeriod());
const data = ref<AnalyticsResult | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);

async function load() {
  error.value = null;
  loading.value = data.value === null;
  try {
    data.value = await fetchAnalytics(sessionScope.value, project.value, period.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch([project, sessionKey], load);

function setPeriod(value: string) {
  period.value = value as AnalyticsPeriod;
  router.replace({ query: { ...route.query, period: value } });
  load();
}

// Role/tier toggle for the two period charts below — a plain ref, never a
// refetch: both dimensions already ride along on every tokensByDay/
// tokensByRoleAndModelTier row the server sends for the period (D-221 style).
const stackBy = ref<'role' | 'modelTier'>('role');

const dailyBuckets = computed(() => data.value?.tokensByDay ?? []);
// BarChart's own `.slice(0, 8)` cap takes the first 8 entries of whatever it
// is given — for a 30/90-day period that would plot the *oldest* week
// instead of the most recent one, so the trailing window is sliced here,
// before the data ever reaches the chart.
const recentDailyBuckets = computed(() => dailyBuckets.value.slice(-8));
const dailySeries = computed(() =>
  chartSeries(dailySeriesKeys(recentDailyBuckets.value, stackBy.value)),
);
const dailyBars = computed(() => dailyStackedBars(recentDailyBuckets.value, stackBy.value));
const dailyTakeaway = computed(() =>
  dailyBars.value.length === 0
    ? 'No token usage recorded yet for this period.'
    : `Daily tokens by ${stackBy.value === 'role' ? 'role' : 'model tier'} over the last ${dailyBars.value.length} days.`,
);
const dailyNotMeasuredCaption = computed(() =>
  notMeasuredCaption(sumUnmeasuredRuns(recentDailyBuckets.value)),
);

const roleTierBuckets = computed(() => data.value?.tokensByRoleAndModelTier ?? []);
// The by-role "Total tokens" chart is horizontal in the mock, one row per
// role plus a separate "Not measured" row sized by its share of RUNS, never
// by a fabricated token count (DS7 PR2 round 5 item 2).
const totalsBarRows = computed(() => horizontalTotalsBars(roleTierBuckets.value, stackBy.value));
const totalsNotMeasured = computed(() => notMeasuredRunShare(roleTierBuckets.value));
const totalsTakeaway = computed(() =>
  totalsBarRows.value.length === 0
    ? 'No token usage recorded yet for this period.'
    : `Total tokens by ${stackBy.value === 'role' ? 'role' : 'model tier'} for the selected period.`,
);
const totalsSummary = computed(() => {
  const top = totalsBarRows.value[0];
  return top ? `Total tokens, highest ${top.label} at ${top.value}.` : 'Total tokens: no data.';
});
const totalsNotMeasuredCaption = computed(() =>
  notMeasuredRunsCaption(totalsNotMeasured.value.unmeasured, totalsNotMeasured.value.total),
);

const breakdownColumns = computed(() => [
  { key: 'group', label: stackBy.value === 'role' ? 'Role' : 'Model tier' },
  { key: 'runCount', label: 'Runs', numeric: true },
  { key: 'tokens', label: 'Tokens', numeric: true },
  { key: 'avg', label: 'Avg tokens/run', numeric: true },
  { key: 'unmeasured', label: 'Unmeasured', numeric: true },
]);
const breakdownRows = computed(() =>
  roleTierBuckets.value.map((b) => ({
    id: `${b.role}-${b.modelTier}`,
    group: stackBy.value === 'role' ? roleLabel(b.role) : tierLabel(b.modelTier),
    runCount: b.runCount,
    tokens: breakdownTokensText(b),
    avg: formatAvgTokensPerRun(b.avgTokensPerRun),
    unmeasured: b.unmeasuredRunCount,
  })),
);

// Metric 1: tokens per task, plus the frontier-vs-mid ratio takeaway —
// computed from the long-running costByModelTierAndProvider series, not the
// period-scoped one, matching §4.4 item 1's existing data source.
const costBuckets = computed(() => data.value?.costByModelTierAndProvider ?? []);
const avgCostPerTask = computed(() => costPerTask(costBuckets.value));
const costByTierData = computed(() => costPerTaskBy(costBuckets.value, 'modelTier'));
const ratio = computed(() => frontierMidRatio(costByTierData.value));
const costByProviderData = computed(() => costPerTaskBy(costBuckets.value, 'provider'));

// Metric 2/3: same-mistake and recheck pass rates, gated on a settled-count
// floor rather than a bare dash (audit item 12).
const sameMistakeDays = computed(() => data.value?.sameMistakeRateByDay ?? []);
const sameMistakeSettled = computed(() =>
  sameMistakeDays.value.reduce((s, d) => s + d.decisions, 0),
);
const sameMistakeRate = computed(() => {
  const days = sameMistakeDays.value;
  const latest = days.length > 0 ? days[days.length - 1] : undefined;
  return latest?.rate ?? null;
});
const sameMistakeDisplay = computed(() =>
  sameMistakeSettled.value < MIN_SETTLED_FOR_RATE ? null : sameMistakeRate.value,
);

const recheckPass = computed(() => recheckPassRate(data.value?.recheckOutcomes ?? []));
const recheckDisplay = computed(() =>
  recheckPass.value.settled < MIN_SETTLED_FOR_RATE ? null : recheckPass.value.rate,
);

// Metric 4: second-opinion reviewers.
const secondOpinion = computed(() => secondOpinionSummary(data.value?.providerAgreement ?? []));
const secondOpinionPct = computed(() =>
  secondOpinion.value.agreementRate === null
    ? 0
    : Math.round(secondOpinion.value.agreementRate * 100),
);

// Phone-only: the by-role chart and table are both dropped at this width, so
// their one surface becomes a role list with a % share of measured tokens
// (DS7 PR2 round 3 defect 6). Unmeasured runs are a run count, not a token
// count — they get their own "N runs not measured" row, no bar, no %,
// never folded into the token-share percentages (phoneRoleShare's contract).
const phoneRoleBars = computed(() => {
  const { roles } = phoneRoleShare(roleTierBuckets.value);
  const total = roles.reduce((sum, b) => sum + b.value, 0);
  return roles.map((b) => ({
    label: b.label,
    pct: total > 0 ? Math.round((b.value / total) * 100) : 0,
  }));
});
// Same run-share rule as the desktop horizontal chart's Not-measured row:
// the phone list's bar and % are the share of runs not measured, never a
// token share (DS7 PR2 round 5 item 5) — role rows above stay % of tokens.
const phoneNotMeasured = computed(() => notMeasuredRunShare(roleTierBuckets.value));
const phoneNotMeasuredLabel = computed(() =>
  phoneNotMeasured.value.unmeasured > 0 ? `${phoneNotMeasured.value.pct}% of runs` : '',
);
</script>

<template>
  <div class="app-page">
    <PageHeader title="Cost & quality" />
    <div class="bs-analytics-page__toolbar">
      <PeriodSwitch
        :model-value="period"
        :options="PERIOD_OPTIONS"
        label="Period"
        :variant="isPhoneWidth ? 'tabs' : 'buttons'"
        @update:model-value="setPeriod"
      />
      <Button variant="ghost" size="sm" :icon="RefreshCw" @click="load">Refresh</Button>
    </div>

    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>

    <template v-if="loading">
      <Skeleton v-for="i in 3" :key="i" height="220" />
    </template>

    <template v-else-if="data">
      <template v-if="!isPhoneWidth">
        <div class="bs-analytics-page__charts">
          <Card title="Tokens per day">
            <template #action>
              <PeriodSwitch
                :model-value="stackBy"
                :options="[
                  { value: 'role', label: 'By role' },
                  { value: 'modelTier', label: 'By model tier' },
                ]"
                label="Stack by"
                @update:model-value="(v) => (stackBy = v as 'role' | 'modelTier')"
              />
            </template>
            <EmptyState
              v-if="canClaimEmpty(!!data, dailyBars.length)"
              :icon="Coins"
              title="No token usage recorded yet."
              body="Nothing has run in this period yet."
            />
            <BarChart
              v-else
              stacked
              legend
              hide-empty-track
              :stacked-bars="dailyBars"
              :series="dailySeries"
              :bars="[]"
              label="Tokens per day"
              :takeaway="dailyTakeaway"
            />
            <p v-if="dailyNotMeasuredCaption" class="bs-analytics-page__chart-caption">
              {{ dailyNotMeasuredCaption }}
            </p>
          </Card>

          <Card title="Total tokens, by selected period">
            <EmptyState
              v-if="canClaimEmpty(!!data, totalsBarRows.length)"
              :icon="Coins"
              title="No token usage recorded yet."
              body="Nothing has run in this period yet."
            />
            <div v-else class="bs-chart">
              <p class="bs-chart__takeaway">{{ totalsTakeaway }}</p>
              <div class="bs-analytics-page__hbars" role="img" :aria-label="totalsSummary">
                <div
                  v-for="row in totalsBarRows"
                  :key="row.label"
                  class="bs-analytics-page__hrow"
                >
                  <span class="bs-analytics-page__hlabel">{{ row.label }}</span>
                  <span class="bs-analytics-page__htrack">
                    <span
                      class="bs-analytics-page__hbar"
                      :style="{ width: `${row.pct}%`, background: row.tone }"
                    />
                  </span>
                </div>
                <div v-if="totalsNotMeasuredCaption" class="bs-analytics-page__hrow">
                  <span class="bs-analytics-page__hlabel">Not measured</span>
                  <span class="bs-analytics-page__htrack">
                    <span
                      class="bs-analytics-page__hbar bs-analytics-page__hbar--not-measured"
                      :style="{ width: `${totalsNotMeasured.pct}%` }"
                    />
                  </span>
                </div>
              </div>
              <table class="sr-only">
                <caption>Total tokens, by selected period</caption>
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col">Value</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in totalsBarRows" :key="row.label">
                    <td>{{ row.label }}</td>
                    <td>{{ row.value }}</td>
                  </tr>
                  <tr v-if="totalsNotMeasuredCaption">
                    <td>Not measured</td>
                    <td>{{ totalsNotMeasured.unmeasured }} of {{ totalsNotMeasured.total }} runs</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <Card v-if="breakdownRows.length > 0" title="Tokens by role and model tier">
          <Table :columns="breakdownColumns" :rows="breakdownRows" compact />
        </Card>

        <p class="bs-analytics-page__note">
          Cost is counted in tokens, never in dollars. A run whose tokens were not measured
          shows as its own "Not measured" share, counted, never dropped, and never shown as 0.
        </p>
      </template>

      <div v-if="!isPhoneWidth" class="bs-analytics-page__metrics">
        <Card title="Tokens per task">
          <template #action>
            <IconButton
              :icon="Info"
              label="Median tokens one task used, all roles and attempts, over the selected period"
              size="sm"
            />
          </template>
          <div class="bs-analytics-page__metric-value">
            <CompactNumber v-if="avgCostPerTask !== null" :value="avgCostPerTask" unit="tok" />
            <span v-else>Not enough data yet</span>
          </div>
          <p class="bs-analytics-page__metric-takeaway">
            {{ ratioTakeaway(ratio) }}
          </p>
        </Card>

        <Card title="Repeated mistakes after a lesson">
          <div class="bs-analytics-page__metric-value">{{ rateDisplay(sameMistakeDisplay) }}</div>
          <p v-if="sameMistakeDisplay === null" class="bs-analytics-page__metric-takeaway">
            Needs more settled rechecks.
          </p>
        </Card>

        <Card title="Fixes that held on recheck">
          <div class="bs-analytics-page__metric-value">{{ rateDisplay(recheckDisplay) }}</div>
          <p v-if="recheckDisplay === null" class="bs-analytics-page__metric-takeaway">
            Same rule as above.
          </p>
        </Card>

        <Card title="Second-opinion reviewers">
          <template #action>
            <IconButton
              :icon="Info"
              label="Share of reviews where a second reviewer on another model agreed with the first"
              size="sm"
            />
          </template>
          <div class="bs-analytics-page__metric-value">
            <ProgressRing
              :value="secondOpinionPct"
              :max="100"
              kind="ratio"
              :label="`${secondOpinionPct}% of second-opinion reviews agreed with the main reviewer`"
            />
          </div>
          <p class="bs-analytics-page__metric-takeaway">{{ secondOpinionTakeaway(secondOpinion) }}</p>
        </Card>
      </div>

      <template v-else>
        <div class="bs-analytics-page__phone-metrics">
          <div class="bs-analytics-page__phone-stat">
            <span class="bs-analytics-page__phone-stat-label">Tokens per task</span>
            <span class="bs-analytics-page__phone-stat-value">
              <CompactNumber v-if="avgCostPerTask !== null" :value="avgCostPerTask" unit="tok" />
              <span v-else>Not enough data yet</span>
            </span>
          </div>
          <div class="bs-analytics-page__phone-stat">
            <span class="bs-analytics-page__phone-stat-label">Second-opinion agreed</span>
            <span class="bs-analytics-page__phone-stat-value">
              <ProgressRing
                :value="secondOpinionPct"
                :max="100"
                kind="ratio"
                :label="`${secondOpinionPct}% agreed with the main reviewer`"
              />
            </span>
          </div>
          <div class="bs-analytics-page__phone-stat">
            <span class="bs-analytics-page__phone-stat-label">Repeated mistakes</span>
            <span class="bs-analytics-page__phone-stat-value">{{ rateDisplay(sameMistakeDisplay) }}</span>
          </div>
          <div class="bs-analytics-page__phone-stat">
            <span class="bs-analytics-page__phone-stat-label">Fixes that held</span>
            <span class="bs-analytics-page__phone-stat-value">{{ rateDisplay(recheckDisplay) }}</span>
          </div>
        </div>

        <div
          v-if="phoneRoleBars.length > 0 || phoneNotMeasuredLabel"
          class="bs-analytics-page__phone-roles"
          role="list"
          aria-label="Tokens by role, selected period"
        >
          <div
            v-for="bar in phoneRoleBars"
            :key="bar.label"
            role="listitem"
            class="bs-analytics-page__phone-role"
          >
            <span class="bs-analytics-page__phone-role-label">{{ bar.label }}</span>
            <ProgressBarMini :value="bar.pct" :label="`${bar.label} ${bar.pct}% of tokens`" />
          </div>
          <div
            v-if="phoneNotMeasuredLabel"
            role="listitem"
            class="bs-analytics-page__phone-role"
          >
            <span class="bs-analytics-page__phone-role-label">
              <span>Not measured</span>
              <span class="bs-analytics-page__phone-role-unit">of runs</span>
            </span>
            <ProgressBarMini :value="phoneNotMeasured.pct" :label="`Not measured ${phoneNotMeasuredLabel}`" />
          </div>
        </div>
      </template>

      <Card
        v-if="!isPhoneWidth && hasMultipleProviders(costBuckets)"
        title="Cost per task by provider"
      >
        <EmptyState
          v-if="canClaimEmpty(!!data, costByProviderData.length)"
          :icon="Coins"
          title="No task results yet."
          body="No usage has been recorded yet."
        />
        <BarChart
          v-else
          :bars="costByProviderData"
          :format="(v: number) => String(v)"
          label="Tokens per task by provider"
          takeaway="Tokens per task by provider."
        />
      </Card>
    </template>
  </div>
</template>
