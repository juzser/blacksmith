<script setup lang="ts">
// Sessions — DS8 PR3, rebuilt on the kit. Replaces the VueFlow canvas
// entirely: a history list (kit SessionRow, one per run) with an "N
// finished runs" toggle, and selecting a run loads its agents through
// fetchSessionAgents and shows one kit AgentBlock per role. No @vue-flow/core
// import anywhere on this page — the dependency stays in package.json only
// because nothing else in this round removes it from there.
//
// Deep link (`?session=<id>`): this page's own "which run is open" marker,
// read and written only here. lib/sessionScope.ts also reads a `?session`
// query key, but for a different job — narrowing every OTHER page's server
// fetch (Activity, Work → Roadmap) to one run's lineage. The two share a
// name, not a meaning, so this page does not call useSessionContext() at
// all: lib/sessionsSelection.ts's selectedSessionFromQuery() only ever
// selects an id this page's own history list already knows about.
import { Play, RefreshCw } from '@lucide/vue';
import { nextTick, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import AgentBlock from '../components/kit/AgentBlock.vue';
import Banner from '../components/kit/Banner.vue';
import Button from '../components/kit/Button.vue';
import EmptyState from '../components/kit/EmptyState.vue';
import PageHeader from '../components/kit/PageHeader.vue';
import SessionRow from '../components/kit/SessionRow.vue';
import Skeleton from '../components/kit/Skeleton.vue';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useViewport } from '../composables/useViewport.js';
import {
  fetchSessionAgents,
  fetchSessions,
  type RunningSession,
  type SessionAgentsResult,
} from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { pluralize } from '../lib/format.js';
import {
  isSessionActive,
  isStaleResponse,
  selectedSessionFromQuery,
  sessionsByProject,
} from '../lib/sessionsSelection.js';

const router = useRouter();
const route = useRoute();
const { setBreadcrumb } = useBreadcrumb();
const { project } = useProjectContext();
const { isPhoneWidth } = useViewport();

// Same cadence as every other polling page (design-spec.md §8).
const POLL_MS = 5000;

const sessions = ref<RunningSession[]>([]);
const sessionsLoaded = ref(false);
const sessionsError = ref<string | null>(null);

const selectedId = ref<string | null>(null);
const agents = ref<SessionAgentsResult | null>(null);
const agentsLoadedFor = ref<string | null>(null);
const agentsError = ref<string | null>(null);

const showFinished = ref(false);

const running = () => sessions.value.filter(isSessionActive);
const finished = () => sessions.value.filter((s) => !isSessionActive(s));

// Unscoped (no project in context, SessionsPage never pre-selects one):
// group the running list by project, newest group first. Scoped to one
// project, every running row already belongs to it, so no header renders.
const runningGroups = () => sessionsByProject(running());

