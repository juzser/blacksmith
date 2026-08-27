<script setup lang="ts">
// Dialog — WAI-ARIA Dialog pattern: focus-trapped, Esc closes, focus
// returns to the triggering element on close (design-spec.md §7's Lessons
// review row). Shared base for Dialog and AlertDialog (AlertDialog adds
// the destructive-confirm semantics on top of this shell).
import { ref, useId } from 'vue';
import { useModalFocus } from '../../composables/useModalFocus.js';
import Icon from './Icon.vue';

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
     * target, and only this component can generate that id (D-236).
     */
    description?: string;
  }>(),
  { size: 'default', role: 'dialog' },
);
const emit = defineEmits<{ close: [] }>();

const descId = useId();

const dialogEl = ref<HTMLElement | null>(null);
// Focus trap, focus restore, Esc, and the inert background all live in
// useModalFocus — Sheet needs the identical four, and keeping a second copy
// here is what let them drift apart in the first place (D-238).
useModalFocus(
  dialogEl,
  () => props.open,
  () => emit('close'),
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ds-dialog-overlay" @click="emit('close')">
      <div
        ref="dialogEl"
        class="ds-dialog"
        :class="{ 'ds-dialog--sm': size === 'sm' }"
        :role="role"
        aria-modal="true"
        :aria-label="title"
        :aria-describedby="description ? descId : undefined"
        @click.stop
      >
        <div class="ds-dialog__head">
          <div class="ds-dialog__title">{{ title }}</div>
          <button
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--icon-sm"
            aria-label="Close dialog"
            @click="emit('close')"
          >
            <Icon name="x" :size="16" />
          </button>
        </div>
        <div class="ds-dialog__body">
          <p v-if="description" :id="descId" class="ds-card__desc">{{ description }}</p>
          <slot />
        </div>
        <div v-if="$slots.footer" class="ds-dialog__footer">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
