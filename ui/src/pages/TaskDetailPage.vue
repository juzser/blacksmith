<script setup lang="ts">
// Task detail — DS3 §4.7, rebuilt on the kit. Tabs "What was asked" (the
// RequestQuote + a compact facts row + the files this task may change,
// with branch/origin/epic behind a "Technical details" disclosure)/
// Findings/Outputs/History (run history timeline, then the event list).
// Waiver UI exactly per spec: Waive/Deny only on S3+confirmed+unwaived,
// Popover confirm naming the fingerprint, Toast, race guard — unchanged
// from the ds/ build, just re-skinned onto kit/Popover + kit/Button.
//
// Deviations from §4.7 (no backing data, rendered absent per the brief):
// - No per-agent summary table: `agents-registry` rows (role/provider/tier/
//   status) stay a plain rail list, same shape as before, not a new Table.
//   Each row's status is an AgentStatusBadge, the Sessions page's own
//   mapping: the store never closes an agent that sent no result, so its
//   raw `live` would read as working days later.
//
// DS6 PR4: the pattern-11 totals bar above RunHistoryTimeline now renders
// from `/api/tasks/:id/runs`' `totals` (queries.ts `taskTotals()`). A field
// stays absent, never "0"/"—", when its underlying runs carry nothing
// usable (no dispatch/result timestamps, no token_usage).
//
// Visual-pass items 2-4 (uiux-ds0-3-visual.md): the branch Tag sat beside
// the status like a second subtitle, the "Spec contract" dl card put raw
// metadata above the fold, and RunHistoryTimeline sat on the overview tab
// rather than the History tab it names. Branch/Origin/Epic now live behind
// a collapsed "Technical details" disclosure in the overview tab; the facts
// row and the files list take the dl card's place; RunHistoryTimeline opens
// the History tab, above the per-event TimelineRow list.
import {
  Bot,
  Clock,
  Coins,
  History as HistoryIcon,
  Image as ImageIcon,
  RefreshCw,
  Timer,
} from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import AgentChip from '../components/AgentChip.vue';
import AgentStatusBadge from '../components/kit/AgentStatusBadge.vue';
import Banner from '../components/kit/Banner.vue';
import Button from '../components/kit/Button.vue';
import Card from '../components/kit/Card.vue';
import CompactNumber from '../components/kit/CompactNumber.vue';
import Dialog from '../components/kit/Dialog.vue';
import EmptyState from '../components/kit/EmptyState.vue';
import Icon from '../components/kit/Icon.vue';
import PageHeader from '../components/kit/PageHeader.vue';
import Popover from '../components/kit/Popover.vue';
import Skeleton from '../components/kit/Skeleton.vue';
import Table from '../components/kit/Table.vue';
import Tabs from '../components/kit/Tabs.vue';
import Tag from '../components/kit/Tag.vue';
import TimelineRow from '../components/kit/TimelineRow.vue';
import Tooltip from '../components/kit/Tooltip.vue';
import RequestQuote from '../components/RequestQuote.vue';
import RunHistoryTimeline from '../components/RunHistoryTimeline.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { usePoll } from '../composables/usePoll.js';
import { useToast } from '../composables/useToast.js';
import { useViewport } from '../composables/useViewport.js';
import {
  applyWaiverBatch,
  fetchTaskDetail,
  fetchTaskRuns,
  fetchTimelinePage,
  type TaskDetail,
  type TaskRun,
  type TaskTotals,
} from '../lib/api.js';
import { loadExpanded, saveExpanded, toggleExpanded } from '../lib/expandedRows.js';
import { formatDurationMs, formatElapsedRange, parentLabel, shortTaskName } from '../lib/format.js';
import { titleCase } from '../lib/kanban.js';
import { roleLabel } from '../lib/roleLabels.js';
import { specRefLabel } from '../lib/specRef.js';
import { findingStatusKitTone, severityKitTone, taskStatusKitTone } from '../lib/taxonomy.js';
import { type ActivityEntry, groupByDay } from '../lib/timelineDisplay.js';
import { isWaivable } from '../lib/waivable.js';
import { waiverDenialNote } from '../lib/waiverDenialNote.js';

