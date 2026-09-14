<script setup lang="ts">
// Sessions — a spatial canvas of the runs that are happening right now.
//
// Operator directive: "read this repo https://github.com/eneskirca/nodeterm --
// is there a way to bring a node flow like it into black-smith, running in the
// browser?" → "do it the T1 way".
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
import Banner from '../components/ds/Banner.vue';
import Button from '../components/ds/Button.vue';
import EmptyState from '../components/ds/EmptyState.vue';
import Lozenge from '../components/ds/Lozenge.vue';
import PageHeader from '../components/ds/PageHeader.vue';
import Skeleton from '../components/ds/Skeleton.vue';
import Toolbar from '../components/ds/Toolbar.vue';
import IdentityChip from '../components/IdentityChip.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useSessionContext } from '../composables/useSessionContext.js';
import { agentScopeLabel } from '../lib/agentScope.js';
import {
  fetchOverview,
  type LiveAgentEntry,
  type OverviewResult,
  type RunningSession,
} from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { formatDateTime, formatElapsed, formatRelative, pluralize } from '../lib/format.js';
import {
  type AgentActivity,
  agentActivity,
  hiddenAgentsLabel,
  hiddenSessionsLabel,
  partitionAgents,
  SESSION_ACTIVE_WITHIN_MS,
  type SessionActivity,
} from '../lib/liveness.js';
import {
  AGENT_VISIBLE_CAP,
  bandsPerRowFor,
  runningGroups,
  SESSION_BAND_CAP,
  sessionGroups,
  sessionsFlowEdges,
  sessionsFlowNodes,
  visibleBands,
  workingUnattached,
} from '../lib/sessionsFlow.js';

const router = useRouter();
const { setBreadcrumb } = useBreadcrumb();
const { project } = useProjectContext();
const { sessionScope, sessionKey } = useSessionContext();
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
    data.value = await fetchOverview(sessionScope.value, project.value);
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
// Same split as OverviewPage, which polls the same endpoint. A session scope
// change earns the same treatment for the same reason -- it swaps which runs
// the canvas draws, not just how many.
watch([project, sessionKey], () => {
  setBreadcrumb([{ label: project.value ? `${project.value} · Sessions` : 'Sessions' }]);
  loading.value = true;
  load();
});
const { refresh } = usePoll(load, POLL_MS);

const allGroups = computed(() => (data.value ? sessionGroups(data.value) : []));
// `runningSessions` is every projected session, not just the running ones.
// The running-only rule (lib/sessionsFlow.ts runningGroups) drops the idle
// bands and, inside each kept band, the stalled agents; it reads `graphNow`,
// so a band crossing the 15-minute line leaves on the next successful poll.
// What survives is then capped, and both remainders are stated: the rule's
// in the toolbar summary and under the canvas, the cap's under the canvas.
const running = computed(() => runningGroups(allGroups.value, graphNow.value));
const groups = computed(() => visibleBands(running.value.groups).shown);
const hiddenBands = computed(() => visibleBands(running.value.groups).hidden);
// '' when nothing is hidden, so `v-if` on it renders no empty line.
const hiddenSessionsLine = computed(() =>
  hiddenSessionsLabel(running.value.hiddenSessions, running.value.hiddenUnknownSessions),
);
// Every live agent in the payload, orphans included, split by the same clock
// the bands are: this is what the summary's working/stalled counts add up
// from, so they sum to `liveAgentEntries.length` whatever the canvas drew.
const agentParts = computed(() =>
  partitionAgents(data.value?.liveAgentEntries ?? [], graphNow.value),
);
const hiddenAgentsLine = computed(() =>
  hiddenAgentsLabel(agentParts.value.stalled, agentParts.value.unknown),
);
// Working agents whose session is not in the payload. They are named in a
// Banner rather than drawn, because the canvas has nowhere honest to put them:
// inventing a parent node would be inventing data. Stalled orphans are not
// named, only counted — they are in `agentParts`. See lib/sessionsFlow.ts.
const orphans = computed(() =>
  data.value
    ? workingUnattached(data.value, graphNow.value)
    : { agents: [] as LiveAgentEntry[], hidden: 0 },
);

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
    // The canvas leaves the page whenever the last run finishes or goes idle
    // (EmptyState takes the `running.groups.length === 0` branch) and comes
    // back with the next one.
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
    if (entry)
      canvasSize.value = { width: entry.contentRect.width, height: entry.contentRect.height };
  });
  canvasObserver.observe(el);
});
onBeforeUnmount(() => canvasObserver?.disconnect());

/**
 * Which bands the operator has opened past AGENT_VISIBLE_CAP. Interaction
 * state, not geometry -- it is threaded INTO the pure layout functions, never
 * computed inside them, the same split every other number on this canvas keeps.
 *
 * Replaced rather than mutated: a Set mutated in place is the same object, and
 * a `ref` holding the same object does not notify.
 */
