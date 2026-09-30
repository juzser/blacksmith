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
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
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

// S2-1: a wrapper tabindex + wrapper aria-describedby is only correct when
// the slot has nothing of its own to focus (plain truncated text). When the
// slot already wraps a focusable element (a link, a button), that element is
// the real trigger — giving the wrapper its own tabindex too would add a
// second, redundant tab stop, and aria-describedby belongs on the element a
// screen reader user actually lands on. Resolved once against the real DOM
// (querySelector, not something a `<script setup>` template ref can express
// for arbitrary slot content) since this is describe-mode's only job.
const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const describeTargetEl = ref<HTMLElement | null>(null);
const wrapperTabindex = ref<0 | undefined>(undefined);

function resolveDescribeTarget() {
  if (props.mode !== 'describe' || !triggerRef.value) {
    describeTargetEl.value = null;
    wrapperTabindex.value = undefined;
    return;
  }
  describeTargetEl.value = triggerRef.value.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  wrapperTabindex.value = describeTargetEl.value ? undefined : 0;
}

onMounted(resolveDescribeTarget);
watch(() => props.mode, resolveDescribeTarget);

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

// S3-1: only a keyboard-focus-visible target opens the tooltip. `focusin`
// alone also fires on *programmatic* focus — e.g. useModalFocus.ts moving
// focus to a Dialog's close button when it opens — and that isn't a user
// asking to see a tooltip. `:focus-visible` is the platform's own heuristic
// for "this focus should show a focus ring"; programmatic .focus() calls
// don't match it, which is exactly the distinction this needs.
function onFocusIn(event: FocusEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.matches?.(':focus-visible')) showNow();
}

// Esc "dismisses it without moving focus" (§2.5) even when the tooltip was
// opened by hover, where keyboard focus may be elsewhere entirely — a
// document-level listener catches that case; hide() never touches focus.
//
// S3-1: registered on the *capture* phase, not bubble. Dialog's own Esc
// handler (useModalFocus.ts) is a bubble-phase `document` listener added
// when the dialog opens — before this tooltip's listener can even exist, so
// a bubble-phase listener here would always lose that race and Dialog would
// already be closing by the time this ran. Capture-phase listeners on
// `document` fire on the way down, ahead of any bubble-phase listener on the
// same node regardless of add order, so stopPropagation() here genuinely
// stops the keydown from ever reaching Dialog's handler.
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  hide();
  event.stopPropagation();
}

// flush: 'post' so bubbleRef is the just-rendered <span v-if="shown"> element,
// not still null from before the DOM update this same tick triggered.
watch(
  shown,
  (isShown) => {
    const describedEl = describeTargetEl.value ?? triggerRef.value;
    if (isShown) {
      updatePosition();
      if (triggerRef.value && bubbleRef.value) {
        stopAutoUpdate = autoUpdate(triggerRef.value, bubbleRef.value, updatePosition);
      }
      document.addEventListener('keydown', onKeydown, true);
      if (props.mode === 'describe') describedEl?.setAttribute('aria-describedby', tooltipId);
    } else {
      stopAutoUpdate?.();
      stopAutoUpdate = null;
      document.removeEventListener('keydown', onKeydown, true);
      if (props.mode === 'describe') describedEl?.removeAttribute('aria-describedby');
    }
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  stopAutoUpdate?.();
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <span
    ref="triggerRef"
    class="bs-tooltip-trigger"
    :tabindex="wrapperTabindex"
    @mouseenter="scheduleShow"
    @mouseleave="hide"
    @focusin="onFocusIn"
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