const props = defineProps<{ taskId: string; storeId?: string }>();
// Task detail and runs read the foreign store named by `?store=`. The reads
// below resolve ids in the served store only (history by task id, artifacts by
// artifact id, waivers by session id), so for a foreign task they stay empty
// or inert instead of showing another store's data.
const foreign = computed(() => props.storeId !== undefined);
const { setBreadcrumb } = useBreadcrumb();
const { show: showToast } = useToast();
const { isPhoneWidth } = useViewport();

const detail = ref<TaskDetail | null>(null);
// One naming function: a minted follow-up reads "Follow-up fix · <parent>" here
// as it does on its Kanban card.
const pageName = computed(() =>
  detail.value
    ? shortTaskName(
        detail.value.task.taskId,
        detail.value.task.title,
        parentLabel(detail.value.parentTaskId, detail.value.parentTaskTitle),
      )
    : '',
);
const error = ref<string | null>(null);
const loading = ref(true);
const activeTab = ref('overview');
const runs = ref<TaskRun[]>([]);
const totals = ref<TaskTotals | null>(null);
const history = ref<ActivityEntry[]>([]);
const historyLoading = ref(true);
// The History tab fetches separately from the task itself, so it needs its own
// error too: without one the tab fell through to "No events recorded for this
// task." and told the operator the factory recorded nothing (D-224).
const historyError = ref<string | null>(null);
// Item 3: day headers over the History tab's flat event list, same rule as
// Activity's CausalTimelineList — the list is already in the server's own
// newest-first order (`timeline()`'s paged mode, queries.ts; D-243 keeps
// this page from re-sorting under the operator), so grouping only
// partitions it into calendar days, it never reorders it: newest day first.
const historyDayGroups = computed(() => groupByDay(history.value, new Date().toISOString()));

// DS6 PR3: this tab now renders the same kit TimelineRow as Activity, so it
// shares the same sessionStorage-scoped "Show details" persistence
// (expandedRows.ts), keyed per task so two tasks' open rows don't collide.
const historyExpanded = ref<Set<string>>(new Set());
const historyStorageKey = computed(() => `task:${props.storeId ?? ''}:${props.taskId}`);
onMounted(() => {
  historyExpanded.value = loadExpanded(sessionStorage, historyStorageKey.value);
});
function toggleHistoryRow(eventId: string) {
  historyExpanded.value = toggleExpanded(historyExpanded.value, eventId);
  saveExpanded(sessionStorage, historyStorageKey.value, historyExpanded.value);
}
const historyPromptTsById = computed(() => new Map(history.value.map((e) => [e.eventId, e.ts])));
function historyCtxFor(entry: ActivityEntry) {
  const promptTs = entry.nearestPromptId
    ? (historyPromptTsById.value.get(entry.nearestPromptId) ?? null)
    : undefined;
  return { promptTs };
}

/** Pattern 11 totals bar cells — a field missing from `totals` is left out
 * of the array entirely, never rendered as "0" or "—" (ds-spec.md §4.7). */
