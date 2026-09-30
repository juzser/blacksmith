<script setup lang="ts">
import { Menu } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Banner from './components/kit/Banner.vue';
import Breadcrumb from './components/kit/Breadcrumb.vue';
import IconButton from './components/kit/IconButton.vue';
import LiveIndicator from './components/kit/LiveIndicator.vue';
import MobileTabBar from './components/kit/MobileTabBar.vue';
import MobileTopBar from './components/kit/MobileTopBar.vue';
import ProjectSwitcher from './components/kit/ProjectSwitcher.vue';
import Select from './components/kit/Select.vue';
import Sheet from './components/kit/Sheet.vue';
import SidebarNav from './components/kit/SidebarNav.vue';
import Toast from './components/kit/Toast.vue';
import { useNow } from './composables/useNow.js';
import { getIsLive, setLive } from './composables/usePoll.js';
import { useProjectContext } from './composables/useProjectContext.js';
import { usePulse } from './composables/usePulse.js';
import { useSessionContext } from './composables/useSessionContext.js';
import { useTheme } from './composables/useTheme.js';
import { useViewport } from './composables/useViewport.js';
import { fetchProjects, fetchSessions } from './lib/api.js';
import { projectionNotice } from './lib/projectionIssues.js';
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
const { isCollapsedWidth, isMobileWidth, isPhoneWidth } = useViewport();
const { project, setProject } = useProjectContext();
const { sessionScope, width, setSession, setWidth } = useSessionContext();

const sheetOpen = ref(false);
const activeId = computed(() => {
  // /p/:project/overview and /overview both highlight "home"; every other
  // page matches its route exactly (query params ignored).
  if (route.name === 'overview-global' || route.name === 'overview-project') return 'home';
  const found = NAV_ITEMS.find((it) => it.route === route.path);
  return found?.id;
});

// The topbar Breadcrumb (ds-spec.md §3, DS1): derived from route meta so it
// updates the instant navigation happens, before the new page's own data has
// arrived — never from a page's fetched payload.
const crumbs = computed(() => route.meta.crumb?.(route) ?? []);
const pageTitle = computed(() => crumbs.value.at(-1)?.label ?? '');

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

// Session picker (topbar, ds-spec.md §3): visible only on Activity and
// Roadmap, decoupled from which pages read the URL's ?session scope (those
// keep reading it regardless, so a deep link into any of them still filters —
// see sessionScope.ts's SESSION_SCOPABLE_ROUTES doc comment).
const showSessionPicker = computed(() => SESSION_SCOPABLE_ROUTES.has(String(route.name)));
const sessionList = ref<{ sessionId: string; workingAgentCount: number }[]>([]);
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

// Liveness + the single Refresh/Pause/theme/Settings cluster (ds-spec.md
// §2.2 `LiveIndicator`), replacing the old two-clock topbar (a pulse <span>
// plus a separate LiveStatus.vue) — /api/pulse already carries both signals,
// so this is a shell-level render change, not a server/API one.
const now = useNow(1000);
const { pulse, refresh } = usePulse(project);
const live = getIsLive();
function onTogglePause() {
  setLive(!live.value);
}
// What the projection could not land. Shell-level, like the pulse, because
// the gap is under every page at once: a session the server could not fold
// is absent from Sessions, Kanban, Flow and every count, and each of those
// pages would otherwise show its emptiness as a fact about the factory.
const projection = computed(() => projectionNotice(pulse.value));
</script>

<template>
  <a href="#main" class="skip-link">Skip to content</a>
  <div class="app-shell" :data-phone="isPhoneWidth">
    <SidebarNav
      v-if="!isPhoneWidth && !isMobileWidth"
      :items="NAV_ITEMS"
      :active-id="activeId"
      :collapsed="isCollapsedWidth"
      @select="selectNav"
    />
    <Sheet :open="sheetOpen" @close="sheetOpen = false">
      <SidebarNav :items="NAV_ITEMS" :active-id="activeId" @select="selectNav" />
    </Sheet>

    <div class="app-shell__main">
      <MobileTopBar
        v-if="isPhoneWidth"
        :title="pageTitle"
        :live="live"
        :theme="theme"
        :last-event-at="pulse?.lastEventAt ?? null"
        :now="now"
        :show-project-switcher="showProjectSwitcher"
        :project="project ?? ''"
        :project-options="projectOptions"
        @open-nav="sheetOpen = true"
        @update-project="onSwitchProject"
        @refresh="refresh"
        @toggle-pause="onTogglePause"
        @toggle-theme="toggle"
      />
      <header v-else class="app-topbar">
        <IconButton
          v-if="isMobileWidth"
          :icon="Menu"
          label="Open navigation"
          size="sm"
          @click="sheetOpen = true"
        />
        <Breadcrumb :items="crumbs" @select="selectCrumb" />
        <div class="app-topbar__controls">
          <ProjectSwitcher
            v-if="showProjectSwitcher"
            :model-value="project ?? ''"
            :options="projectOptions"
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
          <LiveIndicator
            :live="live"
            :theme="theme"
            :last-event-at="pulse?.lastEventAt ?? null"
            :now="now"
            @refresh="refresh"
            @toggle-pause="onTogglePause"
            @toggle-theme="toggle"
          />
        </div>
      </header>
      <!-- Under the topbar and above the page, not inside it: the page below
           is the thing this is warning about. Warning, not danger — the
           server is up and answering; it is the numbers that are short. -->
      <Banner
        v-if="projection"
        tone="warning"
        class="app-projection"
        show-retry
        retry-label="Retry"
        @retry="refresh"
      >
        {{ projection.lead }}
        <ul class="app-projection__lines">
          <li v-for="line in projection.lines" :key="line">{{ line }}</li>
        </ul>
      </Banner>
      <div class="app-scroll">
        <main id="main">
          <router-view />
        </main>
      </div>
      <MobileTabBar v-if="isPhoneWidth" :items="NAV_ITEMS" :active-id="activeId" @select="selectNav" />
    </div>
    <Toast />
  </div>
</template>
