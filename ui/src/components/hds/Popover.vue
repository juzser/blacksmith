<script setup lang="ts">
// Popover — single-step confirm (Task detail's Waive/Deny, design-spec.md
// §5.5's documented judgment call: a waiver decision gets Popover confirm,
// not full AlertDialog ceremony).
import { onBeforeUnmount, watch } from 'vue';

const props = defineProps<{
  open: boolean;
  /**
   * The panel's accessible name. Required, not optional: `role="dialog"`
   * without one announces as a bare "dialog", and an optional prop is how
   * this one went nameless for as long as it did (D-239).
   */
  label: string;
}>();
const emit = defineEmits<{ close: [] }>();

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}
watch(
  () => props.open,
  (open) => {
    if (open) document.addEventListener('keydown', onKeydown);
    else document.removeEventListener('keydown', onKeydown);
  },
);
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <span class="hds-popover">
    <slot name="trigger" />
    <div v-if="open" class="hds-popover__panel" role="dialog" aria-modal="false" :aria-label="label">
      <slot />
    </div>
  </span>
</template>
