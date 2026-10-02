<script setup lang="ts">
// A 2-option inline switch between routes (Work's Kanban/Roadmap, uiux spec §1).
// Plain RouterLinks, not a WAI-ARIA tablist: no roving tabindex/arrow keys,
// `aria-current="page"` comes from vue-router itself on the exact-active
// link. No accent fill on the selected item (§1.9 accent budget, same rule
// MobileTabBar/App.vue nav active state already follows).
import type { RouteLocationRaw } from 'vue-router';
import { RouterLink } from 'vue-router';

export interface SegmentedControlItem {
  to: RouteLocationRaw;
  label: string;
}

defineProps<{ items: SegmentedControlItem[] }>();
</script>

<template>
  <nav class="bs-segctl">
    <RouterLink v-for="item in items" :key="item.label" class="bs-segctl__item" :to="item.to">
      {{ item.label }}
    </RouterLink>
  </nav>
</template>
