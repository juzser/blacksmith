<script setup lang="ts">
// The ≤640px phone shell's topbar (ds-spec.md §3.1): hamburger, page title,
// a compact ProjectSwitcher when the route is scoped, a liveness dot, and an
// overflow menu holding the controls the desktop topbar spreads across
// LiveIndicator's four buttons — 375px has no room for all of them inline.
import { Ellipsis, Menu } from '@lucide/vue';
import { ref } from 'vue';
import IconButton from './IconButton.vue';
import LiveIndicator from './LiveIndicator.vue';
import Popover from './Popover.vue';
import ProjectSwitcher from './ProjectSwitcher.vue';

defineProps<{
  title: string;
  live: boolean;
  theme: 'light' | 'dark';
  lastEventAt: string | null;
  now: string;
  showProjectSwitcher: boolean;
  project: string;
  projectOptions: { value: string; label: string }[];
}>();
const emit = defineEmits<{
  openNav: [];
  updateProject: [value: string];
  refresh: [];
  togglePause: [];
  toggleTheme: [];
}>();

const overflowOpen = ref(false);
function closeOverflow() {
  overflowOpen.value = false;
}
</script>

<template>
  <header class="bs-mtopbar">
    <IconButton :icon="Menu" label="Open navigation" size="sm" @click="emit('openNav')" />
    <span class="bs-mtopbar__title">{{ title }}</span>
    <ProjectSwitcher
      v-if="showProjectSwitcher"
      class="bs-mtopbar__project"
      :model-value="project"
      :options="projectOptions"
      @update:model-value="(v) => emit('updateProject', v)"
    />
    <span class="bs-mtopbar__dot" :data-live="live" aria-hidden="true"></span>
    <Popover :open="overflowOpen" label="More controls" @close="closeOverflow">
      <template #trigger>
        <IconButton
          :icon="Ellipsis"
          label="More controls"
          size="sm"
          @click="overflowOpen = !overflowOpen"
        />
      </template>
      <div class="bs-mtopbar__overflow">
        <LiveIndicator
          :live="live"
          :theme="theme"
          :last-event-at="lastEventAt"
          :now="now"
          @refresh="
            emit('refresh');
            closeOverflow();
          "
          @toggle-pause="emit('togglePause')"
          @toggle-theme="emit('toggleTheme')"
        />
      </div>
    </Popover>
  </header>
</template>
