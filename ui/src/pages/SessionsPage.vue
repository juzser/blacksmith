<script setup lang="ts">
// Sessions — a spatial canvas of the runs that are happening right now.
//
// Operator directive: "Đọc repo này https://github.com/eneskirca/nodeterm, có
// cách nào đưa dạng node flow tương tự lên black-smith chạy trên browser
// không?" → "Làm kiểu T1".
//
// The idea taken from nodeterm is the one that costs nothing to adopt: on its
// board the CARDS ARE LIVE SESSIONS, not a static plan. Everything this page
// draws already exists in /api/overview (`runningSessions` +
// `liveAgentEntries`), so T1 adds no dependency, no endpoint, no transport and
// no server change — it is a second rendering of the data Overview's "Now
// running" card already shows as a list.
//
// Deliberately NOT taken: nodeterm's terminals. A live PTY node needs xterm, a
// bidirectional socket and arbitrary command execution from the browser. That
// contradicts design-spec.md §8 ("No WebSockets"), contradicts
// docs/standards/stack.md's Workers-first rule, and would be the largest write
// surface this dashboard has ever had. Left out rather than half-built.
//
// House pattern, same as RoadmapPage/FlowPage: the layout lives in pure
// functions in lib/sessionsFlow.ts so it is unit-tested under
// ui/vitest.config.ts's node environment (ui/test/sessionsFlow.test.ts)
// instead of only through Playwright; this file holds markup, paint and
// navigation only.
//
// Deviation, flagged (identical to RoadmapPage and FlowPage): @vue-flow/core
// is the only graph package docs/standards/stack.md sanctions —
// @vue-flow/minimap and @vue-flow/controls are not — so the viewport controls
// are rebuilt from useVueFlow() inside a <Panel> and no minimap is faked.
import '@vue-flow/core/dist/style.css';
import { Panel, useVueFlow, VueFlow } from '@vue-flow/core';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Banner from '../components/hds/Banner.vue';
import Button from '../components/hds/Button.vue';
import EmptyState from '../components/hds/EmptyState.vue';
import Lozenge from '../components/hds/Lozenge.vue';
import PageHeader from '../components/hds/PageHeader.vue';
import Skeleton from '../components/hds/Skeleton.vue';
import Toolbar from '../components/hds/Toolbar.vue';
import IdentityChip from '../components/IdentityChip.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { fetchOverview, type OverviewResult, type RunningSession } from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { agentScopeLabel } from '../lib/agentScope.js';
import { formatDateTime, formatElapsed, formatRelative, pluralize } from '../lib/format.js';
import {
  activeSessionCount,
  type AgentActivity,
  agentActivity,
  SESSION_ACTIVE_WITHIN_MS,
  type SessionActivity,
} from '../lib/liveness.js';
import {
  bandsPerRowFor,
  SESSION_BAND_CAP,
  sessionGroups,
  sessionsFlowEdges,
  sessionsFlowNodes,
  unattachedAgents,
  visibleBands,
} from '../lib/sessionsFlow.js';

const router = useRouter();
const { setBreadcrumb } = useBreadcrumb();
const { project } = useProjectContext();
const { zoomIn, zoomOut, fitView, nodes: storeNodes } = useVueFlow();

// Same cadence and same endpoint as Overview (design-spec.md §8: polling,
// paused with the tab). This page is a second view of that one payload, so a
// different interval would only make the two disagree on screen.
const POLL_MS = 5000;

const data = ref<OverviewResult | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);

// ONE clock, and it advances only when a fetch lands. Every state word on this
// page ("active", "stalled") is a threshold decision in liveness.ts, and every
// number beside it ("last event 3m ago", "running 5h") is the same measurement
// rendered as text — so they must be measured against the same instant or the
// page contradicts itself. A second 1s useNow() clock for the text alone did
// exactly that: during an API outage a node kept its pulsing `active` dot while
// its own sentence aged past the 15m threshold that dot claims to satisfy.
// Frozen text under the red banner is the honest reading — the canvas ages, it
// does not silently re-date itself — and POLL_MS is as often as the evidence
// behind any of it changes anyway.
const graphNow = ref(new Date().toISOString());

