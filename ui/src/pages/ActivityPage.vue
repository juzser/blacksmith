<script setup lang="ts">
// Activity (DS6 PR3, ds-spec.md §4.3 / ds-review.html #p-activity): a flat
// day-grouped feed replacing Timeline + Errors. Operator overrides (beat the
// mock): topbar carries the title alone — no PageHeader here. Operator
// decision: no search box, no "Decisions" lens (decisionsOnly stays a server
// param, just not exposed in this UI). Errors' own class cards are PR4; until
// then `kind=errors` just filters the feed to Error rows.
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Banner from '../components/ds/Banner.vue';
import EmptyState from '../components/ds/EmptyState.vue';
import Button from '../components/kit/Button.vue';
import TimelineRow from '../components/kit/TimelineRow.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useSessionContext } from '../composables/useSessionContext.js';
import {
  type EventKind as ApiEventKind,
  fetchTimelinePage,
  type TimelinePage,
} from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { loadExpanded, saveExpanded, toggleExpanded } from '../lib/expandedRows.js';
import {
  type ActivityEntry,
  EVENT_KIND_LABEL,
  EVENT_KINDS,
  type EventKind,
  groupByDay,
  groupByRoleMinute,
} from '../lib/timelineDisplay.js';

const route = useRoute();
const router = useRouter();
const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Activity' }]);
const { project } = useProjectContext();
const { sessionScope, sessionKey } = useSessionContext();

// The brief's own `/errors` -> `/activity?kind=errors` wording (plural,
// activityRoute.ts) doesn't match EVENT_KINDS' singular 'error' id — kept as
// its own alias rather than renaming the kind everywhere else it's used.
const URL_KIND_ALIAS: Record<string, EventKind> = { errors: 'error' };

const page = ref<TimelinePage | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
const expanded = ref<Set<string>>(new Set());
const highlighted = ref<string | null>(null);

const STORAGE_KEY = 'activity';

onMounted(() => {
  expanded.value = loadExpanded(sessionStorage, STORAGE_KEY);
});

const kindFilter = computed<EventKind | null>(() => {
  const raw = route.query.kind;
  if (typeof raw !== 'string') return null;
  if (raw in URL_KIND_ALIAS) return URL_KIND_ALIAS[raw];
  return (EVENT_KINDS as readonly string[]).includes(raw) ? (raw as EventKind) : null;
});
const taskFilter = computed(() =>
  typeof route.query.task === 'string' ? route.query.task : undefined,
);
const epicFilter = computed(() =>
  typeof route.query.epic === 'string' ? route.query.epic : undefined,
);

