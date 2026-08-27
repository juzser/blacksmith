<script setup lang="ts">
// Analytics — design-spec.md §5.8. MetricGrid + 3 charts + rail cards.
import { computed, onMounted, ref, watch } from 'vue';
import Banner from '../components/hds/Banner.vue';
import BarChart from '../components/hds/BarChart.vue';
import Button from '../components/hds/Button.vue';
import Card from '../components/hds/Card.vue';
import EmptyState from '../components/hds/EmptyState.vue';
import LineChart from '../components/hds/LineChart.vue';
import MetricGrid from '../components/hds/MetricGrid.vue';
import PageHeader from '../components/hds/PageHeader.vue';
import RowList from '../components/hds/RowList.vue';
import Skeleton from '../components/hds/Skeleton.vue';
import StatCard from '../components/hds/StatCard.vue';
import TwoColumn from '../components/hds/TwoColumn.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import {
  costPerTask,
  costPerTaskBy,
  formatRate,
  formatTokens,
  latestSameMistakeRate,
  quorumRows,
  recheckPassRate,
} from '../lib/analytics.js';
import { type AnalyticsResult, fetchAnalytics } from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';

const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Analytics' }]);
const { project } = useProjectContext();

const data = ref<AnalyticsResult | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);

async function load() {
  error.value = null;
  // Only while there is nothing on screen to keep. design-spec.md §8 gives
  // this page manual refresh precisely so a list does not re-sort under the
  // operator's cursor -- so a refresh that swaps the whole page for a
  // skeleton is worse than the re-sort it was meant to avoid. TimelinePage
  // and KanbanPage already read this way; a retry after a failed fetch still
  // gets its skeleton, because there the page really is empty (D-243).
  loading.value = data.value === null;
  try {
    data.value = await fetchAnalytics(undefined, project.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(project, load);

const throughputTotal = computed(() =>
  (data.value?.throughput ?? []).reduce((s, d) => s + d.completed, 0),
);
const costBuckets = computed(() => data.value?.costByModelTierAndProvider ?? []);
const avgCostPerTask = computed(() => costPerTask(costBuckets.value));
const avgCostHint = computed(() =>
  avgCostPerTask.value === null ? 'no usage recorded' : 'avg tokens',
);
const sameMistakeValue = computed(() =>
  formatRate(latestSameMistakeRate(data.value?.sameMistakeRateByDay ?? [])),
);
const recheckPass = computed(() => recheckPassRate(data.value?.recheckOutcomes ?? []));
const recheckPassHint = computed(() =>
  recheckPass.value.settled > 0
    ? `${recheckPass.value.passed} of ${recheckPass.value.settled} settled`
    : 'none settled yet',
);

// The API buckets cost by the (tier, provider) pair; each card charts one of
// those dimensions, so both series have to be rolled up first (D-221).
const costByTierData = computed(() => costPerTaskBy(costBuckets.value, 'modelTier'));
const costByProviderData = computed(() => costPerTaskBy(costBuckets.value, 'provider'));
// The cross-check quorum lines. Every string on them is built in the lib, so
// the card's one claim an operator acts on -- whether a provider agreed --
// stays inside the layer tsc and vitest actually read (D-255).
const quorum = computed(() => quorumRows(data.value?.providerAgreement ?? []));
const throughputLine = computed(() =>
  (data.value?.throughput ?? []).map((d) => ({ label: d.day, value: d.completed })),
);
</script>

<template>
  <div class="app-page">
    <PageHeader title="Analytics">
      <template #actions>
        <Button variant="ghost" size="sm" icon="refresh-cw" @click="load">Refresh</Button>
      </template>
    </PageHeader>

    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>

    <MetricGrid :columns="4">
      <template v-if="loading">
        <Skeleton v-for="i in 4" :key="i" height="112" />
      </template>
      <template v-else-if="data">
        <StatCard label="Throughput" :value="throughputTotal" icon="bar-chart-3" tint="mint" hint="tasks completed" />
        <StatCard
          label="Cost per task"
          :value="formatTokens(avgCostPerTask)"
          icon="coins"
          tint="amber"
          :hint="avgCostHint"
        />
        <StatCard label="Same-mistake rate" :value="sameMistakeValue" icon="triangle-alert" tint="rose" hint="latest day" />
        <StatCard
          label="Recheck pass rate"
          :value="formatRate(recheckPass.rate)"
          icon="shield-check"
          tint="blue"
          :hint="recheckPassHint"
        />
      </template>
    </MetricGrid>

    <TwoColumn v-if="!loading && data">
      <Card title="Cost per task by model tier">
        <EmptyState v-if="canClaimEmpty(!!data, costByTierData.length)" icon="bar-chart-3" inline>No task results yet.</EmptyState>
        <BarChart v-else :bars="costByTierData" label="Tokens per task by model tier" />
      </Card>
      <Card title="Cost per task by provider">
        <EmptyState v-if="canClaimEmpty(!!data, costByProviderData.length)" icon="bar-chart-3" inline>No task results yet.</EmptyState>
        <BarChart v-else :bars="costByProviderData" label="Tokens per task by provider" />
      </Card>
      <Card title="Throughput trend">
        <EmptyState v-if="canClaimEmpty(!!data, throughputLine.length)" icon="line-chart" inline>No completed tasks yet.</EmptyState>
        <LineChart v-else :points="throughputLine" label="Tasks completed per day" />
      </Card>

      <template #rail>
        <Card title="Recheck outcomes">
          <RowList v-if="data.recheckOutcomes.length > 0" density="compact">
            <li v-for="r in data.recheckOutcomes" :key="r.taskStatus" class="hds-row">
              <span class="hds-row__main">
                <span class="hds-row__title">{{ r.taskStatus }}</span>
                <span class="hds-row__meta">{{ r.count }}</span>
              </span>
            </li>
          </RowList>
          <EmptyState v-else icon="rotate-cw" inline>No rechecks yet.</EmptyState>
        </Card>
        <Card title="Cross-check quorum">
          <RowList v-if="quorum.length > 0" density="compact">
            <li v-for="q in quorum" :key="q.provider" class="hds-row">
              <span class="hds-row__main">
                <span class="hds-row__title">{{ q.provider }}</span>
                <span class="hds-row__meta">{{ q.answered }}<template v-if="q.latency"> · {{ q.latency }}</template></span>
                <span v-for="f in q.failures" :key="f" class="hds-row__meta">{{ f }}</span>
              </span>
              <span class="hds-row__trail">{{ q.agreement }}</span>
            </li>
          </RowList>
          <EmptyState v-else icon="scale" inline>No cross-check judges have run.</EmptyState>
        </Card>
      </template>
    </TwoColumn>
  </div>
</template>
