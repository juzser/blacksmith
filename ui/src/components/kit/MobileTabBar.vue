<script setup lang="ts">
// The ≤640px phone shell's bottom tab bar (ds-spec.md §3.1) — same 5 items
// as SidebarNav, icon above label, bottom-fixed. No accent colour on the
// active tab (§1.9's accent budget): active state is aria-current plus a
// neutral --bs-text label + 2px top rule, no selected-background fill.
import Icon from './Icon.vue';
import type { NavItem } from './types.js';

const props = defineProps<{ items: NavItem[]; activeId?: string }>();
const emit = defineEmits<{ select: [id: string] }>();

// Operator decision 2026-10-05: App.vue's activeId resolves to a level-2
// child's own id on its exact route (Work -> Kanban/Roadmap), so Work's
// single phone tab needs to light up for either child's id too -- this
// component never renders the children themselves, the page's own switcher
// still does that job on the phone.
function isActive(it: NavItem): boolean {
  return it.id === props.activeId || !!it.children?.some((c) => c.id === props.activeId);
}
</script>

<template>
  <nav class="bs-tabbar" aria-label="Primary">
    <button
      v-for="it in items"
      :key="it.id"
      type="button"
      class="bs-tabbar__item"
      :aria-current="isActive(it) ? 'page' : undefined"
      @click="emit('select', it.id)"
    >
      <Icon :icon="it.icon" :size="20" />
      <span class="bs-tabbar__label">{{ it.shortLabel ?? it.label }}</span>
    </button>
  </nav>
</template>
