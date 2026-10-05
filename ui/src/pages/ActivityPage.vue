<script setup lang="ts">
// Activity (DS6 PR3, ds-spec.md §4.3 / ds-review.html #p-activity): a flat
// day-grouped feed replacing Timeline + Errors. Operator overrides (beat the
// mock): topbar carries the title alone — no PageHeader here. Operator
// decision: no search box, no "Decisions" lens (decisionsOnly stays a server
// param, just not exposed in this UI). DS6 PR4c: when `kind=errors` is
// active, the class-summary cards and their two charts render above the
// feed (which itself stays filtered to Error rows, unchanged from PR3). The
// old raw Errors table and its detail Dialog were already removed in an
// earlier commit (48f2647) — there was nothing left to remove here.
import { ArrowUp, History } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Banner from '../components/kit/Banner.vue';
import BarChart from '../components/kit/BarChart.vue';
import Button from '../components/kit/Button.vue';
import Card from '../components/kit/Card.vue';
import EmptyState from '../components/kit/EmptyState.vue';
import LineChart from '../components/kit/LineChart.vue';
import RelativeTime from '../components/kit/RelativeTime.vue';
import Sparkline from '../components/kit/Sparkline.vue';
import Tag from '../components/kit/Tag.vue';
import TimelineRow from '../components/kit/TimelineRow.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useSessionContext } from '../composables/useSessionContext.js';
import { useViewport } from '../composables/useViewport.js';
import { LoadOlderGate } from '../lib/activityPaging.js';
import {
  type EventKind as ApiEventKind,
  type ErrorsResult,
  fetchErrors,
  fetchTimelinePage,
  type TimelinePage,
} from '../lib/api.js';
import { errorsByGroupTakeaway, errorsOverTimeTakeaway } from '../lib/chartTakeaways.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { errorClassCardView, humanizeClass } from '../lib/errorClassCards.js';
import { loadExpanded, saveExpanded, toggleExpanded } from '../lib/expandedRows.js';
import { FeedGeneration } from '../lib/feedGeneration.js';
import { formatNewEventsCount, LiveFeedBuffer, NewEventsAnnouncer } from '../lib/liveFeed.js';
import { nextRovingTabId } from '../lib/rovingTabs.js';
import { scrollToTimelineRow } from '../lib/scrollToRow.js';
import { severityKitTone } from '../lib/taxonomy.js';
import {
  type ActivityEntry,
  EVENT_KIND_LABEL,
  EVENT_KINDS,
  type EventKind,
  groupByDay,
  groupByRoleMinute,
  sessionDividerBefore,
  sessionDividerLabel,
} from '../lib/timelineDisplay.js';

const route = useRoute();
const router = useRouter();
const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Activity' }]);
const { project } = useProjectContext();
const { sessionScope, sessionKey } = useSessionContext();
const { isPhoneWidth } = useViewport();

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

// DS6 PR4b round 2 item 2: one gate per feed, re-created whenever the feed
// itself reloads (filters, project/session switch), guarding both the
// sentinel and the fallback button against a double fetch.
let loaderGate = new LoadOlderGate(null);
const sentinelEl = ref<HTMLElement | null>(null);
let sentinelObserver: IntersectionObserver | null = null;

watch(sentinelEl, (el) => {
  sentinelObserver?.disconnect();
  if (!el) return;
  sentinelObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadOlder();
  });
  sentinelObserver.observe(el);
});

onBeforeUnmount(() => sentinelObserver?.disconnect());

// DS6 PR4b round 3 item 1 (ds-spec.md §4.3 "Live"): a top sentinel decides
// whether the reader is at the top of the feed (same IntersectionObserver
// pattern as the "load older" sentinel). `atTop` starts true since the
// sentinel is in view at mount, before any row has loaded.
const atTop = ref(true);
const topSentinelEl = ref<HTMLElement | null>(null);
let topSentinelObserver: IntersectionObserver | null = null;

watch(topSentinelEl, (el) => {
  topSentinelObserver?.disconnect();
  if (!el) return;
  topSentinelObserver = new IntersectionObserver((entries) => {
    atTop.value = entries.some((e) => e.isIntersecting);
  });
  topSentinelObserver.observe(el);
});

onBeforeUnmount(() => topSentinelObserver?.disconnect());

let liveFeed = new LiveFeedBuffer<ActivityEntry>();
const pendingNewCount = ref(0);
const polling = ref(false);
const liveAnnouncement = ref('');
let announcer = new NewEventsAnnouncer();

