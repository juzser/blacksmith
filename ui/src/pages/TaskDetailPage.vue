<script setup lang="ts">
// Task detail — design-spec.md §5.5. Tabs Overview/Findings/Artifacts/
// History; waiver UI exactly per spec: Waive/Deny only on S3+confirmed+
// unwaived, Popover confirm naming the fingerprint, Toast, race guard.
import { onMounted, ref } from 'vue';
import Banner from '../components/ds/Banner.vue';
import Button from '../components/ds/Button.vue';
import Card from '../components/ds/Card.vue';
import Dialog from '../components/ds/Dialog.vue';
import EmptyState from '../components/ds/EmptyState.vue';
import Lozenge from '../components/ds/Lozenge.vue';
import PageHeader from '../components/ds/PageHeader.vue';
import Popover from '../components/ds/Popover.vue';
import RowList from '../components/ds/RowList.vue';
import Skeleton from '../components/ds/Skeleton.vue';
import Table from '../components/ds/Table.vue';
import Tabs from '../components/ds/Tabs.vue';
import TwoColumn from '../components/ds/TwoColumn.vue';
import IdentityChip from '../components/IdentityChip.vue';
import TimelineRow from '../components/TimelineRow.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useToast } from '../composables/useToast.js';
import {
  applyWaiverBatch,
  fetchTaskDetail,
  fetchTimeline,
  type TaskDetail,
  type TimelineEntry,
} from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import {
  agentStatusTone,
  findingStatusTone,
  severityTone,
  taskStatusTone,
} from '../lib/taxonomy.js';
import { isWaivable } from '../lib/waivable.js';

const props = defineProps<{ taskId: string }>();
const { setBreadcrumb } = useBreadcrumb();
const { show: showToast } = useToast();

const detail = ref<TaskDetail | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
const activeTab = ref('overview');
const history = ref<TimelineEntry[]>([]);
const historyLoading = ref(true);
// The History tab fetches separately from the task itself, so it needs its own
// error too: without one the tab fell through to "No events recorded for this
// task." and told the operator the factory recorded nothing (D-224).
const historyError = ref<string | null>(null);