// Gates the poll: a selected run with nothing left live has nothing left to
// learn by asking again every 5s.
function hasLiveAgents(): boolean {
  return agents.value?.roles.some((r) => r.agents.some((a) => a.status === 'live')) ?? false;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function loadSessions() {
  try {
    sessions.value = await fetchSessions(undefined, project.value);
    sessionsError.value = null;
  } catch (e) {
    sessionsError.value = errorMessage(e);
  } finally {
    sessionsLoaded.value = true;
  }
}

// Serves both the poll path and the click path: a response for a run the
// user has since clicked away from (isStaleResponse) must not overwrite
// the run now selected.
async function loadAgents() {
  const id = selectedId.value;
  if (!id) return;
  try {
    const result = await fetchSessionAgents(id, project.value);
    if (isStaleResponse(id, selectedId.value)) return;
    agents.value = result;
    agentsError.value = null;
  } catch (e) {
    if (isStaleResponse(id, selectedId.value)) return;
    agentsError.value = errorMessage(e);
  } finally {
    if (!isStaleResponse(id, selectedId.value)) agentsLoadedFor.value = id;
  }
}

const rowRefs = new Map<string, HTMLElement>();
function setRowRef(id: string, el: Element | null) {
  if (el instanceof HTMLElement) rowRefs.set(id, el);
  else rowRefs.delete(id);
}

function selectSession(id: string) {
  if (selectedId.value === id) return;
  selectedId.value = id;
  agents.value = null;
  agentsLoadedFor.value = null;
  if (finished().some((s) => s.sessionId === id)) showFinished.value = true;
  router.replace({ query: { ...route.query, session: id } });
  void loadAgents();
}

function breadcrumbLabel() {
  return project.value ? `${project.value} · Sessions` : 'Sessions';
}

onMounted(async () => {
  setBreadcrumb([{ label: breadcrumbLabel() }]);
  await loadSessions();
  const deepLinked = selectedSessionFromQuery(route.query, sessions.value);
  if (deepLinked) {
    selectedId.value = deepLinked;
    if (finished().some((s) => s.sessionId === deepLinked)) showFinished.value = true;
    await loadAgents();
    await nextTick();
    const row = rowRefs.get(deepLinked);
    row?.scrollIntoView({ block: 'nearest' });
    // rowRefs holds the <li>, not SessionRow's own root — its clickable
    // button is the row's one focusable descendant.
    row?.querySelector('button')?.focus({ preventScroll: true });
  }
});

// A project switch swaps which runs the list can even show, so the previous
// project's selection does not survive it — same split Roadmap and the
// retired canvas both keep for a scope change.
watch(project, () => {
  setBreadcrumb([{ label: breadcrumbLabel() }]);
  selectedId.value = null;
  agents.value = null;
  agentsLoadedFor.value = null;
  void loadSessions();
});

usePoll(() => {
  if (hasLiveAgents()) void loadAgents();
}, POLL_MS);

function refresh() {
  void loadSessions();
  if (selectedId.value) void loadAgents();
}
</script>

<template>
  <div class="app-page">
    <PageHeader title="Sessions">
      <template #actions>
        <Button v-if="!isPhoneWidth" variant="ghost" size="sm" :icon="RefreshCw" @click="refresh">Refresh</Button>
      </template>
    </PageHeader>

    <Banner v-if="sessionsError" tone="danger" show-retry @retry="loadSessions">
      {{ sessionsError }}
    </Banner>

    <Skeleton v-if="!sessionsLoaded" height="200" />

    <template v-else-if="canClaimEmpty(sessionsLoaded, sessions.length)">
      <EmptyState
        :icon="Play"
        title="No sessions yet"
        body="Start the factory and its runs will appear here."
      />
    </template>

    <template v-else>
      <template v-if="project === undefined">
        <template v-for="group in runningGroups()" :key="group.project">
          <h3 class="bs-section-title bs-sessions__group-title">
            <RouterLink
              v-if="group.project"
              :to="{ query: { ...route.query, project: group.project } }"
              class="bs-btn bs-btn--link bs-btn--sm"
            >
              {{ group.project }}
            </RouterLink>
            <template v-else>No project</template>
          </h3>
          <ul class="bs-sessions__list" role="list">
            <li
              v-for="s in group.sessions"
              :key="s.sessionId"
              :ref="(el) => setRowRef(s.sessionId, el as Element | null)"
            >
              <SessionRow
                :session="s"
                clickable
                :selected="selectedId === s.sessionId"
                @click="selectSession(s.sessionId)"
              />
            </li>
          </ul>
        </template>
      </template>
      <ul v-else class="bs-sessions__list" role="list">
        <li v-for="s in running()" :key="s.sessionId" :ref="(el) => setRowRef(s.sessionId, el as Element | null)">
          <SessionRow
            :session="s"
            clickable
            :selected="selectedId === s.sessionId"
            @click="selectSession(s.sessionId)"
          />
        </li>
      </ul>
      <p v-if="running().length === 0" class="bs-sessions__quiet">
        Nothing is active right now.
      </p>

      <Button
        v-if="finished().length > 0"
        variant="ghost"
        size="sm"
        @click="showFinished = !showFinished"
      >
        {{ showFinished ? 'Hide finished runs' : `Show ${pluralize(finished().length, 'finished run')}` }}
      </Button>

      <ul v-if="showFinished" class="bs-sessions__list" role="list">
        <li
          v-for="s in finished()"
          :key="s.sessionId"
          :ref="(el) => setRowRef(s.sessionId, el as Element | null)"
        >
          <SessionRow
            :session="s"
            clickable
            :selected="selectedId === s.sessionId"
            @click="selectSession(s.sessionId)"
          />
        </li>
      </ul>

      <Banner v-if="agentsError" tone="danger" show-retry @retry="loadAgents">
        {{ agentsError }}
      </Banner>

      <section v-if="selectedId" class="bs-sessions__detail" aria-label="Selected session's agents">
        <Skeleton v-if="agentsLoadedFor !== selectedId" height="120" />
        <template v-else-if="agents">
          <AgentBlock
            v-for="r in agents.roles"
            :key="r.agentRole"
            :agent-role="r.agentRole"
            :agents="r.agents"
          />
        </template>
      </section>
    </template>
  </div>
</template>