async function load() {
  try {
    data.value = await fetchOverview(undefined, project.value);
    // Only advanced on a SUCCESSFUL fetch — same rule as Overview's
    // last-updated stamp. A failed poll must let the canvas age, not silently
    // re-date the states it is already showing.
    graphNow.value = new Date().toISOString();
    // Cleared on success, not on attempt, and for the reason stated two lines
    // up. Clearing at the top of `load()` left this page under an outage with
    // no banner, no skeleton (`loading` went false on the first failure) and
    // no empty state (`canClaimEmpty` refuses one with `data` null) -- blank
    // for the length of every 5s poll's flight, red only in the gaps between
    // them (D-226, D-240).
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  setBreadcrumb([{ label: project.value ? `${project.value} · Sessions` : 'Sessions' }]);
  load();
});
// `loading` is raised HERE and not inside load(), which the 5s poll also calls
// — flipping it there would flash the skeleton over the canvas every tick.
// Raising it on a project switch is what stops the previous project's bands
// sitting under the new project's breadcrumb while the new fetch is in flight.
// Same split as OverviewPage, which polls the same endpoint.
watch(project, () => {
  setBreadcrumb([{ label: project.value ? `${project.value} · Sessions` : 'Sessions' }]);
  loading.value = true;
  load();
});
const { refresh } = usePoll(load, POLL_MS);

const allGroups = computed(() => (data.value ? sessionGroups(data.value) : []));
// `runningSessions` is every projected session, not just the live ones, so the
// canvas caps what it draws and states the remainder — see lib/sessionsFlow.ts.
const groups = computed(() => visibleBands(allGroups.value).shown);
const hiddenBands = computed(() => visibleBands(allGroups.value).hidden);
// Agents whose session is not in the payload. They are named in a Banner
// rather than drawn, because the canvas has nowhere honest to put them:
// inventing a parent node would be inventing data. See lib/sessionsFlow.ts.
const orphans = computed(() => (data.value ? unattachedAgents(data.value) : []));

// How many band columns to tile is decided from the canvas's MEASURED box, not
// from a device breakpoint: the sidebar collapses at 1024px, so a narrower
// window can leave the canvas wider. Both dimensions, because the winning column
// count is whichever one fitView then draws largest and that fit is bound by
// height as often as by width. The box lives behind `v-else-if="data"`, so it is
// watched into existence rather than read at mount.
//
// `measured` gates the <VueFlow> inside it, and that gate is load-bearing rather
// than cosmetic. Vue Flow syncs its `:nodes` prop through a *pausable* watcher
// (useWatchProps): its own store→model writeback pauses the prop watcher for a
// tick, and a prop change that lands inside that tick is dropped, not queued.
// The first measurement lands exactly there — same flush as Vue Flow's initial
// sync — so binding a corrected layout would leave the store holding the
// pre-measurement positions forever. Mounting the flow only once the width is
// known means the first array it ever sees is already the right one.
const canvasEl = ref<HTMLElement | null>(null);
const canvasSize = ref({ width: 0, height: 0 });
const measured = ref(false);
let canvasObserver: ResizeObserver | undefined;
watch(canvasEl, (el) => {
  canvasObserver?.disconnect();
  canvasObserver = undefined;
  if (!el) {
    // The canvas leaves the page whenever the last run finishes (EmptyState
    // takes the `groups.length === 0` branch) and comes back with the next one.
    // Dropping the flag with it is what keeps `measured` meaning "canvasSize is
    // the box currently on screen": the window can be resized across that gap,
    // and a flow that mounts against the pre-gap measurement gets its correction
    // dropped by Vue Flow's pausable prop watcher — the same way the first mount
    // did before this gate existed, but permanently.
    measured.value = false;
    return;
  }
  // Set before the observer, and independently of it: where ResizeObserver is
  // missing this one read is the only measurement there will be, and the canvas
  // still has to render.
  canvasSize.value = { width: el.clientWidth, height: el.clientHeight };
  measured.value = true;
  if (typeof ResizeObserver === 'undefined') return;
  canvasObserver = new ResizeObserver(([entry]) => {
    if (entry) canvasSize.value = { width: entry.contentRect.width, height: entry.contentRect.height };
  });
  canvasObserver.observe(el);
});
onBeforeUnmount(() => canvasObserver?.disconnect());

const bandsPerRow = computed(() =>
  bandsPerRowFor(groups.value, canvasSize.value.width, canvasSize.value.height),
);
// Only fires when the column count actually flips, because a computed that
// returns the same number does not propagate — so this re-fits when a resize or
// a poll changes the winning layout, not on every pixel of a drag nor on every
// 5s tick. The first mount does not need it (`fit-view-on-init` fits a layout
// that is already correct), and would not survive it either: the flow has no
// nodes yet at that point.
watch(bandsPerRow, () => {
  nextTick(() => {
    if (storeNodes.value.length > 0) fitView();
  });
});

const flowNodes = computed(() =>
  sessionsFlowNodes(groups.value, graphNow.value, bandsPerRow.value),
);
const flowEdges = computed(() =>
  sessionsFlowEdges(groups.value, graphNow.value).map((e) => ({
    ...e,
    // Same edge paint as Roadmap and Flow: dashed, --ds-text-subtlest.
    // --ds-border measures 1.27:1 against the canvas and is effectively
    // invisible; subtlest clears the 3:1 UI-graphics floor in both themes.
    // The `straight` type and the `animated` flag are decided in
    // sessionsFlow.ts, where both are unit-tested — only paint is set here.
    style: { strokeDasharray: '4,4', strokeWidth: 1.5, stroke: 'var(--ds-text-subtlest)' },
  })),
);

