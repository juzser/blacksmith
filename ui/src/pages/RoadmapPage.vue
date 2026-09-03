<script setup lang="ts">
// Roadmap — design-spec.md §5.4. Phase 6b additions: operator directive 4 —
// a project identity chip per milestone, and a mini-timeline under each
// progress bar (3 most recent DONE tasks, success tone + relative ts; 3 NEXT
// tasks, neutral, plan/dependency order).
//
// Operator directive (Phase 6b round 6): "Trong dashboard, phần roadmap,
// display theo dạng VueFlow" — the card list becomes a @vue-flow/core
// diagram, same sanctioned dependency and same house pattern as FlowPage
// (custom DOM nodes styled with kit tokens, useVueFlow() viewport controls in
// a Panel rather than the unsanctioned @vue-flow/controls package, sr-only
// table alternative). Nothing the cards showed was dropped: each node still
// carries name + status Lozenge + identity chips + goal + ProgressBar + the
// Recent/Next mini-timeline, and both navigations (header → kanban filtered
// to the milestone, timeline row → task detail) are unchanged.
//
// The graph's shape is dictated by the data, not by taste: MilestoneProgress
// (api.ts:58-72) has `sequence` and NO dependency field, so the only edge
// this API can justify is "next in sequence". It is drawn as a chain, one
// lane per project, left to right — see lib/roadmapFlow.ts, which holds the
// layout as pure functions so it is unit-tested under ui/vitest.config.ts's
// node environment instead of only through Playwright.
//
// Operator directive (Phase 6b round 8): "hiển thị line nối giữa các node
// thẳng, có animation ở node đang running" — edges become `type: 'straight'`
// (a milestone node is content-sized, so same-lane nodes share a top edge but
// not a height, and Vue Flow's default bezier bowed between their offset
// handles), and .roadmap-node--live gains a pulsing ring on top of its live
// border. See ds-components.css for why that ring animates box-shadow and
// never opacity.
//
// Deviation, flagged (same as FlowPage): @vue-flow/minimap and
// @vue-flow/controls are NOT in docs/standards/stack.md's sanctioned list —
// only "@vue-flow/core" is — so controls are rebuilt from useVueFlow() and
// no minimap is faked. FlowPage's absolutely-positioned wave bands are
// deliberately NOT copied here: those are painted in canvas coordinates and
// so drift out of register as soon as the user pans. Lanes are identified
// instead by the project IdentityChip that every node already carries, which
// stays correct under pan and zoom.
import '@vue-flow/core/dist/style.css';
import { Panel, useVueFlow, VueFlow } from '@vue-flow/core';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Banner from '../components/ds/Banner.vue';
import Button from '../components/ds/Button.vue';
import EmptyState from '../components/ds/EmptyState.vue';
import Lozenge from '../components/ds/Lozenge.vue';
import PageHeader from '../components/ds/PageHeader.vue';
import Skeleton from '../components/ds/Skeleton.vue';
import Toolbar from '../components/ds/Toolbar.vue';
import IdentityChip from '../components/IdentityChip.vue';
import ProgressBar from '../components/ProgressBar.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { fetchRoadmap, type MilestoneProgress } from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { formatRelative, summarize } from '../lib/format.js';
import {
  partitionByKind,
  roadmapFlowEdges,
  roadmapFlowNodes,
  roadmapLanes,
} from '../lib/roadmapFlow.js';
import { milestoneStatusTone } from '../lib/taxonomy.js';

const router = useRouter();
const { setBreadcrumb } = useBreadcrumb();
setBreadcrumb([{ label: 'Roadmap' }]);
const { project } = useProjectContext();
const { zoomIn, zoomOut, fitView } = useVueFlow();

/** Null until a fetch lands. That distinction is the whole guard on the empty state below. */
const milestones = ref<MilestoneProgress[] | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
const search = ref('');
/**
 * Operator directive (Phase 10): the page answers "what has this factory
 * built", so it opens on the projects the factory built FOR someone and
 * leaves its own ten phases and the dogfood project's four milestones
 * behind the toggle. Not persisted -- the default is the directive, and a
 * remembered preference would quietly make it something else.
 */
const showInternal = ref(false);