// Fix round items 1-2: one request-generation token, bumped by load() on
// every fetch (including the first); poll/loadOlder/load each drop a
// response whose generation is stale. Also gives poll() its own in-flight
// guard (item 1), separate from the generation check.
const feedGen = new FeedGeneration();

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

// DS6 PR4c: the class-summary cards and their two charts only need data
// while the Errors kind is selected, fetched separately from the main feed
// since `fetchErrors` returns a different shape (class/day/group buckets,
// not timeline entries).
const errorsData = ref<ErrorsResult | null>(null);
const errorsLoading = ref(false);

async function loadErrorsData() {
  errorsLoading.value = true;
  try {
    errorsData.value = await fetchErrors(sessionScope.value, project.value);
  } finally {
    errorsLoading.value = false;
  }
}

watch(
  [kindFilter, project, sessionKey],
  () => {
    if (kindFilter.value === 'error') loadErrorsData();
  },
  { immediate: true },
);

const errorsByDayPoints = computed(
  () => errorsData.value?.byDay.map((d) => ({ label: d.day, value: d.count })) ?? [],
);

const errorsByGroupTotals = computed(() => {
  const totals = new Map<string, number>();
  for (const row of errorsData.value?.byClass ?? []) {
    totals.set(row.errorGroup, (totals.get(row.errorGroup) ?? 0) + row.count);
  }
  return [...totals.entries()].map(([group, count]) => ({
    label: humanizeClass(group),
    count,
  }));
});

const errorsByGroupBars = computed(() =>
  errorsByGroupTotals.value.map((g) => ({ label: g.label, value: g.count })),
);

const dominantGroupLabel = computed(() => {
  const sorted = [...errorsByGroupTotals.value].sort((a, b) => b.count - a.count);
  return sorted[0]?.label;
});

const errorsOverTimeText = computed(() =>
  errorsOverTimeTakeaway(errorsData.value?.byDay ?? [], dominantGroupLabel.value),
);
const errorsByGroupText = computed(() => errorsByGroupTakeaway(errorsByGroupTotals.value));

const errorClassCards = computed(
  () => errorsData.value?.classSummary.map((s) => errorClassCardView(s)) ?? [],
);

