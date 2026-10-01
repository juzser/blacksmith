<script setup lang="ts">
// Popover — single-step confirm (a lighter-weight alternative to
// AlertDialog for a low-stakes decision, ds-spec.md §2.1). No focus trap:
// unlike Dialog, this doesn't reuse useModalFocus — only Escape-to-close
// is wired, manually, so a popover never steals focus off its trigger.
import { onBeforeUnmount, watch } from 'vue';

const props = defineProps<{
  open: boolean;
  /**
   * The panel's accessible name. Required, not optional: `role="dialog"`
   * without one announces as a bare "dialog".
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
  <span class="bs-popover">
    <slot name="trigger" />
    <!-- v-show, not v-if: a page can Teleport content into this slot (e.g.
         KanbanBoard.vue's mobile display-options control into
         MobileTopBar's overflow menu) before the user ever opens the
         popover. v-if would unmount that Teleport's target along with the
         panel, leaving Teleport's content stuck with no home — v-show keeps
         the target (and therefore the teleported component) alive, just
         hidden, so the very first open finds a real, already-initialized
         instance instead of a broken one. -->
    <div v-show="open" class="bs-popover__panel" role="dialog" aria-modal="false" :aria-label="label">
      <slot />
    </div>
  </span>
</template>
