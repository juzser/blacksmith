<script setup lang="ts">
// Roadmap — DS4 S2/S3. Replaces the VueFlow canvas with a plain horizontal
// swimlane (RoadmapSwimlane.vue) plus a goal/epics card (EpicBlock.vue),
// in phase mode or epic mode. `@vue-flow/core` is gone from package.json
// (DS8 PR3 moved SessionsPage off it too; the retired FlowPage was its
// other consumer).
//
// DS4 S4 — below 640px (`isPhoneWidth`) the swimlane is hidden entirely and
// replaced by a phase-picker Select (R4) feeding the same EpicBlock, whose
// own phone branch (phase list / epic back-link) is gated the same way.
//
// UI spec Part 2 — one RoadmapProjectSection per project, each windowed to
// its recent lanes (roadmapWindow.ts). The page owns the per-side expand
// state (expandedRows.ts, sessionStorage) so a deep link to a hidden lane can
// open its side, and drops the EpicBlock into the section holding the
// selection.
import { Map as MapIcon } from '@lucide/vue';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import EpicBlock from '../components/EpicBlock.vue';
import Banner from '../components/kit/Banner.vue';
import EmptyState from '../components/kit/EmptyState.vue';
import Skeleton from '../components/kit/Skeleton.vue';
import RoadmapProjectSection from '../components/RoadmapProjectSection.vue';
import TaskPeekPanel from '../components/TaskPeekPanel.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useSessionContext } from '../composables/useSessionContext.js';
import { useViewport } from '../composables/useViewport.js';
import {
  type FlowGraph,
  fetchFlow,
  fetchOverview,
  fetchRoadmap,
  type MilestoneProgress,
  type ProjectOverviewSummary,
  selectableEpics,
} from '../lib/api.js';
import { loadExpanded, saveExpanded, toggleExpanded } from '../lib/expandedRows.js';
import { planVersionOptions } from '../lib/planVersion.js';
import { defaultSelection } from '../lib/roadmapSelection.js';
import { hasRoadmapContent } from '../lib/roadmapSwimlane.js';
import {
  buildRoadmapSections,
  ROADMAP_WINDOW_SCOPE,
  type RoadmapSection,
  sectionHolds,
  selectionSide,
  type WindowSide,
  windowExpandId,
} from '../lib/roadmapWindow.js';
import {
  isTaskOver,
  type KitTone,
  milestoneStatusKitTone,
  milestoneStatusLabel,
} from '../lib/taxonomy.js';
import {
  buildWaveList,
  epicDatesFor,
  epicPhase,
  epicProject,
  epicStatusFromFlow,
  epicStatusFromServerStatus,
} from '../lib/waveList.js';

const router = useRouter();
const route = useRoute();
const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Roadmap' }]);
const { project } = useProjectContext();
const { sessionScope, sessionKey } = useSessionContext();
const { isPhoneWidth } = useViewport();

const milestones = ref<MilestoneProgress[] | null>(null);
const epics = ref<string[]>([]);
const activeEpics = ref<string[]>([]);
/** Unscoped only: a project with epics in flight but no declared phase gets an epic section. */
const overviewProjects = ref<ProjectOverviewSummary[]>([]);
const error = ref<string | null>(null);
const loading = ref(true);

const selectedPhase = ref<string | null>(null);
const selectedEpic = ref<string | null>(null);

/** One in-flight (or settled) FlowGraph fetch per epic this phase/project shows. */
const epicFlows = ref<Map<string, FlowGraph | 'failed'>>(new Map());

async function loadEpicFlow(epicId: string) {
  try {
    const flow = await fetchFlow({
      session: sessionScope.value,
      project: project.value,
      epic: epicId,
    });
    epicFlows.value.set(epicId, flow);
  } catch {
    epicFlows.value.set(epicId, 'failed');
  }
  // Map mutation alone does not trigger a ref's reactivity; replace it.
  epicFlows.value = new Map(epicFlows.value);
}

/**
 * Epic mode's own flow + plan-version state, separate from `epicFlows`
 * above: switching the plan-version Select re-fetches with a specific
 * `planVersion`, and that must not overwrite the phase-mode cache's
 * current-plan entry for the same epic.
 */
const epicModeFlow = ref<FlowGraph | 'failed' | undefined>(undefined);
const epicPlanVersion = ref('');
let epicModeFlowSeq = 0;

/**
 * `background: true` is the poll/topbar-Refresh path (fix round 1 finding
 * 2): it must not flash the Skeleton over data already on screen, so it
 * neither resets `epicModeFlow` to `undefined` before fetching nor stomps
 * good data with 'failed' on a transient error — the stale graph just stays
 * up until the next successful fetch replaces it.
 */
