<script setup lang="ts">
// The ≤640px phone shell's topbar (ds-spec.md §3.1): page title, a compact
// MobileProjectSwitcher when the route is scoped, a liveness dot, and an
// overflow menu holding the controls the desktop topbar spreads across
// LiveIndicator's buttons — 375px has no room for all of them inline. No
// hamburger here: below 640px MobileTabBar replaces the sidebar/Sheet
// entirely, so there is no navigation drawer left for one to open (finding
// 2). Refresh is dropped too (finding 3) — it is aria-disabled while live
// everywhere already, and mobile has no room to spare on a control that is
// almost always inert; Pause still reaches the same "make Refresh useful"
// path. Page-view options and "Open desktop view" are deferred, see
// ui/docs/DESIGN.md Known deviations.
import { Ellipsis, Moon, Pause, Play, Settings, Sun } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { formatLiveStatus } from '../../lib/format.js';
import IconButton from './IconButton.vue';
import MobileProjectSwitcher from './MobileProjectSwitcher.vue';
import Popover from './Popover.vue';

const props = defineProps<{
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
  updateProject: [value: string];
  togglePause: [];
  toggleTheme: [];
}>();

const overflowOpen = ref(false);
function closeOverflow() {
  overflowOpen.value = false;
}

// Any navigation closes the overflow — in particular Work's "View" radio
// group teleported in via #bs-mtopbar-overflow-extra, whose own change
// handler routes rather than emitting a dedicated close event (ds4-plan.md
// S1, uiux spec §3 focus return).
const route = useRoute();
watch(() => route.fullPath, closeOverflow);

// Same text LiveIndicator.vue composes inline (statusLabel + a conditional
// RelativeTime), as a plain string here because this is an aria-label, not a
// live-ticking DOM node.
const dotLabel = computed(() => formatLiveStatus(props.live, props.lastEventAt, props.now));
</script>

<template>
  <header class="bs-mtopbar">
    <span class="bs-mtopbar__title">{{ title }}</span>
    <MobileProjectSwitcher
      v-if="showProjectSwitcher"
      class="bs-mtopbar__project"
      :model-value="project"
      :options="projectOptions"
      @update:model-value="(v) => emit('updateProject', v)"
    />
    <span class="bs-mtopbar__dot" :data-live="live" :aria-label="dotLabel"></span>
    <Popover :open="overflowOpen" label="More actions" @close="closeOverflow">
      <template #trigger>
        <IconButton
          :icon="Ellipsis"
          label="More actions"
          size="sm"
          @click="overflowOpen = !overflowOpen"
        />
      </template>
      <div class="bs-mtopbar__overflow">
        <IconButton
          :icon="live ? Pause : Play"
          :label="live ? 'Pause updates' : 'Resume updates'"
          size="sm"
          @click="
            emit('togglePause');
            closeOverflow();
          "
        />
        <IconButton
          :icon="theme === 'dark' ? Sun : Moon"
          :label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
          size="sm"
          @click="
            emit('toggleTheme');
            closeOverflow();
          "
        />
        <IconButton :icon="Settings" label="Settings" size="sm" disabled />
        <!-- ds-spec.md §3.1 Work/Kanban row: page-specific overflow controls
             (e.g. Kanban's display options) teleport in here, same Teleport
             mechanism kit/Dialog.vue/Sheet.vue/Toast.vue already use. Kept
             prop-free: MobileTopBar stays generic shell chrome. -->
        <div id="bs-mtopbar-overflow-extra" class="bs-mtopbar__overflow-extra"></div>
      </div>
    </Popover>
  </header>
</template>
