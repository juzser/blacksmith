<script setup lang="ts">
// Flow — design-spec addendum (Phase 6b, ui/docs/design-spec.md's new §5.9,
// recorded per this task's own spec-authoring instruction). The active
// plan version's task DAG, @vue-flow/core (docs/standards/stack.md's
// sanctioned dependency): custom DOM task nodes styled purely with HDS
// tokens, edges styled by edge_type, wave columns from graph.ts's own
// waveLayers() (exposed via /api/flow — "no layout library" per stack.md),
// live pulse (opacity-only under prefers-reduced-motion, .flow-node--live
// CSS), plan-version diff, sr-only table alternative (a11y), epic/project
// filter, click node -> task detail.
//
// Operator directive 1 (Phase 6b round 3): orientation is HORIZONTAL —
// waves progress left->right with tasks in the same wave stacked
// vertically in that wave's column. Every edge is dashed + Vue Flow
// `animated: true` (marching dashes, its own dist/style.css keyframe),
// reduced-motion turns the animation off (hds-components.css); running
// nodes get a small pulsing dot (`.flow-node__live`) instead of pulsing
// the whole node border.
//
// Operator directive (Phase 6b round 11): "Flow node cần tách nhau ra và
// hiển thị rõ ràng hơn". The geometry that used to sit here as two bare
// constants now lives in lib/flowLayout.ts, where it is unit-tested. Two
// things changed as a result:
//
//   * Every step is stated as `box + gap` (232 + 96 across, 132 + 48 down)
//     instead of the old 220/96, which reserved twenty pixels between
//     columns and four between stacked nodes — the nodes read as one
//     block. Waves are also centred on y = 0, so a fan-out spreads either
//     side of its source instead of hanging below it.
//   * The wave header is a NODE now, not the absolutely-positioned
//     `.flow-wave-band` this page used to paint behind the canvas. A band
//     is laid out in page pixels while the graph is drawn in viewport
//     pixels, so `fit-view-on-init` alone was enough to put the two out of
//     register and any pan or zoom widened the gap — the same defect
//     design-spec.md §A.4-5 already records. A node cannot drift, because
//     it lives in the coordinate space of the tasks it heads.
//
// Deviation, flagged (ui/docs/DESIGN.md): MiniMap+Controls are separate
// npm packages (@vue-flow/minimap, @vue-flow/controls) NOT in
// docs/standards/stack.md's sanctioned dependency list (only
// "@vue-flow/core" is sanctioned there) — adding them needs a written
// justification attached to the epic spec (stack.md's own deviation
// policy), out of this task's authority to grant itself. Controls is
// built from @vue-flow/core's own useVueFlow() viewport methods (no new
// dependency); MiniMap is skipped rather than faked.
import '@vue-flow/core/dist/style.css';
import { Panel, useVueFlow, VueFlow } from '@vue-flow/core';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Banner from '../components/hds/Banner.vue';
import Button from '../components/hds/Button.vue';
import EmptyState from '../components/hds/EmptyState.vue';
import Lozenge from '../components/hds/Lozenge.vue';
import PageHeader from '../components/hds/PageHeader.vue';
import Select from '../components/hds/Select.vue';
import Skeleton from '../components/hds/Skeleton.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { type FlowGraph, fetchFlow, fetchOverview, selectableEpics } from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { ALL_EPICS, EPIC_LIST_UNAVAILABLE, epicOptions, retainedEpic } from '../lib/epicPicker.js';
import { dependsOnLabel, flowLayoutNodes, planVersionOptions } from '../lib/flowLayout.js';
import { pluralize, summarize } from '../lib/format.js';
import { taskStatusTone } from '../lib/taxonomy.js';

const router = useRouter();
const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Flow' }]);
const { project } = useProjectContext();

const graph = ref<FlowGraph | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
const epics = ref<string[]>([]);
const selectedEpic = ref(ALL_EPICS);
const planVersion = ref<number | null>(null);

const { zoomIn, zoomOut, fitView } = useVueFlow();

// Supplementary, and deliberately non-blocking: the graph is the page. The
// picker reads /api/overview while the canvas reads /api/flow, so it can fail
// on its own — and awaiting it unguarded ahead of load() meant fetchFlow()
// never ran, `loading` never cleared, and the operator sat on the skeleton
// with `error` still null (D-222).
const epicsFailed = ref(false);

