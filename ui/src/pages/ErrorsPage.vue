<script setup lang="ts">
// Errors — design-spec.md §5.7. LineChart errors/day 30d + BarChart by
// group (8-cap) + provider-disagreement RowList + log table with detail
// Dialog, cursor Load more (client-side page-through — errorsPage() has no
// server cursor yet, flagged in ui/docs/DESIGN.md).
import { computed, onMounted, ref, watch } from 'vue';
import Banner from '../components/ds/Banner.vue';
import BarChart from '../components/ds/BarChart.vue';
import Button from '../components/ds/Button.vue';
import Card from '../components/ds/Card.vue';
import Dialog from '../components/ds/Dialog.vue';
import EmptyState from '../components/ds/EmptyState.vue';
import Icon from '../components/ds/Icon.vue';
import LineChart from '../components/ds/LineChart.vue';
import Lozenge from '../components/ds/Lozenge.vue';
import PageHeader from '../components/ds/PageHeader.vue';
import RowList from '../components/ds/RowList.vue';
import Skeleton from '../components/ds/Skeleton.vue';
import Table from '../components/ds/Table.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { type ErrorsResult, fetchErrors } from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { errorGroupIcon, severityTone } from '../lib/taxonomy.js';

const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Errors' }]);
const { project } = useProjectContext();

const data = ref<ErrorsResult | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
const visibleCount = ref(20);

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
    data.value = await fetchErrors(undefined, project.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(project, load);

/** The fetch's own verdict. `!loading` is not it: loading goes false on failure too. */
const loaded = computed(() => data.value !== null);

const lineData = computed(() =>
  (data.value?.byDay ?? []).map((d) => ({ label: d.day, value: d.count })),
);
const barData = computed(() =>
  (data.value?.byClass ?? [])
    .reduce<{ label: string; value: number }[]>((acc, c) => {
      const existing = acc.find((a) => a.label === c.errorGroup);
      if (existing) existing.value += c.count;
      else acc.push({ label: c.errorGroup, value: c.count });
      return acc;
    }, [])
    .sort((a, b) => b.value - a.value),
);
const rows = computed(() => (data.value?.byClass ?? []).slice(0, visibleCount.value));
const providerDisagreement = computed(() =>
  (data.value?.byClass ?? []).filter(
    (c) => c.errorGroup === 'judgment' && c.errorClass === 'provider-disagreement',
  ),
);

const detailRow = ref<ErrorsResult['byClass'][number] | null>(null);
const columns = [
  { key: 'errorGroup', label: 'Group · Class' },
  { key: 'severity', label: 'Severity' },
  { key: 'count', label: 'Count', numeric: true },
];
</script>

<template>
  <div class="app-page">
    <PageHeader title="Errors">
      <template #actions>
        <Button variant="ghost" size="sm" icon="refresh-cw" @click="load">Refresh</Button>
      </template>
    </PageHeader>

    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--ds-space-4)">
      <Card title="Errors over time">
        <Skeleton v-if="loading" height="200" />
        <EmptyState v-else-if="canClaimEmpty(loaded, lineData.length)" icon="line-chart" inline>No errors logged yet.</EmptyState>
        <LineChart v-else-if="loaded" :points="lineData" label="Errors per day, last 30 days" />
      </Card>
      <Card title="By group">
        <Skeleton v-if="loading" height="200" />
        <EmptyState v-else-if="canClaimEmpty(loaded, barData.length)" icon="bar-chart-3" inline>No errors logged yet.</EmptyState>
        <BarChart v-else-if="loaded" :bars="barData" label="Errors by group" />
      </Card>
    </div>

    <Card title="Provider disagreement">
      <Skeleton v-if="loading" height="80" />
      <EmptyState v-else-if="canClaimEmpty(loaded, providerDisagreement.length)" icon="scale" inline>No provider disagreements logged.</EmptyState>
      <RowList v-else-if="loaded" density="compact">
        <li v-for="c in providerDisagreement" :key="`${c.errorGroup}.${c.errorClass}`" class="ds-row">
          <span class="ds-row__main">
            <span class="ds-row__title">judgment · provider-disagreement</span>
            <span class="ds-row__meta">{{ c.count }} occurrences</span>
          </span>
        </li>
      </RowList>
    </Card>

    <Card title="Error log" :padded="false">
      <Skeleton v-if="loading" height="200" />
      <!-- A table with headers and no rows reads as "no errors", so it is a
           claim too, and it waits for the fetch like the rest of them. -->
      <Table
        v-else-if="loaded"
        :columns="columns"
        :rows="rows"
        row-key="id"
        clickable
        @row-click="(row) => (detailRow = row as never)"
      >
        <template #cell="{ column, row }">
          <div v-if="column.key === 'errorGroup'" style="display: flex; align-items: center; gap: var(--ds-space-1-5)">
            <Icon :name="errorGroupIcon(String(row.errorGroup))" :size="14" aria-hidden="true" style="color: var(--ds-text-subtlest)" />
            <span>{{ row.errorGroup }} · {{ row.errorClass }}</span>
          </div>
          <Lozenge v-else-if="column.key === 'severity'" :tone="severityTone(String(row.severity)).tone" :variant="severityTone(String(row.severity)).variant">{{ row.severity }}</Lozenge>
          <template v-else>{{ row[column.key] }}</template>
        </template>
      </Table>
      <div v-if="!loading && (data?.byClass.length ?? 0) > visibleCount" style="padding: var(--ds-space-3); display: flex; justify-content: center">
        <Button variant="ghost" size="sm" @click="visibleCount += 20">Load more</Button>
      </div>
    </Card>

    <Dialog :open="!!detailRow" title="Error detail" @close="detailRow = null">
      <pre v-if="detailRow" style="background: var(--ds-surface-sunken); padding: var(--ds-space-3); border-radius: var(--ds-radius-control); font-family: var(--ds-font-mono); font-size: var(--ds-text-xs); overflow-x: auto">{{ JSON.stringify(detailRow, null, 2) }}</pre>
    </Dialog>
  </div>
</template>
