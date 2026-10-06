<script setup lang="ts">
// Sessions — DS8 PR3, rebuilt on the kit. Replaces the VueFlow canvas
// entirely: a history list (kit SessionRow, one per run) scoped Active/All
// by the shared `?scope=` toggle, and selecting a run loads its agents through
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
import ActivityScopeToggle from '../components/ActivityScopeToggle.vue';
import AgentBlock from '../components/kit/AgentBlock.vue';
import Banner from '../components/kit/Banner.vue';
import Button from '../components/kit/Button.vue';
import EmptyState from '../components/kit/EmptyState.vue';
import PageHeader from '../components/kit/PageHeader.vue';
import SessionRow from '../components/kit/SessionRow.vue';
import Skeleton from '../components/kit/Skeleton.vue';
import { useActivityScope } from '../composables/useActivityScope.js';
import { useBreadcrumb } from '../composables/useBreadcrumb.js';
import { usePoll } from '../composables/usePoll.js';
import { useProjectContext } from '../composables/useProjectContext.js';
import { useViewport } from '../composables/useViewport.js';
import { scopeQuery } from '../lib/activityScope.js';
import {
  fetchSessionAgents,
  fetchSessions,
  type RunningSession,
  type SessionAgentsResult,
} from '../lib/api.js';
import { canClaimEmpty } from '../lib/emptyClaim.js';
import { pluralize } from '../lib/format.js';
import {
  activeFirst,
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
const { scope, scopeTo } = useActivityScope();

// Same cadence as every other polling page (design-spec.md §8).
const POLL_MS = 5000;

const sessions = ref<RunningSession[]>([]);
const sessionsLoaded = ref(false);
const sessionsError = ref<string | null>(null);

const selectedId = ref<string | null>(null);
const agents = ref<SessionAgentsResult | null>(null);
const agentsLoadedFor = ref<string | null>(null);
const agentsError = ref<string | null>(null);

const quietSessions = () => sessions.value.filter((s) => !isSessionActive(s));
const activeCount = () => sessions.value.length - quietSessions().length;

// Active shows only running sessions; All also reveals the quiet ones
// (nothing working), which render muted after the active ones.
const visible = () =>
  scope.value === 'all' ? sessions.value : sessions.value.filter(isSessionActive);

// Unscoped (no project in context, SessionsPage never pre-selects one):
// group the visible list by project, newest group first, active rows ahead of
// quiet ones inside a group. Scoped to one project, every row already
// belongs to it, so no header renders and the list is flat.
const groups = () =>
  sessionsByProject(visible()).map((g) => ({ ...g, sessions: activeFirst(g.sessions) }));
const flat = () => activeFirst(visible());
const isQuiet = (s: RunningSession) => !isSessionActive(s);

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

// The unscoped running list repeats a session under every project it
// belongs to, so its <li> renders once per group and each one binds its own
// ref callback for the SAME session id. A plain id-keyed setRowRef (above)
// lets whichever group renders last overwrite the one rendered first, so a
// deep link's scroll/focus target becomes non-deterministic. groupRowRef
// gives each (group, session) slot its own stable closure — reused across
// re-renders via groupRowSetters — that remembers the element IT mounted, so
// the first group to mount a given session wins rowRefs and a later
// group's own unmount can never evict an earlier group's live entry.
const groupRowSetters = new Map<string, (el: Element | null) => void>();
function groupRowRef(groupKey: string, id: string): (el: Element | null) => void {
  const compositeKey = `${groupKey}\u0000${id}`;
  const existing = groupRowSetters.get(compositeKey);
  if (existing) return existing;
  let mine: HTMLElement | null = null;
  const setter = (el: Element | null) => {
    if (el instanceof HTMLElement) {
      mine = el;
      if (!rowRefs.has(id)) rowRefs.set(id, el);
    } else {
      if (mine && rowRefs.get(id) === mine) rowRefs.delete(id);
      mine = null;
      groupRowSetters.delete(compositeKey);
    }
  };
  groupRowSetters.set(compositeKey, setter);
  return setter;
}

function selectSession(id: string) {
  if (selectedId.value === id) return;
  selectedId.value = id;
  agents.value = null;
  agentsLoadedFor.value = null;
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
    // Deep link to a quiet session while the scope is Active: its row is
    // hidden there. Least surprising rule: widen the scope with router.replace
    // (no extra history entry) so the URL tells the truth about what is shown.
    const hit = sessions.value.find((s) => s.sessionId === deepLinked);
    if (hit && isQuiet(hit) && scope.value === 'active') {
      await router.replace({ query: scopeQuery(route.query, 'all') as typeof route.query });
    }
    await loadAgents();
    await nextTick();
    const row = rowRefs.get(deepLinked);
    row?.scrollIntoView({ block: 'nearest' });
    // rowRefs holds the <li>, not SessionRow's own root — its clickable
    // button is the row's one focusable descendant.
    row?.querySelector('button')?.focus({ preventScroll: true });
  }
});

// Narrowing to Active hides a quiet selection's row, so the selection (and
// its `?session=`) goes with it rather than leaving a detail with no row.
watch(scope, (next) => {
  const sel = sessions.value.find((s) => s.sessionId === selectedId.value);
  if (next === 'active' && sel && isQuiet(sel)) {
    selectedId.value = null;
    agents.value = null;
    agentsLoadedFor.value = null;
    const { session: _drop, ...rest } = route.query;
    void router.replace({ query: rest });
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
        <ActivityScopeToggle />
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
        <section
          v-for="(group, i) in groups()"
          :key="group.project"
          class="bs-sessions__group"
          :class="{ 'bs-sessions__group--quiet': !group.sessions.some((s) => !isQuiet(s)) }"
          :aria-labelledby="`sessions-group-title-${i}`"
        >
          <h2 :id="`sessions-group-title-${i}`" class="bs-section-title bs-sessions__group-title">
            <RouterLink
              v-if="group.project"
              :to="{ query: { ...route.query, project: group.project } }"
              class="bs-btn bs-btn--link bs-btn--sm"
            >
              {{ group.project }}
            </RouterLink>
            <template v-else>No project</template>
          </h2>
          <ul class="bs-sessions__list" role="list">
            <li
              v-for="s in group.sessions"
              :key="s.sessionId"
              :ref="(el) => groupRowRef(group.project, s.sessionId)(el as Element | null)"
            >
              <SessionRow
                :session="s"
                clickable
                :quiet="isQuiet(s)"
                :selected="selectedId === s.sessionId"
                @click="selectSession(s.sessionId)"
              />
            </li>
          </ul>
        </section>
      </template>
      <ul v-else class="bs-sessions__list" role="list">
        <li v-for="s in flat()" :key="s.sessionId" :ref="(el) => setRowRef(s.sessionId, el as Element | null)">
          <SessionRow
            :session="s"
            clickable
            :quiet="isQuiet(s)"
            :selected="selectedId === s.sessionId"
            @click="selectSession(s.sessionId)"
          />
        </li>
      </ul>
      <p v-if="scope === 'active' && activeCount() === 0" class="bs-sessions__quiet">
        Nothing is active right now.
      </p>
      <p v-if="scope === 'active' && quietSessions().length > 0" class="bs-sessions__quiet">
        {{ pluralize(quietSessions().length, 'quiet session') }} ·
        <RouterLink :to="scopeTo('all')">Show all</RouterLink>
      </p>

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
