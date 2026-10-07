<script setup lang="ts">
// Kanban — design-spec.md §5.3, operator directive 1 cleanup pass. Polls
// every 15s (paused when hidden) + a manual Refresh Button.
//
// Deviation, still flagged (§6.2.2): milestone LANES (the wireframe's
// "Milestone: X" section grouping, spanning multiple epics in one board)
// remain out of scope this round — kanban() now supports an epicId-less
// "all epics" mode and returns each task's milestoneId (closing the 6a
// query-shape gap), but composing that into full multi-lane board layout
// is a separately-scoped UI change; this page still renders one lane
// (either the selected epic, or "All epics" when chosen from the picker).
import { Kanban, RefreshCw } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import ActivityScopeToggle from '../components/ActivityScopeToggle.vue';
import KanbanBoard from '../components/KanbanBoard.vue';
import Banner from '../components/kit/Banner.vue';
import Button from '../components/kit/Button.vue';
import EmptyState from '../components/kit/EmptyState.vue';
import Select from '../components/kit/Select.vue';
import Skeleton from '../components/kit/Skeleton.vue';
import { useActiveScope } from '../composables/useActiveScope.js';
import { useActivityScope } from '../composables/useActivityScope.js';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useSessionContext } from '../composables/useSessionContext.js';
import { useViewport } from '../composables/useViewport.js';
import {
  type ActiveScopeResult,
  fetchKanban,
  fetchOverview,
  type IdleEpic,
  type KanbanColumn,
  selectableEpics,
} from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import {
  ALL_EPICS,
  activeSelection,
  EPIC_LIST_UNAVAILABLE,
  epicOptions,
  retainedEpic,
} from '../lib/epicPicker.js';
import { pluralize } from '../lib/format.js';
import { visibleTaskCount } from '../lib/kanban.js';
import type { StoreRef } from '../lib/storeKey.js';

const router = useRouter();
const route = useRoute();
const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Kanban' }]);
const { project } = useProjectContext();
const { sessionScope, sessionKey } = useSessionContext();
const { isPhoneWidth } = useViewport();
const { scope: mode, scopeTo } = useActivityScope();
const { scope: activeScope, settled: activeScopeSettled } = useActiveScope();

// A failed read counts as unmeasured, never as "nothing is active"; null only
// while the first answer is still in flight (same rule as SessionsPage).
const UNMEASURED: ActiveScopeResult = {
  measured: false,
  readAt: '',
  liveSessions: 0,
  unlinkedSessions: 0,
  projects: [],
  epics: [],
  factorySessions: [],
};
const live = () => activeScope.value ?? (activeScopeSettled.value ? UNMEASURED : null);

const epics = ref<string[]>([]);
const inFlight = ref<{ epicId: string; store?: StoreRef }[]>([]);
const idleEpics = ref<IdleEpic[]>([]);
const selectedEpic = ref<string>(ALL_EPICS);
/** Null until a fetch lands. That distinction is the whole guard on the empty state below. */
const columns = ref<KanbanColumn[] | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);

// Supplementary, and deliberately non-blocking: the board is the page. The
// picker reads a different endpoint than the board does, so it can fail on
// its own — and when it does, the last-known epics stay in the Select, the
// board's own fetch still runs, and the banner says why nothing new arrived.
// Awaiting this unguarded ahead of loadBoard() is what left the page on the
// skeleton forever with `error` still null (D-222).
const epicsFailed = ref(false);

async function loadEpics() {
  try {
    const overview = await fetchOverview(sessionScope.value, project.value);
    epics.value = selectableEpics(overview);
    inFlight.value =
      overview.epicsInFlightByStore ?? overview.epicsInFlight.map((epicId) => ({ epicId }));
    idleEpics.value = overview.epicsIdle;
    epicsFailed.value = false;
  } catch {
    epicsFailed.value = true;
  }
}