function setQuery(patch: Record<string, string | undefined>) {
  const next = { ...route.query, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  router.push({ path: '/activity', query: next });
}

function toggleKind(kind: EventKind) {
  setQuery({ kind: kindFilter.value === kind ? undefined : kind });
}

async function load() {
  try {
    const kinds = kindFilter.value
      ? ([EVENT_KIND_LABEL[kindFilter.value]] as ApiEventKind[])
      : undefined;
    page.value = await fetchTimelinePage({
      session: sessionScope.value,
      project: project.value,
      task: taskFilter.value,
      epic: epicFilter.value,
      kinds,
      limit: 50,
    });
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch([project, sessionKey, kindFilter, taskFilter, epicFilter], load);
// design-spec.md §8: Activity (Timeline's replacement) polls at the same
// 15s cadence and answers the shared topbar Refresh, same as Kanban/Sessions.
usePoll(load, 15000);

async function loadOlder() {
  if (!page.value?.nextBefore) return;
  const older = await fetchTimelinePage({
    session: sessionScope.value,
    project: project.value,
    task: taskFilter.value,
    epic: epicFilter.value,
    kinds: kindFilter.value ? ([EVENT_KIND_LABEL[kindFilter.value]] as ApiEventKind[]) : undefined,
    limit: 50,
    before: page.value.nextBefore,
  });
  page.value = {
    entries: [...page.value.entries, ...older.entries],
    nextBefore: older.nextBefore,
    newestId: page.value.newestId,
  };
}

const entries = computed<ActivityEntry[]>(() => page.value?.entries ?? []);
const promptTsById = computed(() => new Map(entries.value.map((e) => [e.eventId, e.ts])));
const causedCountByPromptId = computed(() => {
  const counts = new Map<string, number>();
  for (const e of entries.value) {
    if (e.nearestPromptId) counts.set(e.nearestPromptId, (counts.get(e.nearestPromptId) ?? 0) + 1);
  }
  return counts;
});

const dayGroups = computed(() => groupByDay(entries.value, new Date().toISOString()));

function ctxFor(entry: ActivityEntry) {
  const promptTs = entry.nearestPromptId
    ? (promptTsById.value.get(entry.nearestPromptId) ?? null)
    : undefined;
  const causedCount = causedCountByPromptId.value.get(entry.eventId);
  return { promptTs, causedCount };
}

function toggleRow(eventId: string) {
  expanded.value = toggleExpanded(expanded.value, eventId);
  saveExpanded(sessionStorage, STORAGE_KEY, expanded.value);
}

function expandAll() {
  expanded.value = new Set(entries.value.map((e) => e.eventId));
  saveExpanded(sessionStorage, STORAGE_KEY, expanded.value);
}

function goToTask(taskId: string) {
  router.push(`/tasks/${encodeURIComponent(taskId)}`);
}

function becauseOf(promptId: string) {
  highlighted.value = promptId;
  const el = document.getElementById(`activity-row-${promptId}`);
  el?.scrollIntoView({ block: 'center' });
}
</script>

<template>
  <div class="app-page" role="feed" aria-label="Activity">
    <div class="activity-toolbar bs-timeline-row__meta" style="padding-left: 0; justify-content: space-between">
      <div class="activity-kind-filter" style="display: flex; gap: var(--bs-space-1); flex-wrap: wrap">
        <Button
          v-for="kind in EVENT_KINDS"
          :key="kind"
          variant="ghost"
          size="sm"
          :aria-pressed="kindFilter === kind"
          @click="toggleKind(kind)"
        >
          {{ EVENT_KIND_LABEL[kind] }}
        </Button>
      </div>
      <div style="display: flex; gap: var(--bs-space-1)">
        <Button class="activity-toolbar__expand-all" variant="ghost" size="sm" @click="expandAll">Expand all</Button>
        <Button variant="ghost" size="sm" icon="refresh-cw" @click="load">Refresh</Button>
      </div>
    </div>

    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>

    <EmptyState v-else-if="canClaimEmpty(page !== null, entries.length)" icon="history">
      No activity matches these filters.
    </EmptyState>

    <template v-else>
      <template v-for="(group, gi) in dayGroups" :key="gi">
        <div class="timeline-day">{{ group.label }}</div>
        <div class="timeline-feed">
          <ol style="list-style: none; margin: 0; padding: 0">
            <template v-for="item in groupByRoleMinute(group.items)" :key="item.kind === 'group' ? item.group!.id : item.entry!.eventId">
              <li v-if="item.kind === 'group'" class="bs-timeline-row">
                {{ item.group!.members.length }} dispatches, {{ item.group!.role }}
              </li>
              <TimelineRow
                v-else
                :entry="item.entry!"
                :expanded="expanded.has(item.entry!.eventId)"
                :ctx="ctxFor(item.entry!)"
                :class="{ 'bs-timeline-row--highlight': highlighted === item.entry!.eventId }"
                @toggle="toggleRow"
                @select-task="goToTask"
                @because-of="becauseOf"
              />
            </template>
          </ol>
        </div>
      </template>
      <Button v-if="page?.nextBefore" variant="ghost" size="sm" @click="loadOlder">Load older</Button>
    </template>
  </div>
</template>
