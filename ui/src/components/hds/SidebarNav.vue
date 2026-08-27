<script setup lang="ts">
import markSrc from '../../assets/brand/mark-96.png';
import { badgeText } from '../../lib/navBadges.js';
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

/**
 * The accessible name, which a badge changes even when the label is visible.
 * Expanded, the rail normally leaves the name to the button's own text — but
 * that text becomes "Timeline 3", and a bare 3 is not a claim. Whenever there
 * is something to report, the name says what: "Timeline, 3 new".
 */
function itemLabel(it: NavItem, isCollapsed: boolean): string | undefined {
  const count = it.badge ?? 0;
  if (count > 0) return `${it.label}, ${it.badgeLabel ?? `${count} new`}`;
  return isCollapsed ? it.label : undefined;
}
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
            :aria-label="itemLabel(it, collapsed)"
            @click="it.id && emit('select', it.id)"
          >
            <Icon v-if="it.icon" :name="it.icon" :size="16" />
            <span v-if="!collapsed">{{ it.label }}</span>
            <!-- Both forms are aria-hidden: the count is already in the
                 button's accessible name, where it can say what it counts.
                 Collapsed there is no room for "99+", so the rail keeps only
                 the fact that something is waiting and lets the name carry
                 the number. -->
            <span
              v-if="(it.badge ?? 0) > 0 && !collapsed"
              class="hds-side__badge"
              aria-hidden="true"
              >{{ badgeText(it.badge ?? 0) }}</span
            >
            <span
              v-else-if="(it.badge ?? 0) > 0"
              class="hds-side__dot"
              aria-hidden="true"
            ></span>
          </button>
        </li>
      </template>
    </ul>
  </nav>
</template>
