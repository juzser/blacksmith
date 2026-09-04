<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Breadcrumb from './components/ds/Breadcrumb.vue';
import Icon from './components/ds/Icon.vue';
import Select from './components/ds/Select.vue';
import Sheet from './components/ds/Sheet.vue';
import SidebarNav from './components/ds/SidebarNav.vue';
import Toast from './components/ds/Toast.vue';
import Tooltip from './components/ds/Tooltip.vue';
import LiveStatus from './components/LiveStatus.vue';
import { useBreadcrumb } from './composables/useBreadcrumb.js';
import { useNow } from './composables/useNow.js';
import { useProjectContext } from './composables/useProjectContext.js';
import { PULSE_POLL_MS, usePulse } from './composables/usePulse.js';
import { useSessionContext } from './composables/useSessionContext.js';
import { useTheme } from './composables/useTheme.js';
import { useViewport } from './composables/useViewport.js';
import { fetchProjects, fetchSessions } from './lib/api.js';
import { lastEventLabel } from './lib/liveness.js';
import { badgeLabel } from './lib/navBadges.js';
import { SCOPABLE_ROUTES } from './lib/projectScope.js';
import {
  SCOPE_WIDTH_OPTIONS,
  SESSION_SCOPABLE_ROUTES,
  type SessionOption,
  sessionOptions,
} from './lib/sessionScope.js';
import { NAV_ITEMS } from './nav.js';

const router = useRouter();
const route = useRoute();
const { theme, toggle } = useTheme();
const { crumbs } = useBreadcrumb();
const { isCollapsedWidth, isMobileWidth } = useViewport();
const { project, setProject } = useProjectContext();
const { sessionScope, width, setSession, setWidth } = useSessionContext();

const sheetOpen = ref(false);
const activeId = computed(() => {
  // /p/:project/overview and /overview both highlight the "overview" item;
  // every other page matches its route exactly (query params ignored).
  if (route.name === 'overview-global' || route.name === 'overview-project') return 'overview';
  const found = NAV_ITEMS.find((it) => it.route === route.path);
  return found?.id;
});

// Project switcher (topbar). SCOPABLE_ROUTES lives in lib/projectScope.ts so
// a test can hold it to the rule (shown exactly where useProjectContext is
// read); it is hidden on the Projects hub, Task detail and Lessons, none of
// which have a project column.
const showProjectSwitcher = computed(() => SCOPABLE_ROUTES.has(String(route.name)));
const projectOptions = ref<{ value: string; label: string }[]>([
  { value: '', label: 'All projects' },
]);

async function loadProjectOptions() {
  try {
    const projects = await fetchProjects();
    projectOptions.value = [
      { value: '', label: 'All projects' },
      ...projects.map((p) => ({ value: p.project, label: p.project })),
    ];
  } catch {
    // Non-fatal — the switcher just shows "All projects" only.
  }
}
onMounted(() => {
  loadProjectOptions();
  loadSessionOptions();
});
watch(
  () => route.name,
  () => {
    if (showProjectSwitcher.value) loadProjectOptions();
    if (showSessionPicker.value) loadSessionOptions();
  },
);
// A project switch re-cuts the list, and the run selected before it may not
// belong to the new project at all. It stays selectable regardless -- see
// loadSessionOptions' note -- so this refreshes the offer, not the selection.
watch(project, () => {
  if (showSessionPicker.value) loadSessionOptions();
});

function onSwitchProject(value: string) {
  setProject(value || undefined);
}

// Session picker (topbar). Same IFF as the project switcher, and the same
// reason for keeping the route set in a lib: shown exactly where a page reads
// the scope. SESSION_SCOPABLE_ROUTES is the eight pages that do.
const showSessionPicker = computed(() => SESSION_SCOPABLE_ROUTES.has(String(route.name)));
const sessionList = ref<{ sessionId: string; liveAgentCount: number }[]>([]);
const sessionSelectOptions = computed<SessionOption[]>(() =>
  sessionOptions(sessionList.value, sessionScope.value?.session ?? ''),
);

// Scoped by project, never by session. Scoping the list by the selection it
// offers is how a picker becomes a trapdoor: choose run A and the only run
// left to choose is A, with no way back to B but the URL bar.
async function loadSessionOptions() {
  try {
    sessionList.value = await fetchSessions(undefined, project.value);
  } catch {
    // Non-fatal, and deliberately not cleared: the last known list still
    // names the run the operator is scoped to. The <select> keeps that
    // selection either way -- sessionOptions() re-adds a value the list has
    // forgotten (D-43's argument, one layer down).
  }
}