// What the picker offers: under Active with a measured scope, only the epics a
// live CLI session drives (plus the one `?epic=` names); otherwise every epic.
const pinnedEpic = () => (typeof route.query.epic === 'string' ? route.query.epic : '');
const activeView = () => mode.value === 'active' && live()?.measured === true;
const offered = computed(() =>
  activeSelection(epics.value, inFlight.value, live(), mode.value, pinnedEpic()),
);
// "All epics" stays whenever Active has nothing to offer, so the select always
// names what the board shows instead of going blank.
const pickerOptions = computed(() =>
  epicOptions(offered.value, idleEpics.value, !activeView() || offered.value.length === 0),
);

// Active has no "All epics" choice while it offers something, so a selection it
// does not offer (including the default) moves to the `?epic=` pin when that is
// offered, else to the first epic. With nothing offered the picker lists only
// "All epics", so that is the selection: the select never holds a value it has
// no option for.
function resolveSelection() {
  if (!activeView()) return;
  if (offered.value.length === 0) {
    selectedEpic.value = ALL_EPICS;
    return;
  }
  if (offered.value.includes(selectedEpic.value)) return;
  const pin = pinnedEpic();
  selectedEpic.value = offered.value.includes(pin) ? pin : (offered.value[0] ?? '');
}

async function loadBoard() {
  // Cleared on success, not on attempt. This page polls, so `load()` re-runs
  // unattended every 15s (and again the moment the tab regains focus): during
  // an outage every one of those attempts wiped the banner for the length of
  // its own flight, leaving the bare empty state in its place (D-226).
  try {
    columns.value = await fetchKanban(
      selectedEpic.value || undefined,
      sessionScope.value,
      project.value,
    );
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function load() {
  await loadEpics();
  resolveSelection();
  await loadBoard();
}

onMounted(() => {
  const milestone = route.query.milestone;
  if (typeof milestone === 'string') milestoneFilter.value = milestone;
  // Operator directive 3 (Phase 6b round 3): Overview's "Epics in flight"
  // rail rows link here as /kanban?epic=<id> — same query-param pattern as
  // the existing ?milestone= filter (Roadmap's mini-timeline links here
  // too), just pre-selecting the epic Select instead of post-filtering.
  const epic = route.query.epic;
  if (typeof epic === 'string') selectedEpic.value = epic;
  load();
});
const { refresh } = usePoll(load, 15000);
watch(selectedEpic, loadBoard);
// The scope answer (each shell pulse) and the Active/All switch both change what is offered.
watch([offered, mode], resolveSelection);
// Same split as the retired FlowPage's, for the same reason: `loadBoard()` fetches only
// /api/kanban, so a project switch left the picker listing the previous
// project's epics. Here the 15s poll re-ran `load()` and healed it eventually
// — the operator just had up to fifteen seconds of a control offering epics
// that belong to a project they are no longer looking at (D-228).
watch([project, sessionKey], async () => {
  await loadEpics();
  selectedEpic.value = retainedEpic(selectedEpic.value, epics.value);
  resolveSelection();
  await loadBoard();
});

// The Active edge states: each is one muted line instead of a board.
const noLiveSessions = computed(() => activeView() && live()?.liveSessions === 0);
const noneOnAnEpic = computed(
  () =>
    activeView() &&
    !noLiveSessions.value &&
    !loading.value &&
    !epicsFailed.value &&
    offered.value.length === 0,
);
// Sessions' exact rule for "none on an epic": no factory session drives
// anything and some live session is unlinked. Otherwise live sessions exist
// but none drives an epic *here*, and the line says only that.
const noneLine = computed(() => {
  const l = live();
  if (l && l.factorySessions.length === 0 && l.unlinkedSessions > 0) {
    return `${pluralize(l.unlinkedSessions, 'live session')}, none on an epic`;
  }
  return project.value ? 'No active epic in this project' : 'No active epic in this view';
});
const edgeEmpty = computed(() => noLiveSessions.value || noneOnAnEpic.value);
const scopePending = computed(() => mode.value === 'active' && live() === null);
const unmeasuredNote = computed(() => mode.value === 'active' && live()?.measured === false);

const milestoneFilter = ref<string | null>(null);
const displayedColumns = computed(() => {
  if (!milestoneFilter.value) return columns.value ?? [];
  return (columns.value ?? []).map((c) => ({
    ...c,
    tasks: c.tasks.filter((t) => t.milestoneId === milestoneFilter.value),
  }));
});

// Not a plain sum over the payload: the server groups by raw task_status and
// hides nothing, while KanbanBoard re-folds the same rows and drops `failed`
// and `superseded` from the default board. Summing here counted cards the
// board had already decided not to draw, so the Toolbar labelled a 7-card
// board "9 tasks" -- and the empty state below, gated on the same number,
// stayed silent over a board with nothing on it (D-242).
const taskCount = computed(() => visibleTaskCount(displayedColumns.value));

// KanbanBoard (DS3 kit rewrite) takes a flat task list and does its own
// grouping/column folding — this page still fetches per-status columns from
// the server, so the board's input is simply every task across them.
const boardTasks = computed(() => displayedColumns.value.flatMap((c) => c.tasks));

function goToTask(taskId: string, storeId?: string) {
  router.push({
    path: `/tasks/${encodeURIComponent(taskId)}`,
    query: storeId ? { store: storeId } : {},
  });
}
</script>

<template>
  <div>
    <div class="bs-kanban-page__toolbar">
      <label v-if="!edgeEmpty" class="bs-kanban-page__toolbar-field">
        <span class="bs-kanban-page__count">Epic</span>
        <Select v-model="selectedEpic" :options="pickerOptions" :disabled="scopePending" aria-label="Epic" />
      </label>
      <ActivityScopeToggle />
      <span v-if="!edgeEmpty && !scopePending" class="bs-kanban-page__count">{{ taskCount }} tasks</span>
      <div class="bs-kanban-page__toolbar-actions">
        <Button v-if="milestoneFilter" variant="ghost" size="sm" @click="milestoneFilter = null">
          Clear milestone filter
        </Button>
        <!-- KanbanBoard teleports its display-options trigger here on desktop
             (`#bs-kanban-page-toolbar-extra`), so the board's one control
             shares this row with the Epic select instead of a toolbar row of
             its own. -->
        <span id="bs-kanban-page-toolbar-extra" />
        <Button v-if="!isPhoneWidth" variant="ghost" size="sm" :icon="RefreshCw" @click="refresh">Refresh</Button>
        <!-- WorkPage teleports the Kanban/Roadmap SegmentedControl here on
             desktop/tablet (UI audit, fix round 1) — see WorkPage.vue. -->
        <span id="bs-work-view-switch" />
      </div>
    </div>

    <Banner v-if="!error && epicsFailed" tone="warning" show-retry @retry="loadEpics">
      {{ EPIC_LIST_UNAVAILABLE }}
    </Banner>
    <p v-if="unmeasuredNote" class="bs-sessions__quiet bs-kanban-page__note">Live sessions can't be read here</p>
    <Banner v-if="error" tone="danger" show-retry @retry="loadBoard">{{ error }}</Banner>

    <template v-else-if="loading || scopePending">
      <!-- ds-allow-hardcode:start — Skeleton width matches .bs-kanban-col's own
           280px flex-basis (bs-primitives.css), a board-layout constant,
           not a spacing/sizing design token. -->
      <div class="bs-kanban-page__skeletons">
        <Skeleton v-for="i in 5" :key="i" :height="240" width="280px" />
      </div>
      <!-- ds-allow-hardcode:end -->
    </template>

    <p v-else-if="noLiveSessions" class="bs-sessions__quiet">
      Nothing is active right now. ·
      <RouterLink :to="scopeTo('all')">Show all</RouterLink>
    </p>
    <p v-else-if="noneOnAnEpic" class="bs-sessions__quiet">
      {{ noneLine }} ·
      <RouterLink :to="scopeTo('all')">Show all</RouterLink>
    </p>

    <EmptyState
      v-else-if="canClaimEmpty(columns !== null, taskCount)"
      :icon="Kanban"
      title="No tasks match these filters."
      body="Try a different epic, or clear the milestone filter."
    />

    <KanbanBoard v-else-if="columns !== null" :tasks="boardTasks" @select="goToTask" />
  </div>
</template>
