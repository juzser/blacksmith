<script setup lang="ts">
// Off-canvas mobile sidebar (design-spec.md §2, the kit's Sheet.prompt.md's
// documented "also used as the mobile sidebar" case) — the one Sheet use in
// this app, not a generic drawer (§6.1: "Sheet — only for the mobile
// off-canvas sidebar, not as a generic drawer").
import { ref } from 'vue';
import { useModalFocus } from '../../composables/useModalFocus.js';
import Icon from './Icon.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const sheetEl = ref<HTMLElement | null>(null);
// This element claims `aria-modal="true"` below, and used to handle only Esc
// — focus stayed on the hamburger behind the overlay, Tab walked out into the
// topbar and page, #app was never inert, and closing via the X dropped focus
// onto <body> when that button unmounted. Same composable as Dialog, so the
// two cannot diverge again (D-238).
useModalFocus(
  sheetEl,
  () => props.open,
  () => emit('close'),
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="app-sheet-overlay" @click="emit('close')" />
    <div
      v-if="open"
      ref="sheetEl"
      class="app-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Navigation"
    >
      <button
        type="button"
        class="ds-btn ds-btn--ghost ds-btn--icon-sm"
        style="position: absolute; top: var(--ds-space-2); right: var(--ds-space-2); z-index: 1"
        aria-label="Close navigation"
        @click="emit('close')"
      >
        <Icon name="x" :size="16" />
      </button>
      <slot />
    </div>
  </Teleport>
</template>