async function load() {
  error.value = null;
  // Only while there is nothing on screen to keep. design-spec.md §8 gives
  // this page manual refresh precisely so a list does not re-sort under the
  // operator's cursor -- so a refresh that swaps the whole page for a
  // skeleton is worse than the re-sort it was meant to avoid. Here it also
  // takes the Refresh button down with it, since the PageHeader lives inside
  // `v-else-if="detail"`. A retry after a failed fetch still gets its
  // skeleton, because there the page really is empty (D-243).
  loading.value = detail.value === null;
  try {
    detail.value = await fetchTaskDetail(props.taskId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
async function loadHistory() {
  // Same rule as load() above (D-243).
  historyLoading.value = history.value.length === 0;
  historyError.value = null;
  try {
    history.value = await fetchTimeline({ task: props.taskId });
  } catch (e) {
    historyError.value = e instanceof Error ? e.message : String(e);
  } finally {
    historyLoading.value = false;
  }
}
/** §8's manual refresh: the task and its history both go stale (D-243). */
function refresh() {
  void load();
  void loadHistory();
}

onMounted(() => {
  // Before the fetch, never after it. The crumb states where the operator is
  // standing, and the route settled that on its own -- so it must not wait on
  // an answer that may never come. Set inside load()'s try it survived only the
  // success path, leaving the previous page's trail above a failed task and, on
  // the way in, above the skeleton too (D-230). SessionsPage says the same
  // thing about its own project switch.
  setBreadcrumb([{ label: 'Kanban', to: '/kanban' }, { label: props.taskId }]);
  load();
  loadHistory();
});

// Waiver mutation race guard (ux-conventions.md §3): disable + `if (saving) return`.
const saving = ref<string | null>(null); // fingerprint currently in flight, or null
const openPopover = ref<string | null>(null); // fingerprint whose Popover is open

// Delegated, not inlined. This used to read `S3-minor && confirmed`, which
// is narrower than the predicate the Overview banner counts with
// (queries.ts: S3-minor|S4-nit x raised|confirmed) and narrower than what
// applyBatch() accepts (waivers.ts). The banner therefore counted S4-nits
// and not-yet-confirmed S3s as "waivers pending" and then sent the operator
// to a page with no control for them -- a number you cannot act on, which is
// worse than no number. One predicate now, pinned by ui/test/waivable.test.ts.
function canWaive(f: TaskDetail['findings'][number]): boolean {
  return isWaivable(f);
}

async function decide(fingerprint: string, decision: 'granted' | 'denied') {
  if (saving.value) return;
  if (!detail.value) return;
  saving.value = fingerprint;
  openPopover.value = null;
  try {
    await applyWaiverBatch(detail.value.task.sessionId, [
      {
        fingerprint,
        decision,
        operatorNote: `${decision === 'granted' ? 'Waived' : 'Denied'} via Task detail`,
      },
    ]);
    showToast(decision === 'granted' ? 'Waived 1 finding.' : 'Denied 1 waiver.');
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = null;
  }
}

const lightboxSrc = ref<string | null>(null);
const tabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'findings', label: 'Findings' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'history', label: 'History' },
];

const findingColumns = [
  { key: 'findingCategory', label: 'Category' },
  { key: 'severity', label: 'Severity' },
  { key: 'findingStatus', label: 'Status' },
  { key: 'summary', label: 'Summary' },
];

// Operator directive 5 (Phase 6b round 3): same combined "role · tier"
// IdentityChip label as Kanban's TaskCard (directive 2) — hashed on role
// only, so the same agent role gets the same accent everywhere it appears.
function agentChipLabel(role: string, modelTier: string | null): string {
  return modelTier ? `${role} · ${modelTier}` : role;
}
</script>

<template>
  <div class="app-page">
    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>
    <Skeleton v-if="loading" height="240" />

    <template v-else-if="detail">
      <PageHeader :title="detail.task.objective || detail.task.taskId">
        <template #status>
          <Lozenge :tone="taskStatusTone(detail.task.taskStatus)">{{ detail.task.taskStatus }}</Lozenge>
        </template>
        <template #actions>
          <Lozenge v-if="detail.branch" variant="outline">{{ detail.branch }}</Lozenge>
          <Button variant="ghost" size="sm" icon="refresh-cw" @click="refresh">Refresh</Button>
        </template>
      </PageHeader>

      <TwoColumn>
        <Tabs v-model="activeTab" :tabs="tabs" aria-label="Task detail sections">
          <template #overview>
            <!-- ds-allow-hardcode:start — 320px is a flex-wrap breakpoint
                 for these two Cards (not a spacing/sizing design token):
                 below that width each Card drops to its own row. -->
            <div style="display: flex; gap: var(--ds-space-6); flex-wrap: wrap">
              <Card title="Spec contract" style="flex: 2; min-width: 320px">
                <dl style="display: grid; grid-template-columns: auto 1fr; gap: var(--ds-space-2) var(--ds-space-4); margin: 0">
                  <dt style="color: var(--ds-text-subtlest)">Case</dt>
                  <dd><IdentityChip v-if="detail.task.caseTag" :id="detail.task.caseTag" /></dd>
                  <dt style="color: var(--ds-text-subtlest)">Origin</dt>
                  <dd><Lozenge v-if="detail.task.origin" variant="outline">{{ detail.task.origin }}</Lozenge></dd>
                  <dt style="color: var(--ds-text-subtlest)">Epic</dt>
                  <dd>{{ detail.task.epicId ?? '-' }}</dd>
                  <dt style="color: var(--ds-text-subtlest)">Plan version</dt>
                  <dd>{{ detail.task.planVersion ?? '-' }}</dd>
                  <dt style="color: var(--ds-text-subtlest)">Claims</dt>
                  <dd>
                    <span v-for="c in detail.claims" :key="c" style="font-family: var(--ds-font-mono); font-size: var(--ds-text-xs); margin-right: var(--ds-space-2)">{{ c }}</span>
                    <span v-if="detail.claims.length === 0">-</span>
                  </dd>
                </dl>
              </Card>
              <Card title="Attempts" style="flex: 3; min-width: 320px">
                <RowList v-if="detail.attempts.length > 0">
                  <li v-for="a in detail.attempts" :key="a.eventId" class="ds-row">
                    <span class="ds-row__main">
                      <span class="ds-row__title">{{ a.agentRole }} · {{ a.modelTier }}/{{ a.provider }}</span>
                      <span class="ds-row__meta">
                        started {{ formatDateTime(a.ts) }}<template v-if="a.terminalAt"> · ended {{ formatDateTime(a.terminalAt) }}</template>
                      </span>
                    </span>
                    <span class="ds-row__trail">
                      <IdentityChip :id="a.agentRole" :label="agentChipLabel(a.agentRole, a.modelTier)" />
                      <Lozenge v-if="a.agentStatus" :tone="agentStatusTone(a.agentStatus)">{{ a.agentStatus }}</Lozenge>
                    </span>
                  </li>
                </RowList>
                <EmptyState v-else icon="bot" inline>No dispatch attempts yet.</EmptyState>
              </Card>
            </div>
            <!-- ds-allow-hardcode:end -->
          </template>

          <template #findings>
          <Table
            :columns="findingColumns"
            :rows="detail.findings"
            row-key="findingId"
            empty="No findings recorded for this task."
          >
            <template #cell="{ column, row }">
              <Lozenge v-if="column.key === 'severity'" :tone="severityTone(String(row.severity)).tone" :variant="severityTone(String(row.severity)).variant">{{ row.severity }}</Lozenge>
              <Lozenge v-else-if="column.key === 'findingStatus'" :tone="findingStatusTone(String(row.findingStatus))">{{ row.findingStatus }}</Lozenge>
              <template v-else-if="column.key === 'summary'">
                <div>{{ row.summary }}</div>
                <div v-if="canWaive(row as never)" style="margin-top: var(--ds-space-2); display: flex; gap: var(--ds-space-2)">
                  <Popover label="Waive finding" :open="openPopover === (row as never as { fingerprint: string }).fingerprint" @close="openPopover = null">
                    <template #trigger>
                      <Button
                        variant="outline"
                        size="xs"
                        :disabled="saving === (row as never as { fingerprint: string }).fingerprint"
                        @click="openPopover = (row as never as { fingerprint: string }).fingerprint"
                      >
                        Waive
                      </Button>
                    </template>
                    <p style="font-size: var(--ds-text-sm)">Waive finding <code>{{ (row as never as { fingerprint: string }).fingerprint }}</code>? This can't be asked again.</p>
                    <Button variant="outline" size="sm" @click="decide((row as never as { fingerprint: string }).fingerprint, 'granted')">Confirm</Button>
                  </Popover>
                  <Button
                    variant="secondary"
                    size="xs"
                    :disabled="saving === (row as never as { fingerprint: string }).fingerprint"
                    @click="decide((row as never as { fingerprint: string }).fingerprint, 'denied')"
                  >
                    Deny
                  </Button>
                </div>
              </template>
              <template v-else>{{ row[column.key] }}</template>
            </template>
          </Table>
        </template>

        <template #artifacts>
          <div v-if="detail.artifacts.length > 0" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: var(--ds-space-3)">
            <button
              v-for="a in detail.artifacts"
              :key="a.id"
              type="button"
              style="border: 1px solid var(--ds-border); border-radius: var(--ds-radius-lg); padding: var(--ds-space-2); background: var(--ds-surface-raised); cursor: pointer; text-align: left; font-size: var(--ds-text-xs)"
              @click="a.type === 'screenshot' ? (lightboxSrc = a.path) : undefined"
            >
              {{ a.type }}: {{ a.path }}
            </button>
          </div>
          <EmptyState v-else icon="image">No artifacts recorded.</EmptyState>
          <Dialog :open="!!lightboxSrc" title="Artifact preview" @close="lightboxSrc = null">
            <img v-if="lightboxSrc" :src="lightboxSrc" alt="Artifact preview" style="max-width: 100%" />
          </Dialog>
        </template>

        <template #history>
          <Skeleton v-if="historyLoading" height="160" />
          <!-- Ahead of the empty state on purpose. A failed fetch has no
               events to show either, and the two are only distinguishable
               here -- past this point they render identically. -->
          <Banner v-else-if="historyError" tone="danger" show-retry @retry="loadHistory">
            {{ historyError }}
          </Banner>
          <div v-else-if="history.length > 0">
            <TimelineRow
              v-for="e in history"
              :key="e.eventId"
              :entry="e"
              :has-children="false"
              :expanded="false"
              :selectable="false"
            />
          </div>
          <EmptyState v-else icon="history" inline>No events recorded for this task.</EmptyState>
        </template>
        </Tabs>

        <template #rail>
          <Card title="Details">
            <dl style="display: grid; grid-template-columns: auto 1fr; gap: var(--ds-space-2) var(--ds-space-3); margin: 0; font-size: var(--ds-text-sm)">
              <dt style="color: var(--ds-text-subtlest)">Task ID</dt>
              <dd style="font-family: var(--ds-font-mono); font-size: var(--ds-text-xs)">{{ detail.task.taskId }}</dd>
              <dt style="color: var(--ds-text-subtlest)">Epic</dt>
              <dd>{{ detail.task.epicId ?? '-' }}</dd>
              <dt style="color: var(--ds-text-subtlest)">Plan version</dt>
              <dd>{{ detail.task.planVersion ?? '-' }}</dd>
              <dt style="color: var(--ds-text-subtlest)">Status</dt>
              <dd><Lozenge :tone="taskStatusTone(detail.task.taskStatus)">{{ detail.task.taskStatus }}</Lozenge></dd>
              <dt style="color: var(--ds-text-subtlest)">Origin</dt>
              <dd><Lozenge v-if="detail.task.origin" variant="outline">{{ detail.task.origin }}</Lozenge></dd>
              <dt style="color: var(--ds-text-subtlest)">Case</dt>
              <dd><IdentityChip v-if="detail.task.caseTag" :id="detail.task.caseTag" /></dd>
            </dl>
          </Card>
          <Card title="Agents">
            <RowList v-if="detail.agents.length > 0" density="compact">
              <li v-for="a in detail.agents" :key="a.id" class="ds-row">
                <span class="ds-row__main">
                  <IdentityChip :id="a.agentRole" :label="agentChipLabel(a.agentRole, a.modelTier)" />
                  <span class="ds-row__meta">{{ a.provider }}</span>
                </span>
                <span class="ds-row__trail">
                  <Lozenge :tone="agentStatusTone(a.status)">{{ a.status }}</Lozenge>
                </span>
              </li>
            </RowList>
            <EmptyState v-else icon="bot" inline>No agents dispatched yet.</EmptyState>
          </Card>
        </template>
      </TwoColumn>
    </template>
  </div>
</template>
