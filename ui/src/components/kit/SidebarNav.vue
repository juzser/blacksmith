<script setup lang="ts">
// App shell's primary nav (ds-spec.md §2.2 `SidebarNav`, §3). One list of
// top-level items, no categories/badges; an item may carry on-demand
// level-2 `children` (Work -> Kanban, Roadmap, operator 2026-10-05) that
// render only while that item's own section is current. Collapsible rail (≥1024px, driven by useViewport.ts from
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
    // Off-canvas Sheet copy (App.vue) has no icon-only rail state to toggle,
    // and a focusable IconButton there would eat the Sheet's first Escape via
    // its own focus-visible Tooltip (Tooltip.vue's capture-phase Escape
    // listener wins the race against useModalFocus.ts's close handler) --
    // so the Sheet instance opts out while the persistent rail keeps it.
    showCollapseToggle?: boolean;
  }>(),
  { collapsed: false, showCollapseToggle: true },
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

// Operator decision 2026-10-05: a parent with level-2 `children` (Work ->
// Kanban, Roadmap) stays marked while either child is -- the parent names
// the section, the child names which page inside it. Only the child is the
// page; the parent reads "true" (current section) and bs-primitives.css
// gives it bold text with no fill, so the two never fuse into one block.
// The collapsed rail hides the children, so there the parent is the page.
// Also drives the sublist's own visibility below (template `v-if`): a
// truthy result from this is "this item's section is current", so the
// sublist only renders while the operator is already inside that section --
// every other page keeps the rail to one flat row per item.
function currentFor(it: NavItem): 'page' | 'true' | undefined {
  if (it.id === props.activeId) return 'page';
  if (it.children?.some((c) => c.id === props.activeId))
    return effectiveCollapsed.value ? 'page' : 'true';
  return undefined;
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
        v-if="!collapsed && showCollapseToggle"
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
            :aria-current="currentFor(it)"
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
          :aria-current="currentFor(it)"
          @click="emit('select', it.id)"
        >
          <Icon :icon="it.icon" :size="16" />
          <span class="bs-side__label">{{ it.label }}</span>
        </button>
        <ul
          v-if="!effectiveCollapsed && it.children?.length && currentFor(it)"
          class="bs-side__sublist"
        >
          <li v-for="child in it.children" :key="child.id">
            <button
              type="button"
              class="bs-side__subitem"
              :aria-current="child.id === activeId ? 'page' : undefined"
              @click="emit('select', child.id)"
            >
              {{ child.label }}
            </button>
          </li>
        </ul>
      </li>
    </ul>
  </nav>
</template>
