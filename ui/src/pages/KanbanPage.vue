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
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { fetchKanban, fetchOverview, type KanbanColumn, selectableEpics } from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { visibleTaskCount } from '../lib/kanban.js';
import {
  ALL_EPICS,
  EPIC_LIST_UNAVAILABLE,
  epicOptions,
  retainedEpic,
} from '../lib/epicPicker.js';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { usePoll } from '../composables/usePoll.js';
import Banner from '../components/hds/Banner.vue';
import Button from '../components/hds/Button.vue';
import EmptyState from '../components/hds/EmptyState.vue';
import PageHeader from '../components/hds/PageHeader.vue';
import Select from '../components/hds/Select.vue';
import Skeleton from '../components/hds/Skeleton.vue';
import Toolbar from '../components/hds/Toolbar.vue';
import KanbanBoard from '../components/KanbanBoard.vue';

const router = useRouter();
const route = useRoute();
const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Kanban' }]);
const { project } = useProjectContext();

const epics = ref<string[]>([]);
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
    const overview = await fetchOverview(undefined, project.value);
    epics.value = selectableEpics(overview);
    epicsFailed.value = false;
  } catch {
    epicsFailed.value = true;
  }
}

async function loadBoard() {
  // Cleared on success, not on attempt. This page polls, so `load()` re-runs
  // unattended every 15s (and again the moment the tab regains focus): during
  // an outage every one of those attempts wiped the banner for the length of
  // its own flight, leaving the bare empty state in its place (D-226).
  try {
    columns.value = await fetchKanban(selectedEpic.value || undefined, undefined, project.value);
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function load() {
  await loadEpics();
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
// Same split as FlowPage's, for the same reason: `loadBoard()` fetches only
// /api/kanban, so a project switch left the picker listing the previous
// project's epics. Here the 15s poll re-ran `load()` and healed it eventually
// — the operator just had up to fifteen seconds of a control offering epics
// that belong to a project they are no longer looking at (D-228).
watch(project, async () => {
  await loadEpics();
  selectedEpic.value = retainedEpic(selectedEpic.value, epics.value);
  await loadBoard();
});

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

function goToTask(taskId: string) {
  router.push(`/tasks/${encodeURIComponent(taskId)}`);
}
</script>

<template>
  <div class="app-page app-page--full-bleed">
    <PageHeader title="Kanban">
      <template #actions>
        <Button v-if="milestoneFilter" variant="ghost" size="sm" @click="milestoneFilter = null">
          Clear milestone filter
        </Button>
        <Button variant="ghost" size="sm" icon="refresh-cw" @click="refresh">Refresh</Button>
      </template>
    </PageHeader>

    <Toolbar :count="`${taskCount} tasks`">
      <label style="display: flex; align-items: center; gap: var(--ds-space-1-5)">
        <span class="hds-toolbar__count">Epic</span>
        <Select v-model="selectedEpic" :options="epicOptions(epics)" aria-label="Epic" />
      </label>
    </Toolbar>

    <Banner v-if="!error && epicsFailed" tone="warning" show-retry @retry="loadEpics">
      {{ EPIC_LIST_UNAVAILABLE }}
    </Banner>
    <Banner v-if="error" tone="danger" show-retry @retry="loadBoard">{{ error }}</Banner>

    <template v-else-if="loading">
      <!-- ds-allow-hardcode:start — Skeleton width matches .kanban-col's own
           232px flex-basis (hds-components.css), a board-layout constant,
           not a spacing/sizing design token. -->
      <div style="display: flex; gap: var(--ds-space-4)">
        <Skeleton v-for="i in 5" :key="i" height="240" width="232px" />
      </div>
      <!-- ds-allow-hardcode:end -->
    </template>

    <EmptyState v-else-if="canClaimEmpty(columns !== null, taskCount)" icon="kanban">No tasks match these filters.</EmptyState>

    <KanbanBoard v-else-if="columns !== null" :columns="displayedColumns" :lane-label="selectedEpic || 'All epics'" @select="goToTask" />
  </div>
</template>
