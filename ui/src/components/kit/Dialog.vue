<script setup lang="ts">
// Dialog — WAI-ARIA Dialog pattern: focus-trapped, Esc closes, focus
// returns to the triggering element on close (ds-spec.md §2.1). Shared base
// for Dialog and AlertDialog (AlertDialog adds the destructive-confirm
// semantics on top of this shell). Ported from ds/Dialog.vue: the close
// button is now an IconButton (§2.5's icon-only rule) instead of a raw
// button+Icon pair.

import { X } from '@lucide/vue';
import { ref, useId } from 'vue';
import { useModalFocus } from '../../composables/useModalFocus.js';
import IconButton from './IconButton.vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    size?: 'default' | 'sm';
    /**
     * `alertdialog` for a destructive confirm (AlertDialog passes it): ARIA
     * reserves that role for an alert that also demands a response, and
     * assistive clients announce the two differently.
     */
    role?: 'dialog' | 'alertdialog';
    /**
     * The consequence sentence. Owned here rather than left to the caller's
     * slot markup because it has to be the dialog's `aria-describedby`
     * target, and only this component can generate that id.
     */
    description?: string;
  }>(),
  { size: 'default', role: 'dialog' },
);
const emit = defineEmits<{ close: [] }>();

const descId = useId();

const dialogEl = ref<HTMLElement | null>(null);
// Focus trap, focus restore, Esc, and the inert background all live in
// useModalFocus — Popover doesn't reuse it (no focus trap there), but every
// full-modal surface (Dialog, AlertDialog, Sheet) shares this one copy.
useModalFocus(
  dialogEl,
  () => props.open,
  () => emit('close'),
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="bs-dialog-overlay" @click="emit('close')">
      <div
        ref="dialogEl"
        class="bs-dialog"
        :class="{ 'bs-dialog--sm': size === 'sm' }"
        :role="role"
        aria-modal="true"
        :aria-label="title"
        :aria-describedby="description ? descId : undefined"
        @click.stop
      >
        <div class="bs-dialog__head">
          <div class="bs-dialog__title">{{ title }}</div>
          <IconButton :icon="X" label="Close dialog" size="sm" @click="emit('close')" />
        </div>
        <div class="bs-dialog__body">
          <p v-if="description" :id="descId" class="bs-dialog__desc">{{ description }}</p>
          <slot />
        </div>
        <div v-if="$slots.footer" class="bs-dialog__footer">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