const totalsCells = computed(() => {
  const t = totals.value;
  if (!t) return [];
  const cells: { key: string; icon: typeof Coins; label: string; value: string; exact: string }[] =
    [];
  if (t.tokens !== null) {
    cells.push({
      key: 'tokens',
      icon: Coins,
      label: 'Tokens',
      value: `${t.tokens}`,
      exact: `${t.tokens.toLocaleString()} tokens`,
    });
  }
  if (t.agentTimeMs !== null) {
    cells.push({
      key: 'agent-time',
      icon: Timer,
      label: 'Agent time',
      value: formatDurationMs(t.agentTimeMs),
      exact: `${Math.round(t.agentTimeMs / 1000).toLocaleString()}s of agent time`,
    });
  }
  if (t.elapsedMs !== null) {
    cells.push({
      key: 'elapsed',
      icon: Clock,
      label: 'Elapsed',
      value: formatDurationMs(t.elapsedMs),
      exact:
        t.startedAt !== null && t.endedAt !== null
          ? formatElapsedRange(t.startedAt, t.endedAt)
          : `${Math.round(t.elapsedMs / 1000).toLocaleString()}s elapsed`,
    });
  }
  return cells;
});

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
  const { taskId, storeId } = props;
  // An answer for a task the page has since left must not land on the new one.
  const stale = () => taskId !== props.taskId || storeId !== props.storeId;
  try {
    const [d, r] = await Promise.all([
      fetchTaskDetail(taskId, storeId),
      fetchTaskRuns(taskId, storeId),
    ]);
    if (stale()) return;
    detail.value = d;
    runs.value = r.runs;
    totals.value = r.totals;
  } catch (e) {
    if (!stale()) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (!stale()) loading.value = false;
  }
}
async function loadHistory() {
  if (foreign.value) {
    historyLoading.value = false;
    return;
  }
  // Same rule as load() above (D-243).
  historyLoading.value = history.value.length === 0;
  historyError.value = null;
  const { taskId, storeId } = props;
  const stale = () => taskId !== props.taskId || storeId !== props.storeId;
  try {
    const page = await fetchTimelinePage({ task: taskId, limit: 200 });
    if (!stale()) history.value = page.entries;
  } catch (e) {
    if (!stale()) historyError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (!stale()) historyLoading.value = false;
  }
}
/** §8's manual refresh: the task, its runs, and its history all go stale (D-243). */
function refresh() {
  void load();
  void loadHistory();
}

// Vue-router reuses this component when only the param or `?store=` changes,
// so nothing would remount it: drop what the old task showed and load the new
// one at once rather than at the next poll.
watch(
  () => [props.taskId, props.storeId],
  () => {
    detail.value = null;
    runs.value = [];
    totals.value = null;
    history.value = [];
    error.value = null;
    historyError.value = null;
    saving.value = null;
    openPopover.value = null;
    lightboxSrc.value = null;
    activeTab.value = 'overview';
    historyExpanded.value = loadExpanded(sessionStorage, historyStorageKey.value);
    setBreadcrumb([{ label: 'Work', to: '/work/kanban' }, { label: props.taskId }]);
    void load();
    void loadHistory();
  },
);

onMounted(() => {
  // Before the fetch, never after it. The crumb states where the operator is
  // standing, and the route settled that on its own -- so it must not wait on
  // an answer that may never come. Set inside load()'s try it survived only the
  // success path, leaving the previous page's trail above a failed task and, on
  // the way in, above the skeleton too (D-230). SessionsPage says the same
  // thing about its own project switch.
  setBreadcrumb([{ label: 'Work', to: '/work/kanban' }, { label: props.taskId }]);
  load();
  loadHistory();
});
// The page refreshes live: a task's screenshots should appear as soon as the
// task produces them, not only on a manual Refresh click.
usePoll(load, 15000);

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
  return !foreign.value && isWaivable(f);
}

async function decide(fingerprint: string, decision: 'granted' | 'denied') {
  if (saving.value) return;
  if (!detail.value) return;
  const { taskId, storeId } = props;
  // Once the page moves to another task, the old one's answer is not ours to show.
  const stale = () => taskId !== props.taskId || storeId !== props.storeId;
  saving.value = fingerprint;
  openPopover.value = null;
  try {
    const result = await applyWaiverBatch(detail.value.task.sessionId, [
      {
        fingerprint,
        decision,
        operatorNote: `${decision === 'granted' ? 'Waived' : 'Denied'} via Task detail`,
      },
    ]);
    showToast(
      decision === 'granted'
        ? 'Waived 1 finding.'
        : `Denied 1 waiver.${waiverDenialNote(result.findingIdsToCarry)}`,
    );
    if (!stale()) await load();
  } catch (e) {
    if (!stale()) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (!stale()) saving.value = null;
  }
}

