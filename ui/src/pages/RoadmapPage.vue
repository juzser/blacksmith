<script setup lang="ts">
// Roadmap — DS4 S2 rewrite (signed-off spec). Replaces the VueFlow canvas
// with a plain horizontal swimlane (RoadmapSwimlane.vue) plus a goal/epics
// card (EpicBlock.vue, phase mode only — epic mode and the wave toggle are
// S3). `@vue-flow/core` stays a dependency for FlowPage/SessionsPage; it is
// simply unused on this page now.
//
// Below 640px the swimlane's own `.rm-scroll` region still scrolls sideways
// rather than reflowing into a stacked phone layout — a real phone layout is
// S4, out of scope here; this is the simplest fallback that avoids the page
// itself scrolling sideways.
import { Map as MapIcon } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import EpicBlock from '../components/EpicBlock.vue';
import Banner from '../components/kit/Banner.vue';
import EmptyState from '../components/kit/EmptyState.vue';
import Skeleton from '../components/kit/Skeleton.vue';
import RoadmapSwimlane from '../components/RoadmapSwimlane.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useSessionContext } from '../composables/useSessionContext.js';
import {
  type FlowGraph,
  fetchFlow,
  fetchOverview,
  fetchRoadmap,
  type MilestoneProgress,
  selectableEpics,
} from '../lib/api.js';
import { defaultSelection } from '../lib/roadmapSelection.js';
import {
  buildEpicOnlySwimlane,
  buildSwimlane,
  hasRoadmapContent,
  taskCountLabel,
} from '../lib/roadmapSwimlane.js';
import {
  isTaskOver,
  type KitTone,
  milestoneStatusKitTone,
  milestoneStatusLabel,
} from '../lib/taxonomy.js';

const router = useRouter();
const route = useRoute();
const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Roadmap' }]);
const { project } = useProjectContext();
const { sessionScope, sessionKey } = useSessionContext();

const milestones = ref<MilestoneProgress[] | null>(null);
const epics = ref<string[]>([]);
const activeEpics = ref<string[]>([]);
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
    error.value = null;

    const fromQuery = {
      phase: typeof route.query.phase === 'string' ? route.query.phase : null,
      epic: typeof route.query.epic === 'string' ? route.query.epic : null,
    };
    const selection = defaultSelection(roadmap, activeEpics.value, epics.value, fromQuery);
    selectedPhase.value = selection.phaseId;
    selectedEpic.value = selection.epicId;
    ensureEpicFlowsLoaded(epicIdsForPhase(selectedPhase.value));
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
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
}

const swimlane = computed(() => {
  if (!milestones.value) return { rows: [], nowOffset: 50, months: [] };
  if (milestones.value.length === 0) return buildEpicOnlySwimlane(epics.value);
  return buildSwimlane(milestones.value, new Date());
});

const selectedPhaseData = computed(
  () => (milestones.value ?? []).find((m) => m.milestoneId === selectedPhase.value) ?? null,
);

/** Phase mode only (S2) — epic-standalone mode is S3. */
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
      };
    }
    const total = flow.nodes.length;
    const completed = flow.nodes.filter((n) => isTaskOver(n.taskStatus)).length;
    const anyInFlight = flow.nodes.some((n) => !isTaskOver(n.taskStatus));
    const status =
      total === 0
        ? 'todo'
        : completed === total
          ? 'completed'
          : anyInFlight
            ? 'in-progress'
            : 'todo';
    // Fix round 2 #3: the label is always one of a fixed three ("Done" /
    // "In progress" / "To do"), so the tone must key off that same label,
    // not off whichever specific task status happens to be driving
    // `anyInFlight` — a `reviewing`/`grading` task made the epic Tag purple
    // while still reading "In progress", disagreeing with the phase Tag
    // right above it (spec: "the progress tone for 'In progress'").
    const statusTone: KitTone =
      status === 'completed' ? 'done' : status === 'in-progress' ? 'progress' : 'neutral';
    return {
      epicId,
      statusTone,
      statusLabel:
        status === 'completed' ? 'Done' : status === 'in-progress' ? 'In progress' : 'To do',
      tasksTotal: total,
      tasksCompleted: completed,
    };
  });
});
</script>

<template>
  <div>
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
      <RoadmapSwimlane
        :swimlane="swimlane"
        :selected-phase="selectedPhase"
        :selected-epic="selectedEpic"
        @select-phase="selectPhase"
        @select-epic="selectEpic"
      />

      <EpicBlock
        v-if="selectedPhaseData"
        :name="selectedPhaseData.name"
        :status-tone="milestoneStatusKitTone(selectedPhaseData.status)"
        :status-label="milestoneStatusLabel(selectedPhaseData.status)"
        :tasks-total="selectedPhaseData.tasksTotal"
        :tasks-completed="selectedPhaseData.tasksCompleted"
        :epics="epicSections"
      />
      <p v-else-if="selectedEpic" class="muted">{{ taskCountLabel(0, 0) }}</p>
    </div>
  </div>
</template>
