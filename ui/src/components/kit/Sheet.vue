<script setup lang="ts">
// Off-canvas mobile sidebar (ds-spec.md §3: SidebarNav's <768px off-canvas
// sheet). Port of ds/Sheet.vue onto bs- classes and kit primitives — same
// useModalFocus wiring (D-238: focus-in, Tab trap, inert background,
// focus-return-on-close), same single "mobile sidebar only" use (§6.1).
import { X } from '@lucide/vue';
import { ref } from 'vue';
import { useModalFocus } from '../../composables/useModalFocus.js';
import IconButton from './IconButton.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const sheetEl = ref<HTMLElement | null>(null);
useModalFocus(
  sheetEl,
  () => props.open,
  () => emit('close'),
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="bs-sheet-overlay" @click="emit('close')" />
    <div
      v-if="open"
      ref="sheetEl"
      class="bs-sheet"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label="Navigation"
    >
      <IconButton class="bs-sheet__close" :icon="X" label="Close navigation" size="sm" @click="emit('close')" />
      <slot />
    </div>
  </Teleport>
</template>