const lightboxSrc = ref<string | null>(null);
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;
function isImageArtifact(a: TaskDetail['artifacts'][number]): boolean {
  return a.type === 'screenshot' || IMAGE_EXTENSIONS.test(a.path);
}
function artifactUrl(a: TaskDetail['artifacts'][number]): string {
  return `/api/artifacts/${encodeURIComponent(a.id)}`;
}
// `detail.value.artifacts` already comes back newest-first (`taskDetail()`'s
// `orderBy(desc(artifacts.ts), desc(artifacts.id))`, queries.ts) — a `filter`
// preserves that order, so neither list needs a sort of its own here.
const imageArtifacts = computed(() =>
  foreign.value ? [] : (detail.value?.artifacts.filter(isImageArtifact) ?? []),
);
const otherArtifacts = computed(() =>
  foreign.value ? [] : (detail.value?.artifacts.filter((a) => !isImageArtifact(a)) ?? []),
);
const tabs = [
  { id: 'overview', label: 'What was asked' },
  { id: 'findings', label: 'Findings' },
  { id: 'artifacts', label: 'Outputs' },
  { id: 'history', label: 'History' },
];

const findingColumns = [
  { key: 'findingCategory', label: 'Category' },
  { key: 'severity', label: 'Severity' },
  { key: 'findingStatus', label: 'Status' },
  { key: 'summary', label: 'Summary' },
];

// DS3 pattern 3 — the task's own current agent chip, same "last dispatch
// attempt" source as TaskPeekPanel.vue (item 2): `attempts` names who was
// last sent, `agentActivity` (item 1) separately says whether anyone is
// still on it.
const agentChipTask = computed(() => {
  if (!detail.value) return null;
  const latest = detail.value.attempts[detail.value.attempts.length - 1];
  if (!latest) return null;
  return {
    taskStatus: detail.value.task.taskStatus,
    agentRole: latest.agentRole,
    agentModelTier: latest.modelTier,
    agentActivity: detail.value.agentActivity,
    updatedAt: detail.value.task.updatedAt,
  };
});

// The heading is the task's short name; the objective (a paragraph) is always
// PageHeader's description under it, and can never equal the heading.
function objectiveDescription(objective: string | null): string | undefined {
  return objective?.trim() || undefined;
}

// Visual-pass item 4 (§4.7): the old "Spec contract" dl card read as raw
// data cruft above the fold. caseTag and planVersion are the two data
// points worth a glance before opening Technical details; either is
// independently optional (fixtures and real tasks both have tasks with no
// case tag yet), so each clause is dropped rather than shown as a "-"
// placeholder in an otherwise compact line.
const factsRowText = computed(() => {
  if (!detail.value) return '';
  const parts: string[] = [];
  if (detail.value.task.caseTag) parts.push(`Type: ${detail.value.task.caseTag}`);
  if (detail.value.task.planVersion != null) {
    parts.push(`Plan revision ${detail.value.task.planVersion}`);
  }
  return parts.join(' · ');
});
</script>