async function loadEpics() {
  try {
    const ov = await fetchOverview(undefined, project.value);
    epics.value = selectableEpics(ov);
    epicsFailed.value = false;
  } catch {
    epicsFailed.value = true;
  }
}

async function load() {
  error.value = null;
  loading.value = true;
  try {
    graph.value = await fetchFlow({
      project: project.value,
      epic: selectedEpic.value || undefined,
      planVersion: planVersion.value ?? undefined,
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await loadEpics();
  await load();
});
watch([selectedEpic, planVersion], load);
// The project is the one input that changes the epic list itself, and
// `load()` fetches only /api/flow — so it needs its own watcher. `setProject`
// on /flow is a query push on the same route record, which reuses the
// component rather than remounting it, and this page has no poll: with the
// project folded into the watcher above, the picker stayed frozen on the
// previous project's epics for good, and the new project's epics could not be
// selected at all without a manual reload (D-228).
watch(project, async () => {
  await loadEpics();
  selectedEpic.value = retainedEpic(selectedEpic.value, epics.value);
  await load();
});

// Round 11: positions, wave columns and the wave-label nodes all come from
// lib/flowLayout.ts — pure, and covered by ui/test/flowLayout.test.ts under
// vitest's node environment. The reconciliation this page used to do inline
// (`waves.findIndex(...)` per node, O(nodes x waves), and a silent fallback
// to index 0 for a node the wave list had forgotten) is flowColumns()' job
// now, where the forgotten node lands in its own wave instead of on top of
// whatever is first in wave 0.
const flowNodes = computed(() => (graph.value ? flowLayoutNodes(graph.value) : []));

// Operator directive 1 (Phase 6b round 3): every edge is dashed (a default
// dash pattern fills in for the two types that were previously solid), with
// Vue Flow's own `animated` edge treatment (marching dashes, its vendored
// dist/style.css `.vue-flow__edge.animated path` + `dashdraw` keyframe — no
// new dependency). `prefers-reduced-motion` turns the animation off (static
// dashed) via a CSS override below, same pattern as `.flow-node--live`.
const EDGE_STYLE: Record<string, { dash?: string; width: number }> = {
  artifact: { dash: '4,4', width: 2 },
  'claim-order': { dash: '6,4', width: 1.5 },
  'spec-clause': { dash: '2,3', width: 1 },
  'regression-test': { dash: '4,4', width: 1 },
  'research-brief': { dash: '2,5', width: 1 },
};

const flowEdges = computed(() => {
  if (!graph.value) return [];
  return graph.value.edges.map((e) => {
    const style = EDGE_STYLE[e.edgeType] ?? { dash: '4,4', width: 1 };
    return {
      id: `${e.task}-${e.dependsOn}`,
      source: e.dependsOn,
      target: e.task,
      animated: true,
      // Fix-round (uiux S2 #4): --ds-border measured 1.27:1 against the
      // canvas surface in both themes — invisible. --ds-text-subtlest
      // clears the 3:1 UI-graphics floor in both themes (light 4.83:1,
      // dark 7.76:1, contrast.py) and is already used for the wave
      // labels on this same page, so edges and labels now read at a
      // consistent, visible weight.
      style: {
        strokeDasharray: style.dash,
        strokeWidth: style.width,
        stroke: 'var(--ds-text-subtlest)',
      },
    };
  });
});

const waveCount = computed(() => graph.value?.waves.length ?? 0);
// D-165: sourced from the graph's own planVersions, not from its (already
// filtered) nodes — see planVersionOptions()'s header.
const versionOptions = computed(() => planVersionOptions(graph.value));

function onPlanVersionChange(value: string) {
  planVersion.value = value ? Number(value) : null;
}

function goToTask(taskId: string) {
  router.push(`/tasks/${encodeURIComponent(taskId)}`);
}
</script>

<template>
  <div class="app-page app-page--full-bleed">
    <PageHeader title="Flow">
      <template #actions>
        <Select v-model="selectedEpic" :options="epicOptions(epics)" aria-label="Epic" />
        <Select :model-value="planVersion === null ? '' : String(planVersion)" :options="versionOptions" aria-label="Plan version" @update:model-value="onPlanVersionChange" />
      </template>
    </PageHeader>

    <Banner v-if="!error && epicsFailed" tone="warning" show-retry @retry="loadEpics">
      {{ EPIC_LIST_UNAVAILABLE }}
    </Banner>
    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>
    <Skeleton v-else-if="loading" height="500" />
    <EmptyState v-else-if="canClaimEmpty(graph !== null, graph?.nodes.length ?? 0)" icon="git-merge">No tasks in this plan yet.</EmptyState>

    <template v-else>
      <div class="flow-canvas">
        <VueFlow :nodes="flowNodes" :edges="flowEdges" :nodes-draggable="false" fit-view-on-init>
          <!-- Round 11: the wave header is a node, so it pans and zooms with
               the column it heads. It is `selectable: false, focusable: false,
               draggable: false` in flowLayout.ts and carries no handles, so it
               stays out of the tab order and can never be wired into the DAG;
               the sr-only table below is what reports waves to a screen
               reader. -->
          <template #node-wave="{ data }">
            <div class="flow-wave-label" aria-hidden="true">
              <span class="flow-wave-label__name">Wave {{ data.wave }}</span>
              <span class="flow-wave-label__count">{{ pluralize(data.count, 'task') }}</span>
            </div>
          </template>
          <template #node-task="{ data }">
            <div
              class="flow-node"
              :class="{ 'flow-node--live': !!data.liveAgentRole }"
              role="link"
              tabindex="0"
              :aria-label="`${summarize(data.title ?? data.taskId)}, ${data.taskStatus}, opens task detail`"
              :title="data.title ? `${data.taskId}\n\n${data.title}` : data.taskId"
              @click="goToTask(data.taskId)"
              @keydown.enter="goToTask(data.taskId)"
            >
              <!-- Operator directive (round 6): "một block bị quá dài, và quá
                   nhiều text, chỉ cần tóm tắt ngắn". `title` here is
                   tasks.objective (db/queries.ts:1406) — a paragraph, 942-1472
                   chars on the live plan — so the node label is summarize()d to
                   one sentence and the CSS clamps it to two lines. The full
                   objective is still reachable three ways: the native tooltip
                   on this node, the sr-only table below, and the task detail
                   page this node links to. Same reason the aria-label is
                   summarized: focusing a node should announce where it goes,
                   not read out a paragraph. -->
              <!-- Round 11 ("hiển thị rõ ràng hơn"): the node used to show a
                   summarized objective and nothing that named the task. Two
                   nodes whose objectives summarize alike were indistinguishable
                   at a glance. The id is the eyebrow line, mono and clipped to
                   one line; the full id is in the tooltip and the sr-only
                   table. -->
              <span class="flow-node__id">{{ data.taskId }}</span>
              <span class="flow-node__title">{{ summarize(data.title ?? data.taskId) }}</span>
              <div class="flow-node__tags">
                <Lozenge :tone="taskStatusTone(data.taskStatus)" variant="subtle">{{ data.taskStatus }}</Lozenge>
                <Lozenge v-if="data.liveAgentRole" variant="outline">{{ data.liveAgentRole }}</Lozenge>
              </div>
              <!-- Operator directive 1 (Phase 6b round 3): a small pulsing
                   dot distinct from the node border, rather than pulsing the
                   whole node — reduced-motion keeps the dot filled (static)
                   and this same "running" text, which is always rendered
                   (not sr-only), so nothing disappears when motion drops. -->
              <span v-if="data.liveAgentRole" class="flow-node__live">
                <span class="flow-node__live-dot" aria-hidden="true" />
                running
              </span>
            </div>
          </template>
          <Panel position="bottom-left">
            <div style="display: flex; gap: var(--ds-space-1)">
              <Button variant="outline" size="icon-sm" aria-label="Zoom in" icon="plus" @click="zoomIn()" />
              <Button variant="outline" size="icon-sm" aria-label="Zoom out" icon="minus" @click="zoomOut()" />
              <Button variant="outline" size="sm" @click="fitView()">Fit view</Button>
            </div>
          </Panel>
        </VueFlow>
      </div>

      <!-- sr-only alternative (a11y — inline SVG/DOM graph has no built-in text alternative). -->
      <table class="sr-only">
        <caption>
          Task DAG: {{ pluralize(graph.nodes.length, 'task') }} across
          {{ pluralize(waveCount, 'wave') }}
        </caption>
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Status</th>
            <th scope="col">Wave</th>
            <th scope="col">Depends on</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="n in graph.nodes" :key="n.taskId">
            <td>{{ n.taskId }}<template v-if="n.title">: {{ n.title }}</template></td>
            <td>{{ n.taskStatus }}</td>
            <td>{{ n.wave }}</td>
            <td>{{ dependsOnLabel(graph, n.taskId) }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>
