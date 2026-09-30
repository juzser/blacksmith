<script setup lang="ts">
// ds-spec.md §2.5. State (shown/timer/singleton) lives in useTooltip.ts,
// which is unit tested (ui/test/useTooltip.test.ts) precisely because it is
// DOM-free; everything here — hover/focus listeners, Escape, floating-ui
// positioning, aria wiring — needs a real DOM, which ui/vitest.config.ts
// deliberately does not provide (component/page behaviour is Playwright's
// job, per that file's own comment). Same split useModalFocus.ts draws
// between its DOM-free callers and its own untested DOM wiring. This PR is
// additive and inert (§5, DS0): no page imports Tooltip yet, so it also has
// no e2e surface yet — that arrives with the PR that first wires a page to
// ui/src/components/kit/.
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { onBeforeUnmount, ref, watch } from 'vue';
import { useTooltip } from '../../composables/useTooltip.js';

const props = withDefaults(
  defineProps<{
    text: string;
    placement?: 'top' | 'right' | 'bottom' | 'left';
    mode: 'describe' | 'label';
  }>(),
  { placement: 'top' },
);

const tooltipId = `bs-tooltip-${Math.random().toString(36).slice(2)}`;
const triggerRef = ref<HTMLElement | null>(null);
const bubbleRef = ref<HTMLElement | null>(null);
const { shown, scheduleShow, showNow, hide } = useTooltip();

const bubbleX = ref(0);
const bubbleY = ref(0);
let stopAutoUpdate: (() => void) | null = null;

async function updatePosition() {
  if (!triggerRef.value || !bubbleRef.value) return;
  const { x, y } = await computePosition(triggerRef.value, bubbleRef.value, {
    placement: props.placement,
    strategy: 'fixed',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });
  bubbleX.value = x;
  bubbleY.value = y;
}

// Esc "dismisses it without moving focus" (§2.5) even when the tooltip was
// opened by hover, where keyboard focus may be elsewhere entirely — a
// document-level listener catches that case; hide() never touches focus.
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') hide();
}

// flush: 'post' so bubbleRef is the just-rendered <span v-if="shown"> element,
// not still null from before the DOM update this same tick triggered.
watch(
  shown,
  (isShown) => {
    if (isShown) {
      updatePosition();
      if (triggerRef.value && bubbleRef.value) {
        stopAutoUpdate = autoUpdate(triggerRef.value, bubbleRef.value, updatePosition);
      }
      document.addEventListener('keydown', onKeydown);
    } else {
      stopAutoUpdate?.();
      stopAutoUpdate = null;
      document.removeEventListener('keydown', onKeydown);
    }
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  stopAutoUpdate?.();
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <span
    ref="triggerRef"
    class="bs-tooltip-trigger"
    :tabindex="mode === 'describe' ? 0 : undefined"
    :aria-describedby="mode === 'describe' && shown ? tooltipId : undefined"
    @mouseenter="scheduleShow"
    @mouseleave="hide"
    @focusin="showNow"
    @focusout="hide"
  >
    <slot />
  </span>
  <Teleport to="body">
    <span
      v-if="shown"
      :id="mode === 'describe' ? tooltipId : undefined"
      ref="bubbleRef"
      class="bs-tooltip-bubble"
      :style="{ top: `${bubbleY}px`, left: `${bubbleX}px` }"
      :role="mode === 'describe' ? 'tooltip' : undefined"
      :aria-hidden="mode === 'label' ? 'true' : undefined"
    >{{ text }}</span>
  </Teleport>
</template>