<template>
  <div class="app-page">
    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>
    <Skeleton v-if="loading" :height="240" />

    <template v-else-if="detail">
      <PageHeader
        :title="pageName"
        :description="objectiveDescription(detail.task.objective)"
        title-visible
      >
        <template #status>
          <Tag :tone="taskStatusKitTone(detail.task.taskStatus)" variant="subtle" size="sm">
            {{ titleCase(detail.task.taskStatus) }}
          </Tag>
          <AgentChip v-if="agentChipTask" :task="agentChipTask" />
        </template>
        <template #actions>
          <Button v-if="!isPhoneWidth" variant="ghost" size="sm" :icon="RefreshCw" @click="refresh">Refresh</Button>
        </template>
      </PageHeader>

      <div class="bs-task-detail__layout">
        <div>
          <Tabs v-model="activeTab" :tabs="tabs" aria-label="Task detail sections">
            <template #overview>
              <div class="bs-task-detail__overview">
                <p v-if="factsRowText" class="bs-task-detail__facts">{{ factsRowText }}</p>
                <RequestQuote :quote="detail.requestQuote" />
                <Card title="Files this task may change">
                  <ul v-if="detail.claims.length > 0" class="bs-task-detail__claim-list">
                    <li v-for="c in detail.claims" :key="c" class="bs-task-detail__claim">{{ c }}</li>
                  </ul>
                  <p v-else class="bs-task-detail__claim-empty">No files declared.</p>
                </Card>
                <details class="bs-task-detail__tech-details">
                  <summary>Technical details</summary>
                  <dl class="bs-task-detail__dl">
                    <dt>Branch</dt>
                    <dd class="bs-task-detail__mono">{{ detail.branch ?? '-' }}</dd>
                    <dt>Origin</dt>
                    <dd><Tag v-if="detail.task.origin" variant="outline" size="sm">{{ detail.task.origin }}</Tag><template v-else>-</template></dd>
                    <dt>Epic</dt>
                    <dd>{{ detail.task.epicId ?? '-' }}</dd>
                  </dl>
                </details>
              </div>
            </template>

            <template #findings>
              <Table :columns="findingColumns" :rows="detail.findings" row-key="findingId" empty="No findings recorded for this task.">
                <template #cell="{ column, row }">
                  <Tag v-if="column.key === 'severity'" :tone="severityKitTone(String(row.severity)).tone" :variant="severityKitTone(String(row.severity)).variant" size="sm">{{ row.severity }}</Tag>
                  <Tag v-else-if="column.key === 'findingStatus'" :tone="findingStatusKitTone(String(row.findingStatus))" size="sm">{{ row.findingStatus }}</Tag>
                  <template v-else-if="column.key === 'summary'">
                    <div>{{ row.summary }}</div>
                    <!-- A spec finding names the criterion it is about; a diff finding renders nothing here. -->
                    <div v-if="specRefLabel(row as never)" class="bs-task-detail__spec-ref">{{ specRefLabel(row as never) }}</div>
                    <div v-if="canWaive(row as never)" class="bs-task-detail__waive-actions">
                      <Popover label="Waive finding" :open="openPopover === (row as never as { fingerprint: string }).fingerprint" @close="openPopover = null">
                        <template #trigger>
                          <Button
                            variant="secondary"
                            size="sm"
                            :disabled="saving === (row as never as { fingerprint: string }).fingerprint"
                            @click="openPopover = (row as never as { fingerprint: string }).fingerprint"
                          >
                            Waive
                          </Button>
                        </template>
                        <p class="bs-task-detail__popover-text">Waive finding <code>{{ (row as never as { fingerprint: string }).fingerprint }}</code>? This can't be asked again.</p>
                        <Button variant="secondary" size="sm" @click="decide((row as never as { fingerprint: string }).fingerprint, 'granted')">Confirm</Button>
                      </Popover>
                      <Button
                        variant="danger"
                        size="sm"
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
              <template v-if="imageArtifacts.length + otherArtifacts.length > 0">
                <div v-if="imageArtifacts.length > 0" class="bs-task-detail__artifact-grid">
                  <button
                    v-for="a in imageArtifacts"
                    :key="a.id"
                    type="button"
                    class="bs-task-detail__artifact"
                    @click="lightboxSrc = artifactUrl(a)"
                  >
                    <img :src="artifactUrl(a)" :alt="a.type" class="bs-task-detail__artifact-img" />
                    <div>{{ a.type }}</div>
                  </button>
                </div>
                <ul v-if="otherArtifacts.length > 0" class="bs-task-detail__artifact-list">
                  <li v-for="a in otherArtifacts" :key="a.id">
                    <span class="bs-task-detail__artifact-type">{{ a.type }}</span>
                    <span class="bs-task-detail__artifact-path">{{ a.path }}</span>
                  </li>
                </ul>
              </template>
              <EmptyState v-else :icon="ImageIcon" title="No outputs recorded." body="Artifacts and screenshots the task produces will appear here." />
              <Dialog :open="!!lightboxSrc" title="Artifact preview" @close="lightboxSrc = null">
                <img v-if="lightboxSrc" :src="lightboxSrc" alt="Artifact preview" class="bs-task-detail__lightbox-img" />
              </Dialog>
            </template>

            <template #history>
              <div v-if="totalsCells.length > 0" class="bs-task-totals-bar" role="group" aria-label="Task totals">
                <div v-for="cell in totalsCells" :key="cell.key" class="bs-task-totals-bar__cell">
                  <div class="bs-task-totals-bar__key">
                    <Icon :icon="cell.icon" :size="14" />
                    {{ cell.label }}
                  </div>
                  <div class="bs-task-totals-bar__value">
                    <Tooltip mode="describe" :text="cell.exact">
                      <CompactNumber v-if="cell.key === 'tokens'" :value="totals!.tokens!" unit="tok" />
                      <template v-else>{{ cell.value }}</template>
                    </Tooltip>
                  </div>
                </div>
              </div>
              <RunHistoryTimeline :runs="runs" />
              <Skeleton v-if="historyLoading" :height="160" />
              <!-- Ahead of the empty state on purpose. A failed fetch has no
                   events to show either, and the two are only distinguishable
                   here -- past this point they render identically. -->
              <Banner v-else-if="historyError" tone="danger" show-retry @retry="loadHistory">
                {{ historyError }}
              </Banner>
              <div v-else-if="history.length > 0" style="margin-top: var(--bs-space-5)">
                <template v-for="(group, gi) in historyDayGroups" :key="gi">
                  <div class="timeline-day" :class="{ 'timeline-day--first': gi === 0 }">{{ group.label }}</div>
                  <div class="timeline-feed">
                    <ol style="list-style: none; margin: 0; padding: 0">
                      <TimelineRow
                        v-for="e in group.items"
                        :key="e.eventId"
                        :entry="e"
                        :expanded="historyExpanded.has(e.eventId)"
                        :ctx="historyCtxFor(e)"
                        :linkable="false"
                        @toggle="toggleHistoryRow"
                      />
                    </ol>
                  </div>
                </template>
              </div>
              <EmptyState v-else :icon="HistoryIcon" title="No events recorded." body="Events this task produces will appear here." />
            </template>
          </Tabs>
        </div>

        <div class="bs-task-detail__rail">
          <Card title="Details">
            <dl class="bs-task-detail__dl">
              <dt>Task ID</dt>
              <dd class="bs-task-detail__mono">{{ detail.task.taskId }}</dd>
              <dt>Epic</dt>
              <dd>{{ detail.task.epicId ?? '-' }}</dd>
              <dt>Plan version</dt>
              <dd>{{ detail.task.planVersion ?? '-' }}</dd>
              <dt>Status</dt>
              <dd><Tag :tone="taskStatusKitTone(detail.task.taskStatus)" size="sm">{{ titleCase(detail.task.taskStatus) }}</Tag></dd>
              <dt>Origin</dt>
              <dd><Tag v-if="detail.task.origin" variant="outline" size="sm">{{ detail.task.origin }}</Tag><template v-else>-</template></dd>
              <dt>Case</dt>
              <dd><Tag v-if="detail.task.caseTag" variant="outline" size="sm">{{ detail.task.caseTag }}</Tag><template v-else>-</template></dd>
            </dl>
          </Card>
          <Card title="Agents">
            <ul v-if="detail.agents.length > 0" class="bs-task-detail__agent-list">
              <li v-for="a in detail.agents" :key="a.id" class="bs-task-detail__agent-row">
                <span>{{ roleLabel(a.agentRole) }} · {{ a.modelTier }}/{{ a.provider }}</span>
                <AgentStatusBadge :agent="a" />
              </li>
            </ul>
            <EmptyState v-else :icon="Bot" title="No agents yet." body="Agents dispatched to this task will appear here." />
          </Card>
        </div>
      </div>
    </template>
  </div>
</template>
