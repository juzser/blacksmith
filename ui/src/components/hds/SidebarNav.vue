<script setup lang="ts">
import markSrc from '../../assets/brand/mark-96.png';
import Icon from './Icon.vue';
import Tooltip from './Tooltip.vue';
import type { NavItem } from './types.js';

withDefaults(
  defineProps<{
    items: NavItem[];
    activeId?: string;
    collapsed?: boolean;
    brand?: string;
  }>(),
  { brand: 'Blacksmith', collapsed: false },
);
const emit = defineEmits<{ select: [id: string] }>();
</script>

<template>
  <nav class="hds-side" :data-collapsed="collapsed" aria-label="Primary">
    <div class="hds-side__head">
      <!-- The word is hidden when the rail collapses, so the mark carries the
           brand on its own — hence the logo rather than a "B" placeholder.
           alt is the brand name because that is what the mark means here. -->
      <span class="hds-side__mark">
        <img :src="markSrc" :alt="brand" width="24" height="24" decoding="async" />
      </span>
      <span v-if="!collapsed" class="hds-side__word">{{ brand }}</span>
    </div>
    <ul class="hds-side__group">
      <template v-for="(it, i) in items" :key="it.category ? `cat-${it.category}` : it.id ?? i">
        <li v-if="it.category" class="hds-side__cat">{{ it.category }}</li>
        <li v-else>
          <Tooltip v-if="it.disabled" :label="it.disabledReason ?? 'Phase 6b'" side="right">
            <button type="button" class="hds-side__item" disabled :aria-label="it.label">
              <Icon v-if="it.icon" :name="it.icon" :size="16" />
              <span v-if="!collapsed">{{ it.label }}</span>
            </button>
          </Tooltip>
          <button
            v-else
            type="button"
            class="hds-side__item"
            :data-active="it.id === activeId"
            :aria-current="it.id === activeId ? 'page' : undefined"
            :aria-label="collapsed ? it.label : undefined"
            @click="it.id && emit('select', it.id)"
          >
            <Icon v-if="it.icon" :name="it.icon" :size="16" />
            <span v-if="!collapsed">{{ it.label }}</span>
          </button>
        </li>
      </template>
    </ul>
  </nav>
</template>