async function loadEpicModeFlow(options: { background?: boolean } = {}) {
  if (!selectedEpic.value) return;
  const epicId = selectedEpic.value;
  const background = options.background ?? false;
  // A later fetch (another epic, another plan version) supersedes this one:
  // a slow poll response must not overwrite what the operator now picked.
  const seq = ++epicModeFlowSeq;
  if (!background) epicModeFlow.value = undefined;
  try {
    const flow = await fetchFlow({
      session: sessionScope.value,
      project: project.value,
      epic: epicId,
      planVersion: epicPlanVersion.value ? Number(epicPlanVersion.value) : undefined,
    });
    if (seq !== epicModeFlowSeq) return;
    epicModeFlow.value = flow;
  } catch {
    if (seq !== epicModeFlowSeq) return;
    if (!background) epicModeFlow.value = 'failed';
  }
}

// Fix round 1 finding 2: the old FlowPage polled at 15s (see git history) and
// answered the topbar Refresh via usePoll's shared signal; RoadmapPage never
// did, so a running epic's WaveList went stale until a manual reload.
usePoll(() => loadEpicModeFlow({ background: true }), 15000);

function epicIdsForPhase(phaseId: string | null): string[] {
  if (phaseId === null) return [];
  const phase = (milestones.value ?? []).find((m) => m.milestoneId === phaseId);
  return phase ? phase.epicIds : [];
}

function ensureEpicFlowsLoaded(epicIds: string[]) {
  for (const epicId of epicIds) {
    if (!epicFlows.value.has(epicId)) loadEpicFlow(epicId);
  }
}

