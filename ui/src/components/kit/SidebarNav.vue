<script setup lang="ts">
// App shell's primary nav (ds-spec.md §2.2 `SidebarNav`, §3). Flat 5-item
// list, no categories/badges — DS1's shell scope has neither in the spec's
// prop table. Collapsible rail (≥1024px, driven by useViewport.ts from
// App.vue) shows icon-only buttons with a right-placed label Tooltip, since
// there is no visible text left to carry the accessible name. The brand mark
// carries over from the old ds/SidebarNav.vue unchanged — collapsing the
// rail hides the word but the mark still identifies the app on its own.
import { PanelLeftClose, PanelLeftOpen } from '@lucide/vue';
import { computed, ref } from 'vue';
import markSrc from '../../assets/brand/mark-96.png';
import Icon from './Icon.vue';
import IconButton from './IconButton.vue';
import Tooltip from './Tooltip.vue';
import type { NavItem } from './types.js';

const props = withDefaults(
  defineProps<{
    items: NavItem[];
    activeId?: string;
    collapsed?: boolean;
  }>(),
  { collapsed: false },
);
const emit = defineEmits<{ select: [id: string] }>();

// Manual rail collapse (ds-spec.md §3), independent of the viewport-driven
// `collapsed` prop (<1024px auto-collapse, App.vue via useViewport.ts). Only
// meaningful >=1024px -- below that the rail is already forced collapsed, so
// the toggle itself is hidden there rather than fighting the viewport.
const SIDEBAR_COLLAPSE_KEY = 'bs-sidebar-collapsed';
const manualCollapsed = ref(false);
try {
  manualCollapsed.value = localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === 'true';
} catch {
  // Storage unavailable (private mode, disabled) -- render with the default.
}
const effectiveCollapsed = computed(() => props.collapsed || manualCollapsed.value);
function toggleCollapsed() {
  manualCollapsed.value = !manualCollapsed.value;
  try {
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, String(manualCollapsed.value));
  } catch {
    // Storage unavailable -- the toggle still works for this session.
  }
}
</script>

<template>
  <nav class="bs-side" :data-collapsed="effectiveCollapsed" aria-label="Primary">
    <div class="bs-side__head">
      <span class="bs-side__mark">
        <img :src="markSrc" alt="Blacksmith" width="24" height="24" decoding="async" />
      </span>
      <span v-if="!effectiveCollapsed" class="bs-side__word">Blacksmith</span>
      <IconButton
        v-if="!collapsed"
        :icon="effectiveCollapsed ? PanelLeftOpen : PanelLeftClose"
        :label="effectiveCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        size="sm"
        @click="toggleCollapsed"
      />
    </div>
    <ul class="bs-side__list">
      <li v-for="it in items" :key="it.id">
        <Tooltip v-if="effectiveCollapsed" mode="label" placement="right" :text="it.label">
          <button
            type="button"
            class="bs-side__item"
            :aria-current="it.id === activeId ? 'page' : undefined"
            :aria-label="it.label"
            @click="emit('select', it.id)"
          >
            <Icon :icon="it.icon" :size="16" />
          </button>
        </Tooltip>
        <button
          v-else
          type="button"
          class="bs-side__item"
          :aria-current="it.id === activeId ? 'page' : undefined"
          @click="emit('select', it.id)"
        >
          <Icon :icon="it.icon" :size="16" />
          <span class="bs-side__label">{{ it.label }}</span>
        </button>
      </li>
    </ul>
  </nav>
</template>
