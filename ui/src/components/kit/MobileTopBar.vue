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
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { formatLiveStatus } from '../../lib/format.js';
import Icon from './Icon.vue';
import IconButton from './IconButton.vue';
import MobileProjectSwitcher from './MobileProjectSwitcher.vue';
import Popover from './Popover.vue';
import Separator from './Separator.vue';

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
const menuEl = ref<HTMLElement | null>(null);
const triggerWrap = ref<HTMLElement | null>(null);

function closeOverflow() {
  overflowOpen.value = false;
}

function focusTrigger() {
  triggerWrap.value?.querySelector('button')?.focus();
}

// DS4 S1 round 6 (WAI-ARIA APG menu pattern): the menu's items are not all
// owned by this component — WorkPage teleports its "View" menuitemradio
// group in, KanbanBoard teleports its "Display options" menuitem — so there
// is no single Vue-owned list to keep in sync. Collected fresh from the DOM
// on every keypress and on open instead.
const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
function getMenuItems(): HTMLElement[] {
  if (!menuEl.value) return [];
  return Array.from(menuEl.value.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
}

// Roving tabindex: only the active item is in the tab order; arrow keys
// move both the DOM focus and which item carries tabindex="0".
function focusItemAt(index: number) {
  const items = getMenuItems();
  if (items.length === 0) return;
  const wrapped = ((index % items.length) + items.length) % items.length;
  for (const item of items) item.setAttribute('tabindex', '-1');
  const target = items[wrapped];
  target?.setAttribute('tabindex', '0');
  target?.focus();
}

function onMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeOverflow();
    focusTrigger();
    return;
  }
  if (
    event.key !== 'ArrowDown' &&
    event.key !== 'ArrowUp' &&
    event.key !== 'Home' &&
    event.key !== 'End'
  ) {
    return;
  }
  const items = getMenuItems();
  if (items.length === 0) return;
  // Focus may be inside nested, non-menu content (Kanban's display-options
  // Popover panel: a checkbox, a <select>, a restore button) — those keep
  // their own native keyboard behaviour, so only act when focus is on an
  // actual menu item.
  const current = items.indexOf(document.activeElement as HTMLElement);
  if (current === -1) return;
  event.preventDefault();
  switch (event.key) {
    case 'ArrowDown':
      focusItemAt(current + 1);
      break;
    case 'ArrowUp':
      focusItemAt(current - 1);
      break;
    case 'Home':
      focusItemAt(0);
      break;
    case 'End':
      focusItemAt(items.length - 1);
      break;
  }
}

watch(overflowOpen, (open) => {
  if (open) nextTick(() => focusItemAt(0));
});

// Any navigation closes the overflow — in particular Work's "View" radio
// group teleported in via #bs-mtopbar-overflow-extra, whose own change
// handler routes rather than emitting a dedicated close event (Work's view
// switch, uiux spec §3 focus return).
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
        <span ref="triggerWrap">
          <IconButton
            :icon="Ellipsis"
            label="More actions"
            size="sm"
            aria-haspopup="menu"
            :aria-expanded="overflowOpen"
            @click="overflowOpen = !overflowOpen"
          />
        </span>
      </template>
      <div
        ref="menuEl"
        class="bs-mtopbar__overflow"
        role="menu"
        aria-label="More actions"
        @keydown="onMenuKeydown"
      >
        <button
          type="button"
          class="bs-mtopbar__menuitem"
          role="menuitem"
          tabindex="-1"
          @click="
            emit('togglePause');
            closeOverflow();
          "
        >
          <Icon :icon="live ? Pause : Play" :size="16" />
          <span>{{ live ? 'Pause live updates' : 'Resume live updates' }}</span>
        </button>
        <button
          type="button"
          class="bs-mtopbar__menuitem"
          role="menuitem"
          tabindex="-1"
          @click="
            emit('toggleTheme');
            closeOverflow();
          "
        >
          <Icon :icon="theme === 'dark' ? Sun : Moon" :size="16" />
          <span>{{ theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme' }}</span>
        </button>
        <!-- "Open desktop view" is deferred, see ui/docs/DESIGN.md Known
             deviations — no viewport-override mechanism exists yet. Stays
             focusable (round 6): aria-disabled, not the native disabled
             attribute, so the arrow-key walk still reaches it. -->
        <button
          type="button"
          class="bs-mtopbar__menuitem"
          role="menuitem"
          tabindex="-1"
          aria-disabled="true"
        >
          <Icon :icon="Settings" :size="16" />
          <span>Settings</span>
        </button>
        <Separator />
        <!-- ds-spec.md §3.1 Work/Kanban row: page-specific overflow controls
             (e.g. Kanban's display options) teleport in here, same Teleport
             mechanism kit/Dialog.vue/Sheet.vue/Toast.vue already use. Kept
             prop-free: MobileTopBar stays generic shell chrome. -->
        <div id="bs-mtopbar-overflow-extra" class="bs-mtopbar__overflow-extra"></div>
      </div>
    </Popover>
  </header>
</template>
