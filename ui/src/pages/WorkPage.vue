<script setup lang="ts">
// Work: a shared shell for the Kanban/Roadmap switch.
// View-agnostic — the title/crumb read "Work" on both (operator decision),
// and view-specific controls (Kanban's Clear-filter/Refresh) stay inside
// their own page, not here. Reuses the old kit's `.app-page` wrapper rather
// than inventing a new kit page-container (KanbanPage/RoadmapPage used to
// carry it themselves; WorkPage now owns it once for both).
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PageHeader from '../components/kit/PageHeader.vue';
import SegmentedControl from '../components/kit/SegmentedControl.vue';
import Separator from '../components/kit/Separator.vue';
import { switchQuery, WORK_VIEWS, workViewFromRouteName } from '../lib/workView.js';

const route = useRoute();
const router = useRouter();

const segItems = computed(() =>
  WORK_VIEWS.map((v) => ({
    to: { path: v.path, query: switchQuery(route.query) },
    label: v.label,
  })),
);
const radioOptions = WORK_VIEWS.map((v) => ({ value: v.value, label: v.label }));
const currentView = computed(() => workViewFromRouteName(route.name));

function onPickView(value: string) {
  const target = WORK_VIEWS.find((v) => v.value === value);
  if (target) router.push({ path: target.path, query: switchQuery(route.query) });
}
</script>

<template>
  <div class="app-page app-page--full-bleed">
    <PageHeader title="Work" />

    <!-- Desktop/tablet: the switch shares the toolbar row each view already
         renders (#bs-work-view-switch, next to Epic select / task count /
         Refresh) instead of a PageHeader row of its own — that row held
         nothing but this once the h1 went sr-only, leaving an empty band
         above the toolbar (UI audit, fix round 1). `defer` (Vue 3.5) lets
         the target mount later in the same pass, since it lives inside the
         child route page, not a sibling mounted ahead of it. .bs-segctl
         still hides itself below --bs-bp-mobile (bs-primitives.css), so this is a
         no-op on phone, where the switch lives only in the overflow menu
         below. -->
    <Teleport to="#bs-work-view-switch" defer>
      <SegmentedControl :items="segItems" />
    </Teleport>

    <!-- Must render before <router-view> so this teleports above Kanban's
         own display-options teleport inside #bs-mtopbar-overflow-extra
         (uiux spec §3: View group, Separator, then the active view's own
         controls). Closing the overflow on pick is MobileTopBar's own job
         (it watches route.fullPath), not this component's.

         DS4 S1 round 6 (S3 a11y finding): `role="menuitemradio"` buttons,
         not kit's RadioGroup component — a radiogroup of native radio
         inputs is not a valid child of the overflow's `role="menu"`, and
         RadioGroup keeps its unchanged contract for its other caller
         (LessonsPage). tabindex is "-1" by default; MobileTopBar owns the
         roving tabindex across the whole menu. -->
    <Teleport to="#bs-mtopbar-overflow-extra">
      <span class="bs-mtopbar__menu-label" aria-hidden="true">View</span>
      <div class="bs-mtopbar__viewgroup" role="group" aria-label="View">
        <button
          v-for="opt in radioOptions"
          :key="opt.value"
          type="button"
          class="bs-mtopbar__menuitem bs-mtopbar__viewitem"
          role="menuitemradio"
          tabindex="-1"
          :aria-checked="currentView === opt.value"
          @click="onPickView(opt.value)"
        >
          <span class="bs-mtopbar__radio-dot" aria-hidden="true"></span>
          <span>{{ opt.label }}</span>
        </button>
      </div>
      <Separator />
    </Teleport>

    <router-view />
  </div>
</template>
