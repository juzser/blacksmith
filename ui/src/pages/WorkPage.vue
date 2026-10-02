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
import RadioGroup from '../components/kit/RadioGroup.vue';
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
    <PageHeader title="Work">
      <template #actions>
        <SegmentedControl :items="segItems" />
      </template>
    </PageHeader>

    <!-- Must render before <router-view> so this teleports above Kanban's
         own display-options teleport inside #bs-mtopbar-overflow-extra
         (uiux spec §3: View radio group, Separator, then the active view's
         own controls). Closing the overflow on pick is MobileTopBar's own
         job (it watches route.fullPath), not this component's. -->
    <Teleport to="#bs-mtopbar-overflow-extra">
      <span class="bs-mtopbar__menu-label">View</span>
      <RadioGroup
        :model-value="currentView"
        :options="radioOptions"
        name="work-view"
        aria-label="View"
        @update:model-value="onPickView"
      />
      <Separator />
    </Teleport>

    <router-view />
  </div>
</template>
