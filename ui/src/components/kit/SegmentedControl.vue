<script setup lang="ts">
// A 2-option inline switch between routes (ds4-plan.md S1, uiux spec §1).
// Plain RouterLinks, not a WAI-ARIA tablist: no roving tabindex/arrow keys,
// `aria-current="page"` comes from vue-router itself on the exact-active
// link. No accent fill on the selected item (§1.9 accent budget, same rule
// MobileTabBar/App.vue nav active state already follows).
import { RouterLink } from 'vue-router';

export interface SegmentedControlItem {
  to: string;
  label: string;
}

defineProps<{ items: SegmentedControlItem[] }>();
</script>

<template>
  <nav class="bs-segctl">
    <RouterLink v-for="item in items" :key="item.to" class="bs-segctl__item" :to="item.to">
      {{ item.label }}
    </RouterLink>
  </nav>
</template>