const SESSION_ACTIVE_MINUTES = SESSION_ACTIVE_WITHIN_MS / (60 * 1000);
const ACTIVITY_TONE: Record<SessionActivity, 'info' | 'neutral'> = {
  active: 'info',
  idle: 'neutral',
  unknown: 'neutral',
};
const AGENT_TONE: Record<AgentActivity, 'info' | 'warning' | 'neutral'> = {
  working: 'info',
  stalled: 'warning',
  unknown: 'neutral',
};

// Counted through lib/liveness.ts, the same thresholds Overview's card uses:
// the two surfaces must never disagree about which runs are active.
// Counted over EVERY session in the payload, not just the bands that fit —
// the count is a claim about the factory, and capping it at SESSION_BAND_CAP
// would make it a claim about the viewport instead. What was left undrawn is
// stated separately, below the canvas.
const summary = computed(() => {
  const sessions = allGroups.value.map((g) => g.session);
  if (sessions.length === 0) return '';
  const active = activeSessionCount(sessions, graphNow.value);
  const clauses = [`${pluralize(active, 'session')} active`];
  if (sessions.length > active) clauses.push(`${sessions.length - active} idle`);
  const agents = allGroups.value.reduce((n, g) => n + g.agents.length, 0);
  if (agents > 0) clauses.push(pluralize(agents, 'live agent'));
  return clauses.join(' · ');
});

// The state is never carried by a dot's colour alone — this is the same fact
// in words, and it is what a screen reader gets.
function sessionStateLabel(session: RunningSession, activity: SessionActivity): string {
  const when = formatRelative(session.lastEventAt, graphNow.value);
  if (activity === 'unknown') return 'last event time unreadable';
  if (activity === 'active') return `active, last event ${when}`;
  return `idle for over ${SESSION_ACTIVE_MINUTES} minutes, last event ${when}`;
}

// An agent that is live-but-stalled is counted separately from one that is
// working, because those are different facts and the pulse only claims the
// second one.
function agentLine(agentCount: number, workingAgents: number): string {
  if (agentCount === 0) return 'no live agents';
  if (workingAgents === agentCount) return `${pluralize(agentCount, 'agent')} working`;
  return `${workingAgents} of ${agentCount} agents working`;
}

function goToTask(taskId: string | null) {
  if (taskId) router.push(`/tasks/${encodeURIComponent(taskId)}`);
}
</script>

