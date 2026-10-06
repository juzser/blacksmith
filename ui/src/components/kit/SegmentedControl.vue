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

// `current` (an item label) makes the control mark the current item itself
// instead of trusting the router, whose exact-active ignores the query -- for
// query-only links. `touch` keeps it on phone at the --bs-touch floor.
defineProps<{ items: SegmentedControlItem[]; current?: string; touch?: boolean }>();
</script>

<template>
  <nav class="bs-segctl" :class="{ 'bs-segctl--touch': touch }">
    <template v-for="item in items" :key="item.label">
      <RouterLink v-if="current === undefined" class="bs-segctl__item" :to="item.to">
        {{ item.label }}
      </RouterLink>
      <RouterLink v-else :to="item.to" custom v-slot="{ href, navigate }">
        <a
          class="bs-segctl__item"
          :href="href"
          :aria-current="current === item.label ? 'page' : undefined"
          @click="navigate"
        >
          {{ item.label }}
        </a>
      </RouterLink>
    </template>
  </nav>
</template>