async function load() {
  try {
    const [roadmap, overview] = await Promise.all([
      fetchRoadmap(sessionScope.value, project.value),
      fetchOverview(sessionScope.value, project.value),
    ]);
    milestones.value = roadmap;
    epics.value = selectableEpics(overview);
    activeEpics.value = overview.epicsActivelyRunning;
    overviewProjects.value = overview.projects ?? [];
    error.value = null;

    const fromQuery = {
      phase: typeof route.query.phase === 'string' ? route.query.phase : null,
      epic: typeof route.query.epic === 'string' ? route.query.epic : null,
    };
    const selection = defaultSelection(roadmap, activeEpics.value, epics.value, fromQuery);
    selectedPhase.value = selection.phaseId;
    selectedEpic.value = selection.epicId;
    ensureEpicFlowsLoaded(epicIdsForPhase(selectedPhase.value));
    if (selectedEpic.value) loadEpicModeFlow();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
  // Only once `loading` drops: until then the render reads nothing else, so
  // no flush is queued and nextTick would resolve before the rows exist.
  if (error.value === null) await revealSelection();
}

onMounted(load);
watch([project, sessionKey], load);

function selectPhase(phaseId: string) {
  selectedPhase.value = phaseId;
  selectedEpic.value = null;
  router.replace({ query: { ...route.query, phase: phaseId, epic: undefined } });
  ensureEpicFlowsLoaded(epicIdsForPhase(phaseId));
}

function selectEpic(epicId: string) {
  selectedEpic.value = epicId;
  selectedPhase.value = null;
  router.replace({ query: { ...route.query, epic: epicId, phase: undefined } });
  ensureEpicFlowsLoaded([epicId]);
  epicPlanVersion.value = '';
  loadEpicModeFlow();
}

function setEpicPlanVersion(value: string) {
  epicPlanVersion.value = value;
  loadEpicModeFlow();
}

// UI spec Part 2 — the sections, in liveness order. Scoped to one project the
// heading goes (the topbar names the project) and so do other projects'
// phase-less epic sections.
const sections = computed(() =>
  buildRoadmapSections(
    milestones.value ?? [],
    epics.value,
    activeEpics.value,
    project.value ? undefined : overviewProjects.value,
    project.value ?? null,
  ),
);
const showHeadings = computed(() => !project.value);

/** The section whose lanes hold the selection; null when it sits in none. */
const hostSection = computed(
  () =>
    sections.value.find((s) =>
      sectionHolds(s, { phaseId: selectedPhase.value, epicId: selectedEpic.value }),
    ) ?? null,
);

/**
 * The page's stack: every section, with the selection's EpicBlock right
 * after the section holding it (last when none does), so the detail reads
 * under the lane that was picked rather than below every project.
 */
const stackItems = computed(() => {
  const items: Array<{ key: string; section: RoadmapSection | null }> = sections.value.map(
    (section) => ({ key: `${section.kind}:${section.project}`, section }),
  );
  const host = hostSection.value;
  const at = host === null ? items.length : items.findIndex((item) => item.section === host) + 1;
  items.splice(at, 0, { key: 'selection', section: null });
  return items;
});

// DS4 S4 R4 — the phone picker's name; with several sections each picker
// names its project, as two selects both called "Phase" could not be told apart.
function pickerLabel(section: RoadmapSection): string {
  const noun = section.kind === 'phase' ? 'phase' : 'epic';
  if (sections.value.length === 1) return noun === 'phase' ? 'Phase' : 'Epic';
  return `${section.title} ${noun}`;
}

// §2.3 — per-side expand state, per tab session, keyed by project so it
// survives load()'s reload on a project/session switch.
const expandedWindows = ref(loadExpanded(sessionStorage, ROADMAP_WINDOW_SCOPE));

function windowExpanded(section: RoadmapSection) {
  return {
    earlier: expandedWindows.value.has(windowExpandId(section.project, 'earlier')),
    later: expandedWindows.value.has(windowExpandId(section.project, 'later')),
  };
}

function toggleWindow(section: RoadmapSection, side: WindowSide) {
  expandedWindows.value = toggleExpanded(
    expandedWindows.value,
    windowExpandId(section.project, side),
  );
  saveExpanded(sessionStorage, ROADMAP_WINDOW_SCOPE, expandedWindows.value);
}

/**
 * §2.3 — a deep link to a lane outside the window opens the side it is on
 * (stored, so "Show fewer" closes it again), then scrolls the selected row
 * into view and focuses it. A selection already on screen is left alone.
 */
async function revealSelection() {
  const host = hostSection.value;
  if (!host) return;
  const side = selectionSide(host, { phaseId: selectedPhase.value, epicId: selectedEpic.value });
  if (side === null) return;
  const id = windowExpandId(host.project, side);
  if (!expandedWindows.value.has(id)) {
    expandedWindows.value = toggleExpanded(expandedWindows.value, id);
    saveExpanded(sessionStorage, ROADMAP_WINDOW_SCOPE, expandedWindows.value);
  }
  await nextTick();
  const row = document.querySelector<HTMLElement>('.lrow[aria-current="true"]');
  row?.scrollIntoView({ block: 'nearest' });
  row?.focus();
}

const selectedPhaseData = computed(
  () => (milestones.value ?? []).find((m) => m.milestoneId === selectedPhase.value) ?? null,
);

/** Epic mode (spec §1) — one epic, standalone, built from `epicModeFlow`. */
const selectedEpicData = computed(() => {
  if (!selectedEpic.value) return null;
  const epicId = selectedEpic.value;
  const flow = epicModeFlow.value;
  if (flow === undefined) {
    return {
      epicId,
      statusTone: 'neutral' as KitTone,
      statusLabel: 'Loading',
      project: epicProject(milestones.value ?? [], epicId, project.value ?? null),
      planVersionOptions: planVersionOptions(null),
      planVersion: epicPlanVersion.value,
      loading: true,
      error: false,
      tasksTotal: 0,
      tasksCompleted: 0,
      waves: [],
      phase: epicPhase(milestones.value ?? [], epicId),
    };
  }
  if (flow === 'failed') {
    return {
      epicId,
      statusTone: 'neutral' as KitTone,
      statusLabel: 'Unavailable',
      project: epicProject(milestones.value ?? [], epicId, project.value ?? null),
      planVersionOptions: planVersionOptions(null),
      planVersion: epicPlanVersion.value,
      loading: false,
      error: true,
      tasksTotal: 0,
      tasksCompleted: 0,
      waves: [],
      phase: epicPhase(milestones.value ?? [], epicId),
    };
  }
  const epicDates = epicDatesFor(milestones.value ?? [], epicId);
  const { statusTone, statusLabel } = epicDates
    ? epicStatusFromServerStatus(epicDates.status)
    : epicStatusFromFlow(flow);
  return {
    epicId,
    statusTone,
    statusLabel,
    project: epicProject(milestones.value ?? [], epicId, project.value ?? null),
    planVersionOptions: planVersionOptions(flow),
    planVersion: epicPlanVersion.value,
    loading: false,
    error: false,
    tasksTotal: flow.nodes.length,
    tasksCompleted: flow.nodes.filter((n) => isTaskOver(n.taskStatus)).length,
    waves: buildWaveList(flow),
    phase: epicPhase(milestones.value ?? [], epicId),
    statusCounts: epicDates?.statusCounts,
    prUrl: epicDates?.prUrl ?? null,
    sourcePrompt: epicDates?.sourcePrompt ?? null,
  };
});

/** Phase mode (S2/S3) — one section per epic, each with its own WaveList. */
const epicSections = computed(() => {
  const phase = selectedPhaseData.value;
  if (!phase) return [];
  return phase.epicIds.map((epicId) => {
    const flow = epicFlows.value.get(epicId);
    if (flow === undefined) {
      return {
        epicId,
        statusTone: 'neutral' as KitTone,
        statusLabel: 'Loading',
        tasksTotal: null,
        tasksCompleted: null,
        waves: [],
      };
    }
    if (flow === 'failed') {
      return {
        epicId,
        statusTone: 'neutral' as KitTone,
        statusLabel: 'Unavailable',
        tasksTotal: 0,
        tasksCompleted: 0,
        failed: true,
        waves: [],
      };
    }
    const epicDates = epicDatesFor(milestones.value ?? [], epicId);
    const { statusTone, statusLabel } = epicDates
      ? epicStatusFromServerStatus(epicDates.status)
      : epicStatusFromFlow(flow);
    return {
      epicId,
      statusTone,
      statusLabel,
      tasksTotal: flow.nodes.length,
      tasksCompleted: flow.nodes.filter((n) => isTaskOver(n.taskStatus)).length,
      waves: buildWaveList(flow),
    };
  });
});

// Pattern 9 (KanbanBoard.vue) — a WaveTaskCard click opens TaskPeekPanel;
// Escape returns focus to the card that opened it.
const peekTaskId = ref<string | null>(null);
let lastFocusedCard: HTMLElement | null = null;

function openPeek(taskId: string) {
  lastFocusedCard = document.activeElement as HTMLElement | null;
  peekTaskId.value = taskId;
}
async function closePeek() {
  const card = lastFocusedCard;
  peekTaskId.value = null;
  // Dialog's inert-release runs on unmount, one render flush after this —
  // see KanbanBoard.vue's closePeek() for the same wait.
  await nextTick();
  card?.focus();
}
</script>

<template>
  <div>
    <div class="bs-roadmap-page__toolbar">
      <div class="bs-roadmap-page__toolbar-actions">
        <!-- WorkPage teleports the Kanban/Roadmap SegmentedControl here on
             desktop/tablet (UI audit, fix round 1; merge-main fix round 2) —
             see WorkPage.vue and KanbanPage.vue's matching toolbar. -->
        <span id="bs-work-view-switch" />
      </div>
    </div>

    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>

    <template v-else-if="loading">
      <Skeleton :height="200" />
    </template>

    <EmptyState
      v-else-if="!hasRoadmapContent(milestones ?? [], epics)"
      :icon="MapIcon"
      title="No roadmap yet."
      body="Phases and epics will appear here once work starts."
    />

    <div v-else class="rm-stack">
      <!-- UI spec Part 2 — one section per project, the EpicBlock right after
           the section holding the selection (stackItems). -->
      <template v-for="item in stackItems" :key="item.key">
        <RoadmapProjectSection
          v-if="item.section"
          :section="item.section"
          :show-heading="showHeadings"
          :expanded="windowExpanded(item.section)"
          :selected-phase="selectedPhase"
          :selected-epic="selectedEpic"
          :hosts-selection="item.section === hostSection"
          :picker-label="pickerLabel(item.section)"
          @toggle="(side) => item.section && toggleWindow(item.section, side)"
          @select-phase="selectPhase"
          @select-epic="selectEpic"
        />
        <EpicBlock
          v-else-if="selectedPhaseData"
          :name="selectedPhaseData.name"
          :status-tone="milestoneStatusKitTone(selectedPhaseData.status)"
          :status-label="milestoneStatusLabel(selectedPhaseData.status)"
          :tasks-total="selectedPhaseData.tasksTotal"
          :tasks-completed="selectedPhaseData.tasksCompleted"
          :status-counts="selectedPhaseData.statusCounts"
          :epics="epicSections"
          @select="openPeek"
          @select-epic="selectEpic"
        />
        <EpicBlock
          v-else-if="selectedEpicData"
          :epic="selectedEpicData"
          @select="openPeek"
          @update:plan-version="setEpicPlanVersion"
          @back-to-phase="selectPhase"
        />
      </template>
    </div>

    <TaskPeekPanel
      v-if="peekTaskId"
      :task-id="peekTaskId"
      @close="closePeek"
      @open-full="(id) => router.push(`/tasks/${encodeURIComponent(id)}`)"
    />
  </div>
</template>