// The width control only exists while there is a session to widen. That is
// not decoration: `lineage` without `session` is the pair /api/* refuses, and
// a control that cannot be reached cannot send it.
const showScopeWidth = computed(() => showSessionPicker.value && sessionScope.value !== undefined);

function selectNav(id: string) {
  const item = NAV_ITEMS.find((it) => it.id === id);
  if (item?.route) router.push(item.route);
  sheetOpen.value = false;
}

function selectCrumb(to: string) {
  router.push(to);
}

// Liveness, hoisted out of OverviewPage (lib/navBadges.ts has the argument for
// why this is a badge-and-pill job and not a toast one). Every page polls, and
// on the other nine a frozen server was indistinguishable from a quiet
// factory. One shell-level poll now answers both halves for all of them: the
// pill says whether the screen is current, and the sidebar says what arrived
// while the operator was elsewhere.
const now = useNow(1000);
const { pulse, lastUpdatedAt, badges, seePage, refresh } = usePulse(project);
const navItems = computed(() =>
  NAV_ITEMS.map((it) => {
    const count = it.id === undefined ? 0 : (badges.value[it.id] ?? 0);
    return count > 0 ? { ...it, badge: count, badgeLabel: badgeLabel(it.id ?? '', count) } : it;
  }),
);
// `immediate` so the page the operator lands on starts out seen — otherwise
// the first poll would badge the very page they are reading.
watch(activeId, (id) => seePage(id), { immediate: true });
const factoryPulse = computed(() => lastEventLabel(pulse.value?.lastEventAt ?? null, now.value));
const factoryPulseTitle = computed(() =>
  pulse.value?.lastEventType ? `Last event: ${pulse.value.lastEventType}` : undefined,
);
</script>

<template>
  <a href="#main" class="skip-link">Skip to content</a>
  <div class="app-shell">
    <SidebarNav
      v-if="!isMobileWidth"
      :items="navItems"
      :active-id="activeId"
      :collapsed="isCollapsedWidth"
      @select="selectNav"
    />
    <Sheet v-else :open="sheetOpen" @close="sheetOpen = false">
      <SidebarNav :items="navItems" :active-id="activeId" @select="selectNav" />
    </Sheet>

    <div class="app-shell__main">
      <header class="app-topbar">
        <button
          v-if="isMobileWidth"
          type="button"
          class="ds-btn ds-btn--ghost ds-btn--icon-sm"
          aria-label="Open navigation"
          @click="sheetOpen = true"
        >
          <Icon name="panel-left" :size="16" />
        </button>
        <Breadcrumb :items="crumbs" @select="selectCrumb" />
        <div style="margin-left: auto; display: flex; align-items: center; gap: var(--ds-space-2)">
          <!-- Two clocks, not one. LiveStatus answers "is my screen current";
               the pulse answers "is the factory moving". A healthy server
               polled every five seconds reports Live indefinitely over a
               factory that has emitted nothing since Tuesday. -->
          <span v-if="!isMobileWidth" class="app-topbar__pulse" :title="factoryPulseTitle">{{
            factoryPulse
          }}</span>
          <LiveStatus
            :last-updated-at="lastUpdatedAt"
            :now="now"
            :interval-ms="PULSE_POLL_MS"
            @refresh="refresh"
          />
          <Select
            v-if="showProjectSwitcher"
            :model-value="project ?? ''"
            :options="projectOptions"
            aria-label="Project"
            @update:model-value="onSwitchProject"
          />
          <Select
            v-if="showSessionPicker"
            class="app-topbar__session"
            :model-value="sessionScope?.session ?? ''"
            :options="sessionSelectOptions"
            aria-label="Session"
            @update:model-value="setSession"
          />
          <Select
            v-if="showScopeWidth"
            :model-value="width"
            :options="[...SCOPE_WIDTH_OPTIONS]"
            aria-label="Session scope width"
            @update:model-value="setWidth"
          />
          <Tooltip :label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'">
            <button
              type="button"
              class="ds-btn ds-btn--ghost ds-btn--icon-sm"
              aria-label="Toggle theme"
              @click="toggle"
            >
              <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="16" />
            </button>
          </Tooltip>
        </div>
      </header>
      <div class="app-scroll">
        <main id="main">
          <router-view />
        </main>
      </div>
    </div>
    <Toast />
  </div>
</template>