const expandedSessions = ref<ReadonlySet<string>>(new Set());
function toggleExpanded(sessionId: string) {
  const next = new Set(expandedSessions.value);
  if (!next.delete(sessionId)) next.add(sessionId);
  expandedSessions.value = next;
}
// A poll can retire a session out of `runningGroups()` or `visibleBands()`;
// its id would otherwise sit in the set forever and re-open the band if the
// run came back.
watch(groups, (gs) => {
  const alive = new Set(gs.map((g) => g.session.sessionId));
  if ([...expandedSessions.value].every((id) => alive.has(id))) return;
  expandedSessions.value = new Set([...expandedSessions.value].filter((id) => alive.has(id)));
});

const bandsPerRow = computed(() =>
  bandsPerRowFor(
    groups.value,
    canvasSize.value.width,
    canvasSize.value.height,
    expandedSessions.value,
  ),
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

// Expanding a band changes the row extents exactly as a column-count flip does,
// so it needs the same re-fit -- otherwise the newly revealed agents are drawn
// below the viewport the operator is looking at.
watch(expandedSessions, () => {
  nextTick(() => {
    if (storeNodes.value.length > 0) fitView();
  });
});

const flowNodes = computed(() =>
  sessionsFlowNodes(groups.value, graphNow.value, bandsPerRow.value, expandedSessions.value),
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
// A drawn band is running on one half of the rule or the other: its own
// events ('active'), or an agent vouching for it while the events are quiet
// ('working'). 'idle' is not a word a band can carry — it is what the line
// under the canvas calls the runs that are NOT drawn, and a band that reads
// "idle" looks like the running-only rule failed. Same words as Overview's
// rows: the two surfaces must never disagree about what a run is doing.
type BandState = 'active' | 'working' | 'unknown';
const BAND_TONE: Record<BandState, 'info' | 'neutral'> = {
  active: 'info',
  working: 'info',
  unknown: 'neutral',
};
function bandState(activity: SessionActivity, workingAgents: number): BandState {
  if (activity === 'active') return 'active';
  // Event-idle or an unreadable event time: only a working agent could have
  // kept the band on the canvas, so that is the state it reports. 'unknown'
  // is unreachable while runningGroups() keeps such bands off the canvas.
  return workingAgents > 0 ? 'working' : 'unknown';
}
const AGENT_TONE: Record<AgentActivity, 'info' | 'warning' | 'neutral'> = {
  working: 'info',
  stalled: 'warning',
  unknown: 'neutral',
};

// Counted through lib/liveness.ts, the same thresholds Overview's card uses:
// the two surfaces must never disagree about which runs are running.
// Counted over EVERY running session in the payload, not just the bands that
// fit — the count is a claim about the factory, and capping it at
// SESSION_BAND_CAP would make it a claim about the viewport instead. What the
// running-only rule hid is stated here, in the same breath as the count it
// was taken out of; what the cap left undrawn is stated below the canvas.
const summary = computed(() => {
  const agentsInPayload = (data.value?.liveAgentEntries ?? []).length;
  if (allGroups.value.length === 0 && agentsInPayload === 0) return '';
  const clauses = [`${pluralize(running.value.groups.length, 'session')} running`];
  if (hiddenSessionsLine.value) clauses.push(hiddenSessionsLine.value);
  const working = agentParts.value.working.length;
  if (working > 0) clauses.push(`${pluralize(working, 'agent')} working`);
  if (hiddenAgentsLine.value) clauses.push(hiddenAgentsLine.value);
  return clauses.join(' · ');
});

// The state is never carried by a dot's colour alone — this is the same fact
// in words, and it is what a screen reader gets.
function sessionStateLabel(
  session: RunningSession,
  activity: SessionActivity,
  workingAgents: number,
): string {
  const when = formatRelative(session.lastEventAt, graphNow.value);
  if (bandState(activity, workingAgents) === 'working') {
    // The events half is stated as what it is — quiet, or unreadable — and
    // never as more than the log supports.
    const events =
      activity === 'unknown'
        ? 'last event time unreadable'
        : `no event for over ${SESSION_ACTIVE_MINUTES} minutes`;
    return `${events}, ${pluralize(workingAgents, 'agent')} working`;
  }
  if (activity === 'unknown') return 'last event time unreadable';
  return `active, last event ${when}`;
}

// An agent that is live-but-stalled is counted separately from one that is
// working, because those are different facts and only the second one is
// drawn. The band carries its working agents alone (runningGroups), so the
// ones it hid are re-partitioned from the unfiltered group to be named, not
// just subtracted: an unreadable timestamp is not "stalled", and the label
// helper keeps the two apart.
function agentLine(sessionId: string, agentCount: number, workingAgents: number): string {
  if (agentCount === 0) return 'no live agents';
  const line = `${pluralize(workingAgents, 'agent')} working`;
  if (workingAgents === agentCount) return line;
  const all = allGroups.value.find((g) => g.session.sessionId === sessionId)?.agents ?? [];
  const parts = partitionAgents(all, graphNow.value);
  return `${line} · ${hiddenAgentsLabel(parts.stalled, parts.unknown)}`;
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
         belong to just to have somewhere to draw it. Working orphans only:
         a stalled one is counted in the summary, not named here. -->
    <Banner v-if="orphans.agents.length > 0" tone="warning">
      {{ pluralize(orphans.agents.length, 'working agent') }} with no session on this canvas
      ({{ orphans.agents.map((a) => `${a.agentRole} · ${a.sessionId}`).join(', ') }}).
      Either no terminal event was recorded for
      {{ orphans.agents.length === 1 ? 'it' : 'them' }}, or the run belongs to a project
      outside the current scope. Not drawn: the canvas has nowhere honest to put
      {{ orphans.agents.length === 1 ? 'it' : 'them' }}.
    </Banner>

    <Skeleton v-if="loading" height="640" />

    <!-- Both branches require `data`. Without that, a failed FIRST fetch —
         error set, data still null, loading already false — renders the red
         banner directly above "No sessions are running", telling the operator
         the factory is idle when the truth is that the API is unreachable.
         Counted over the running bands, before the cap: an idle-only payload
         is an empty canvas, and the line under it says what went unshown. -->
    <template v-else-if="canClaimEmpty(!!data, running.groups.length)">
      <EmptyState icon="play">
        No sessions are running. Start the factory and this canvas fills in.
      </EmptyState>
      <p v-if="hiddenSessionsLine" class="sessions-canvas__more">{{ hiddenSessionsLine }}</p>
    </template>

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
              :class="{
                'session-node--active': bandState(node.activity, node.workingAgents) !== 'unknown',
                'session-node--expandable': node.workingAgents > AGENT_VISIBLE_CAP,
              }"
            >
              <div class="session-node__head">
                <span
                  class="running-session__dot"
                  :class="`running-session__dot--${bandState(node.activity, node.workingAgents)}`"
                  aria-hidden="true"
                />
                <span
                  class="session-node__id"
                  :title="`${node.session.sessionId} · started ${formatDateTime(node.session.startedAt)}`"
                >{{ node.session.sessionId }}</span>
                <Lozenge :tone="BAND_TONE[bandState(node.activity, node.workingAgents)]">
                  {{ bandState(node.activity, node.workingAgents) }}
                </Lozenge>
              </div>
              <p class="session-node__meta">
                {{ sessionStateLabel(node.session, node.activity, node.workingAgents) }} ·
                {{ pluralize(node.session.eventCount, 'event') }}
              </p>
              <p class="session-node__agents">
                {{ agentLine(node.session.sessionId, node.agentCount, node.workingAgents) }}
                <template v-if="node.session.lastEventType">
                  · last <code>{{ node.session.lastEventType }}</code>
                </template>
              </p>
              <div v-if="node.session.projects.length > 0" class="session-node__projects">
                <IdentityChip v-for="p in node.session.projects" :key="p" :id="p" />
              </div>
              <!-- The disclosure lives on the session card, not at the foot of
                   the agent stack: the stack is the thing being truncated, and
                   a control below it would be the first thing off-canvas. It
                   is what `session-node--expandable` above buys the height
                   for; the same condition gates both, so the card never grows
                   for a button that is not there. Gated on the WORKING count,
                   because those are the agents the band draws — a stalled one
                   is stated in the line above, never stacked. The aria-label
                   carries the session id because a canvas of eight bands is
                   otherwise eight identically-labelled buttons. -->
              <Button
                v-if="node.workingAgents > AGENT_VISIBLE_CAP"
                class="session-node__more"
                variant="outline"
                size="sm"
                :aria-expanded="expandedSessions.has(node.session.sessionId)"
                :aria-label="
                  expandedSessions.has(node.session.sessionId)
                    ? `Show only the ${AGENT_VISIBLE_CAP} longest-running of ${node.workingAgents} working agents for session ${node.session.sessionId}`
                    : `Show all ${node.workingAgents} working agents for session ${node.session.sessionId}`
                "
                @click="toggleExpanded(node.session.sessionId)"
              >
                {{
                  expandedSessions.has(node.session.sessionId)
                    ? `Show top ${AGENT_VISIBLE_CAP}`
                    : `Show all ${node.workingAgents}`
                }}
              </Button>
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
           "+N older sessions not shown". Two lines because two different
           things hid them: the cap, and the running-only rule. -->
      <p v-if="hiddenBands > 0" class="sessions-canvas__more">
        +{{ hiddenBands }} older {{ hiddenBands === 1 ? 'session' : 'sessions' }} not drawn.
        The canvas shows the {{ SESSION_BAND_CAP }} most recently active.
      </p>
      <p v-if="hiddenSessionsLine" class="sessions-canvas__more">{{ hiddenSessionsLine }}</p>

      <!-- sr-only alternative (a11y): a DOM graph carries no text alternative
           for its ORDER, nor for which agent hangs off which run. Same pattern
           as RoadmapPage's sequence table and FlowPage's task-DAG table. Over
           the drawn bands only — what was hidden is in the toolbar summary,
           which is ordinary text and reaches AT already. -->
      <table class="sr-only">
        <caption>Sessions: {{ groups.length }} running, most recently active first</caption>
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
              <td colspan="4">{{ agentLine(g.session.sessionId, g.liveAgentCount ?? 0, 0) }}</td>
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