function setQuery(patch: Record<string, string | undefined>) {
  const next = { ...route.query, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  router.push({ path: '/activity', query: next });
}

function toggleKind(kind: EventKind) {
  setQuery({ kind: kindFilter.value === kind ? undefined : kind });
}

// Phone kind filter (ds-spec.md §3.1 shell table): an underline tab row
// replaces the desktop chip row, with 'All' as its own tab — selecting a
// kind sets it, selecting 'All' clears it (never a toggle-off, unlike the
// desktop chips, since a tab row always has exactly one tab selected).
const PHONE_KIND_TABS = ['all', ...EVENT_KINDS] as const;
function selectPhoneKind(kind: (typeof PHONE_KIND_TABS)[number]) {
  setQuery({ kind: kind === 'all' ? undefined : kind });
}
function onPhoneKindKeydown(event: KeyboardEvent) {
  const ids = [...PHONE_KIND_TABS];
  const current = kindFilter.value ?? 'all';
  const nextId = nextRovingTabId(event, ids, current);
  if (nextId === null) return;
  selectPhoneKind(nextId as (typeof PHONE_KIND_TABS)[number]);
  document.getElementById(`activity-kind-tab-${nextId}`)?.focus();
}

// S2: the tab strip scrolls horizontally (`.bs-tabs__list`, overflow-x:
// auto) and the active tab can land past the right edge on mount or after a
// filter change from elsewhere (e.g. the URL), leaving no on-screen signal
// of which kind is selected. Scroll it back into view every time the
// selection changes, once the DOM has the new `aria-selected` state.
watch(
  [kindFilter, isPhoneWidth],
  async () => {
    if (!isPhoneWidth.value) return;
    await nextTick();
    const id = kindFilter.value ?? 'all';
    document.getElementById(`activity-kind-tab-${id}`)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  },
  { immediate: true },
);

async function load() {
  const gen = feedGen.bump();
  try {
    const kinds = kindFilter.value
      ? ([EVENT_KIND_LABEL[kindFilter.value]] as ApiEventKind[])
      : undefined;
    const fetched = await fetchTimelinePage({
      session: sessionScope.value,
      project: project.value,
      task: taskFilter.value,
      epic: epicFilter.value,
      kinds,
      limit: 50,
    });
    if (feedGen.isStale(gen)) return;
    page.value = fetched;
    loaderGate = new LoadOlderGate(page.value.nextBefore);
    liveFeed = new LiveFeedBuffer<ActivityEntry>();
    pendingNewCount.value = 0;
    announcer.reset();
    error.value = null;
  } catch (e) {
    if (feedGen.isStale(gen)) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (!feedGen.isStale(gen)) loading.value = false;
  }
}

onMounted(load);
watch([project, sessionKey, kindFilter, taskFilter, epicFilter], load);

// DS6 PR4b round 3 item 1: once the feed is loaded, the same `usePoll`
// trigger (15s fallback, stream advance, global Refresh) fetches only rows
// newer than the newest one already held (`after=`) instead of reloading
// the whole page, so an incremental poll cannot re-sort rows already paged
// back. `load()` still owns the initial fetch and filter changes.
async function poll() {
  if (!page.value) return;
  if (!feedGen.startPoll()) return;
  const gen = feedGen.snapshot();
  const cursor = page.value.newestId;
  polling.value = true;
  try {
    const kinds = kindFilter.value
      ? ([EVENT_KIND_LABEL[kindFilter.value]] as ApiEventKind[])
      : undefined;
    const incoming = await fetchTimelinePage({
      session: sessionScope.value,
      project: project.value,
      task: taskFilter.value,
      epic: epicFilter.value,
      kinds,
      limit: 50,
      after: cursor ?? undefined,
    });
    if (!page.value || feedGen.isStale(gen)) return;
    const nextNewestId = incoming.newestId ?? cursor;
    const merged = liveFeed.receive(incoming.entries, atTop.value);
    if (merged) {
      if (merged.length === 0) return;
      page.value = {
        entries: [...merged, ...page.value.entries],
        nextBefore: page.value.nextBefore,
        newestId: nextNewestId,
      };
      pendingNewCount.value = 0;
      announcer.reset();
    } else {
      page.value = { ...page.value, newestId: nextNewestId };
      pendingNewCount.value = liveFeed.pendingCount;
      const announcement = announcer.next(pendingNewCount.value);
      if (announcement) liveAnnouncement.value = announcement;
    }
  } catch (e) {
    if (feedGen.isStale(gen)) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    feedGen.endPoll();
    polling.value = false;
  }
}

// design-spec.md §8: Activity (Timeline's replacement) polls at the same
// 15s cadence and answers the shared topbar Refresh, same as Kanban/Sessions.
usePoll(poll, 15000);

function applyPendingNew() {
  if (!page.value) return;
  const flushed = liveFeed.flush();
  pendingNewCount.value = 0;
  announcer.reset();
  if (flushed.length === 0) return;
  page.value = { ...page.value, entries: [...flushed, ...page.value.entries] };
  // The feed scrolls inside the app shell's own .app-scroll container, not
  // the window -- window.scrollTo is a no-op here.
  document.querySelector('.app-scroll')?.scrollTo({ top: 0 });
}

async function loadOlder() {
  if (!page.value?.nextBefore) return;
  if (!loaderGate.start()) return;
  const gen = feedGen.snapshot();
  try {
    const older = await fetchTimelinePage({
      session: sessionScope.value,
      project: project.value,
      task: taskFilter.value,
      epic: epicFilter.value,
      kinds: kindFilter.value
        ? ([EVENT_KIND_LABEL[kindFilter.value]] as ApiEventKind[])
        : undefined,
      limit: 50,
      before: page.value.nextBefore,
    });
    if (feedGen.isStale(gen)) return;
    page.value = {
      entries: [...page.value.entries, ...older.entries],
      nextBefore: older.nextBefore,
      newestId: page.value.newestId,
    };
    loaderGate.finish(older.nextBefore);
  } catch (e) {
    loaderGate.finish(page.value?.nextBefore ?? null);
    if (feedGen.isStale(gen)) return;
    throw e;
  }
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

// DS6 PR4b item 3: a "Session: <title>" divider between adjacent rows whose
// session differs, keyed off the whole feed's order (not per day-group), so a
// session that spans a day boundary still only breaks once per real change.
const indexById = computed(() => new Map(entries.value.map((e, i) => [e.eventId, i])));
function dividerBefore(entry: ActivityEntry): boolean {
  const idx = indexById.value.get(entry.eventId);
  return idx !== undefined && sessionDividerBefore(entries.value, idx);
}

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
  scrollToTimelineRow(promptId);
}
</script>

<template>
  <div class="app-page" role="feed" aria-label="Activity" :aria-busy="loading || polling">
    <span class="sr-only" aria-live="polite">{{ liveAnnouncement }}</span>
    <div
      v-if="isPhoneWidth"
      role="tablist"
      class="bs-tabs__list"
      aria-label="Filter"
      @keydown="onPhoneKindKeydown"
    >
      <button
        v-for="kind in PHONE_KIND_TABS"
        :id="`activity-kind-tab-${kind}`"
        :key="kind"
        type="button"
        role="tab"
        class="bs-tabs__tab"
        :aria-selected="(kindFilter ?? 'all') === kind"
        :tabindex="(kindFilter ?? 'all') === kind ? 0 : -1"
        @click="selectPhoneKind(kind)"
      >
        {{ kind === 'all' ? 'All' : EVENT_KIND_LABEL[kind] }}
      </button>
    </div>
    <div v-else class="activity-toolbar bs-timeline-row__meta" style="padding-left: 0; justify-content: space-between">
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

    <div v-if="kindFilter === 'error'" class="bs-activity-errors">
      <div class="bs-activity-errors__charts">
        <Card title="Errors over time">
          <LineChart
            v-if="errorsByDayPoints.length > 0"
            :points="errorsByDayPoints"
            label="Errors by day"
            :takeaway="errorsOverTimeText"
          />
          <p v-else class="bs-chart__takeaway">{{ errorsOverTimeText }}</p>
        </Card>
        <Card title="Errors by group">
          <BarChart
            v-if="errorsByGroupBars.length > 0"
            :bars="errorsByGroupBars"
            label="Errors by group"
            :takeaway="errorsByGroupText"
          />
          <p v-else class="bs-chart__takeaway">{{ errorsByGroupText }}</p>
        </Card>
      </div>
      <div v-if="errorClassCards.length > 0" class="bs-activity-errors__cards">
        <Card v-for="card in errorClassCards" :key="card.id">
          <p class="bs-activity-errors__card-headline">{{ card.headline }}</p>
          <div class="bs-activity-errors__card-mix">
            <Tag
              v-for="mix in card.severityMix"
              :key="mix.severity"
              :tone="severityKitTone(mix.severity).tone"
              :variant="severityKitTone(mix.severity).variant"
              size="sm"
            >
              {{ mix.pillLabel }}
            </Tag>
          </div>
          <div class="bs-activity-errors__card-footer">
            <span>Last seen <RelativeTime :iso="card.lastSeen" /></span>
            <Sparkline
              v-if="card.trend7d.length > 0"
              :values="card.trend7d"
              label="7-day trend"
              :takeaway="card.trendCaption"
            />
          </div>
        </Card>
      </div>
    </div>

    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>

    <EmptyState
      v-else-if="canClaimEmpty(page !== null, entries.length)"
      :icon="History"
      title="No activity matches these filters."
      body=""
    />

    <template v-else>
      <!-- Fix round 2 item 2 (ds-review.html `.mock` block flow): one plain
           wrapper, not a flat run of flex children of `.app-page` -- its own
           margins collapse the way the mock's block-flow container does,
           instead of `.app-page`'s flex `gap` stacking on top of every
           sentinel/pill/day-group's own margin. -->
      <div class="activity-feed">
        <div ref="topSentinelEl" class="activity-sentinel" aria-hidden="true"></div>
        <div v-if="pendingNewCount > 0" class="activity-newpill">
          <Button variant="primary" size="sm" :icon="ArrowUp" @click="applyPendingNew">
            {{ formatNewEventsCount(pendingNewCount) }}
          </Button>
        </div>
        <template v-for="(group, gi) in dayGroups" :key="gi">
          <div class="timeline-day" :class="{ 'timeline-day--first': gi === 0 }">{{ group.label }}</div>
          <div class="timeline-feed">
            <ol style="list-style: none; margin: 0; padding: 0">
              <template v-for="item in groupByRoleMinute(group.items)" :key="item.kind === 'group' ? item.group!.id : item.entry!.eventId">
                <li v-if="item.kind === 'group'" class="bs-timeline-row">
                  {{ item.group!.members.length }} dispatches, {{ item.group!.role }}
                </li>
                <template v-else>
                  <li v-if="dividerBefore(item.entry!)" class="bs-session-divider">
                    Session: {{ sessionDividerLabel(item.entry!) }}
                  </li>
                  <TimelineRow
                    :entry="item.entry!"
                    :expanded="expanded.has(item.entry!.eventId)"
                    :ctx="ctxFor(item.entry!)"
                    :class="{ 'bs-timeline-row--highlight': highlighted === item.entry!.eventId }"
                    @toggle="toggleRow"
                    @select-task="goToTask"
                    @because-of="becauseOf"
                  />
                </template>
              </template>
            </ol>
          </div>
        </template>
        <div v-if="page?.nextBefore" ref="sentinelEl" class="activity-sentinel" aria-hidden="true"></div>
        <Button v-if="page?.nextBefore" variant="ghost" size="sm" @click="loadOlder">Load older</Button>
      </div>
    </template>
  </div>
</template>