async function load() {
  error.value = null;
  loading.value = true;
  try {
    milestones.value = await fetchRoadmap(undefined, project.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(project, load);

const filtered = computed(() =>
  (milestones.value ?? []).filter((m) => m.name.toLowerCase().includes(search.value.toLowerCase())),
);

const partition = computed(() => partitionByKind(filtered.value, showInternal.value));
const shown = computed(() => partition.value.shown);

// Operator directive 4 (Phase 6b round 3): group by project — but only when
// NOT already scoped to one project (project.value set, e.g.
// /p/:project/roadmap) and the filtered set actually spans more than one.
// Same rule as the old SectionHeading grouping, now expressed as lanes.
const lanes = computed(() => roadmapLanes(shown.value, project.value));
const flowNodes = computed(() => roadmapFlowNodes(lanes.value));
const flowEdges = computed(() =>
  roadmapFlowEdges(lanes.value).map((e) => ({
    ...e,
    // Same edge treatment as FlowPage: dashed, --ds-text-subtlest (--ds-border
    // measured 1.27:1 against the canvas and is invisible; subtlest clears the
    // 3:1 UI-graphics floor in both themes). The `straight` edge type that
    // makes these connectors run direct instead of bowing comes from
    // roadmapFlow.ts, where it is unit-tested — only the paint is set here.
    style: { strokeDasharray: '4,4', strokeWidth: 1.5, stroke: 'var(--ds-text-subtlest)' },
  })),
);

function goToKanban(m: MilestoneProgress) {
  router.push({ path: '/kanban', query: { milestone: m.milestoneId } });
}

function goToTask(taskId: string) {
  router.push(`/tasks/${encodeURIComponent(taskId)}`);
}
</script>

<template>
  <div class="app-page app-page--full-bleed">
    <PageHeader title="Roadmap" />

    <Toolbar :count="`${shown.length} milestones`">
      <input v-model="search" type="search" class="raw-input" aria-label="Search milestone name" placeholder="Search name…" style="height: var(--ds-control-height); border: 1px solid var(--ds-border); border-radius: var(--ds-radius-control); padding: 0 var(--ds-space-2); background: var(--ds-surface); color: var(--ds-text)" />
      <!-- The filter says out loud what it is holding back. A page that
           silently dropped fourteen of fourteen rows would look broken
           rather than filtered (D-119). -->
      <Button
        v-if="partition.hiddenCount > 0 || showInternal"
        variant="outline"
        size="sm"
        :aria-pressed="showInternal"
        @click="showInternal = !showInternal"
      >
        {{ showInternal ? 'Hide the factory’s own roadmap' : `Show the factory’s own roadmap (${partition.hiddenCount})` }}
      </Button>
    </Toolbar>

    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>

    <template v-else-if="loading">
      <Skeleton height="560" />
    </template>

    <!-- Two different emptinesses, and they must not read alike. Nothing
         built yet is the expected state of a fresh clone and says what to do
         about it; nothing MATCHING is a filter the operator can widen. -->
    <EmptyState v-else-if="canClaimEmpty(milestones !== null, shown.length) && partition.hiddenCount > 0 && search === ''" icon="map">
      This factory has not built a project yet. The {{ partition.hiddenCount }} milestone{{ partition.hiddenCount === 1 ? '' : 's' }} it does hold belong to itself and to {{ partition.hiddenProjects.join(', ') }}. Run <code>/bs new</code> to start one.
    </EmptyState>

    <EmptyState v-else-if="canClaimEmpty(milestones !== null, shown.length)" icon="map">No milestones match these filters.</EmptyState>

    <template v-else>
      <div class="roadmap-canvas">
        <VueFlow :nodes="flowNodes" :edges="flowEdges" :nodes-draggable="false" fit-view-on-init>
          <!--
            Fix-round (uiux S2 #8 + S3 #9), carried into the node template
            unchanged: the block is NOT one big role="button" wrapping the
            mini-timeline's own <button> rows — nested interactive elements
            confuse both a screen reader's element list and Space/Enter
            handling. Only the header is interactive (role="link", matching
            ProjectsPage/TaskCard); the timeline rows are plain siblings.
          -->
          <template #node-milestone="{ data }">
            <article class="roadmap-node" :class="{ 'roadmap-node--live': data.status === 'in-progress' }">
              <div
                role="link"
                tabindex="0"
                :aria-label="`${data.name}, ${data.status}, opens kanban filtered to this milestone`"
                style="cursor: pointer"
                @click="goToKanban(data)"
                @keydown.enter="goToKanban(data)"
              >
                <div style="display: flex; align-items: center; gap: var(--ds-space-2); flex-wrap: wrap">
                  <span class="roadmap-node__title">{{ data.name }}</span>
                  <Lozenge :tone="milestoneStatusTone(data.status)">{{ data.status }}</Lozenge>
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: var(--ds-space-1); margin-top: var(--ds-space-1)">
                  <IdentityChip :id="data.project" />
                  <IdentityChip v-for="e in data.epicIds" :key="e" :id="e" />
                </div>
                <!-- A milestone goal is free text and can run long; the node
                     shows a one-line summary and keeps the full goal in the
                     native tooltip (same rule as FlowPage's node title). -->
                <p v-if="data.goal" class="roadmap-node__goal" :title="data.goal">{{ summarize(data.goal, 110) }}</p>
              </div>

              <div style="margin-top: var(--ds-space-2)">
                <ProgressBar :value="data.tasksCompleted" :total="data.tasksTotal || 1" :label="`${data.name} progress`" />
              </div>

              <div class="mini-timeline">
                <div class="mini-timeline__col">
                  <span class="mini-timeline__label">Recent</span>
                  <div v-if="(data.recentDone ?? []).length === 0" style="font-size: var(--ds-text-xs); color: var(--ds-text-subtlest)">Nothing done yet.</div>
                  <button
                    v-for="t in data.recentDone"
                    :key="t.taskId"
                    type="button"
                    class="mini-timeline__row"
                    style="background: none; border: none; padding: 0; cursor: pointer; color: inherit; text-align: left"
                    :title="t.title ?? t.taskId"
                    @click="goToTask(t.taskId)"
                  >
                    <span class="mini-timeline__dot" style="background: var(--ds-success-bold)" />
                    <span class="mini-timeline__row-title">{{ t.title ?? t.taskId }}</span>
                    <span class="mini-timeline__row-meta">{{ formatRelative(t.updatedAt) }}</span>
                  </button>
                </div>
                <div class="mini-timeline__col">
                  <span class="mini-timeline__label">Next</span>
                  <div v-if="(data.nextUp ?? []).length === 0" style="font-size: var(--ds-text-xs); color: var(--ds-text-subtlest)">Nothing queued.</div>
                  <button
                    v-for="t in data.nextUp"
                    :key="t.taskId"
                    type="button"
                    class="mini-timeline__row"
                    style="background: none; border: none; padding: 0; cursor: pointer; color: inherit; text-align: left"
                    :title="t.title ?? t.taskId"
                    @click="goToTask(t.taskId)"
                  >
                    <span class="mini-timeline__dot" style="background: var(--ds-border)" />
                    <span class="mini-timeline__row-title">{{ t.title ?? t.taskId }}</span>
                    <span class="mini-timeline__row-meta">{{ t.dependencyReady ? 'ready' : 'blocked' }}</span>
                  </button>
                </div>
              </div>
            </article>
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

      <!-- sr-only alternative (a11y — a DOM graph carries no text alternative
           for its ORDER; the nodes themselves are readable, the sequence is
           not). Same pattern as FlowPage's task-DAG table. -->
      <table class="sr-only">
        <caption>Roadmap: {{ shown.length }} milestones in sequence order</caption>
        <thead>
          <tr>
            <th scope="col">Milestone</th>
            <th scope="col">Project</th>
            <th scope="col">Status</th>
            <th scope="col">Sequence</th>
            <th scope="col">Tasks done</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in shown" :key="`${m.project}::${m.milestoneId}`">
            <td>{{ m.name }}</td>
            <td>{{ m.project }}</td>
            <td>{{ m.status }}</td>
            <td>{{ m.sequence }}</td>
            <td>{{ m.tasksCompleted }} of {{ m.tasksTotal }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>
