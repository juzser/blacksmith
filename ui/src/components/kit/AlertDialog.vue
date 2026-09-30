<script setup lang="ts">
// AlertDialog — destructive/irreversible confirms: built on Dialog's
// focus-trap shell, adds the confirm/cancel footer with the destructive
// action as `danger` variant, never the default-focused button.
//
// `description` is handed to Dialog rather than rendered here, so it becomes
// the dialog's `aria-describedby` target.
import Button from './Button.vue';
import Dialog from './Dialog.vue';

withDefaults(
  defineProps<{ open: boolean; title: string; confirmLabel: string; description?: string }>(),
  {},
);
const emit = defineEmits<{ close: []; confirm: [] }>();
</script>

<template>
  <Dialog
    :open="open"
    :title="title"
    :description="description"
    size="sm"
    role="alertdialog"
    @close="emit('close')"
  >
    <slot />
    <template #footer>
      <Button variant="secondary" size="sm" @click="emit('close')">Cancel</Button>
      <Button variant="danger" size="sm" @click="emit('confirm')">{{ confirmLabel }}</Button>
    </template>
  </Dialog>
</template>