<template>
  <div class="app-page app-page--full-bleed">
    <PageHeader title="Sessions" />

    <Toolbar :count="summary || `${groups.length} sessions`">
      <Button variant="outline" size="sm" icon="refresh-cw" @click="refresh()">Refresh</Button>
    </Toolbar>

    <Banner v-if="error" tone="danger" show-retry @retry="load">{{ error }}</Banner>

    <!-- Never dropped, never re-parented. `agents` rows stay `live` until a
         terminal event closes them out, so an agent can outlive the run that
         dispatched it; that is a real state an operator needs told, and the
         one thing the canvas must not do is hang it off a session it did not
         belong to just to have somewhere to draw it. -->
    <Banner v-if="orphans.length > 0" tone="warning">
      {{ pluralize(orphans.length, 'live agent') }} with no session on this canvas
      ({{ orphans.map((a) => `${a.agentRole} · ${a.sessionId}`).join(', ') }}).
      Either no terminal event was recorded for
      {{ orphans.length === 1 ? 'it' : 'them' }}, or the run belongs to a project
      outside the current scope. Not drawn: the canvas has nowhere honest to put
      {{ orphans.length === 1 ? 'it' : 'them' }}.
    </Banner>

    <Skeleton v-if="loading" height="640" />

    <!-- Both branches require `data`. Without that, a failed FIRST fetch —
         error set, data still null, loading already false — renders the red
         banner directly above "No sessions are running", telling the operator
         the factory is idle when the truth is that the API is unreachable. -->
    <EmptyState v-else-if="canClaimEmpty(!!data, groups.length)" icon="play">
      No sessions are running. Start the factory and this canvas fills in.
    </EmptyState>

    <template v-else-if="data">
      <div ref="canvasEl" class="sessions-canvas">
        <VueFlow
          v-if="measured"
          :nodes="flowNodes"
          :edges="flowEdges"
          :nodes-draggable="false"
          fit-view-on-init
        >
          <template #node-session="{ data: node }">
            <article
              class="session-node"
              :class="{ 'session-node--active': node.activity === 'active' }"
            >
              <div class="session-node__head">
                <span
                  class="running-session__dot"
                  :class="`running-session__dot--${node.activity}`"
                  aria-hidden="true"
                />
                <span
                  class="session-node__id"
                  :title="`${node.session.sessionId} · started ${formatDateTime(node.session.startedAt)}`"
                >{{ node.session.sessionId }}</span>
                <Lozenge :tone="ACTIVITY_TONE[node.activity as SessionActivity]">
                  {{ node.activity }}
                </Lozenge>
              </div>
              <p class="session-node__meta">
                {{ sessionStateLabel(node.session, node.activity) }} ·
                {{ pluralize(node.session.eventCount, 'event') }}
              </p>
              <p class="session-node__agents">
                {{ agentLine(node.agentCount, node.workingAgents) }}
                <template v-if="node.session.lastEventType">
                  · last <code>{{ node.session.lastEventType }}</code>
                </template>
              </p>
              <div v-if="node.session.projects.length > 0" class="session-node__projects">
                <IdentityChip v-for="p in node.session.projects" :key="p" :id="p" />
              </div>
            </article>
          </template>

          <!-- Only an agent that has a task has somewhere to go, so only that
               one is a button. The rest stay plain articles rather than dead
               controls — same rule as Overview's agent rows. -->
          <template #node-agent="{ data: node }">
            <component
              :is="node.agent.taskId ? 'button' : 'article'"
              :type="node.agent.taskId ? 'button' : undefined"
              class="agent-node"
              :class="{ 'agent-node--linked': !!node.agent.taskId }"
              :title="`started ${formatDateTime(node.agent.dispatchedAt)}`"
              :aria-label="
                node.agent.taskId
                  ? `${node.agent.agentRole} on ${node.agent.modelTier}, ${node.activity}, task ${node.agent.taskId}, running ${formatElapsed(node.agent.dispatchedAt, graphNow)}, opens task detail`
                  : undefined
              "
              @click="goToTask(node.agent.taskId)"
            >
              <div class="agent-node__head">
                <span
                  class="live-agent-entry__dot"
                  :class="`live-agent-entry__dot--${node.activity}`"
                  aria-hidden="true"
                />
                <IdentityChip
                  :id="node.agent.agentRole"
                  :label="`${node.agent.agentRole} · ${node.agent.modelTier}`"
                  :live="node.activity === 'working'"
                />
                <Lozenge :tone="AGENT_TONE[node.activity as AgentActivity]">
                  {{ node.activity }}
                </Lozenge>
              </div>
              <div class="agent-node__foot">
                <span class="agent-node__task">{{ agentScopeLabel(node.agent) }}</span>
                <span class="agent-node__elapsed">
                  {{ formatElapsed(node.agent.dispatchedAt, graphNow) }}
                </span>
              </div>
            </component>
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

      <!-- Stated, never dropped silently — same contract as Overview's
           "+N older sessions not shown". -->
      <p v-if="hiddenBands > 0" class="sessions-canvas__more">
        +{{ hiddenBands }} older {{ hiddenBands === 1 ? 'session' : 'sessions' }} not drawn.
        The canvas shows the {{ SESSION_BAND_CAP }} most recently active.
      </p>

      <!-- sr-only alternative (a11y): a DOM graph carries no text alternative
           for its ORDER, nor for which agent hangs off which run. Same pattern
           as RoadmapPage's sequence table and FlowPage's task-DAG table. -->
      <table class="sr-only">
        <caption>Sessions: {{ groups.length }} runs, most recently active first</caption>
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">Last event</th>
            <th scope="col">Agent</th>
            <th scope="col">Agent state</th>
            <th scope="col">Task</th>
            <th scope="col">Running for</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="g in groups" :key="g.session.sessionId">
            <tr v-if="g.agents.length === 0">
              <td>{{ g.session.sessionId }}</td>
              <td>{{ formatRelative(g.session.lastEventAt, graphNow) }}</td>
              <td colspan="4">no live agents</td>
            </tr>
            <!-- Same clock as the canvas, deliberately: this table is the
                 alternative to the graph, not a second opinion about it. -->
            <tr v-for="a in g.agents" :key="a.id">
              <td>{{ g.session.sessionId }}</td>
              <td>{{ formatRelative(g.session.lastEventAt, graphNow) }}</td>
              <td>{{ a.agentRole }} · {{ a.modelTier }}</td>
              <td>{{ agentActivity(a, graphNow) }}</td>
              <td>{{ agentScopeLabel(a) }}</td>
              <td>{{ formatElapsed(a.dispatchedAt, graphNow) }}</td>
            </tr>
          </template>
        </tbody>
      </table>
    </template>
  </div>
</template>
