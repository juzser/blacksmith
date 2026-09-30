// Tooltip's open/close state machine (ds-spec.md §2.5): opens after 300ms of
// hover, immediately on keyboard focus, closes on mouseleave/blur/Escape, and
// keeps only one tooltip open at a time. Kept free of the DOM so it unit
// tests the way useFlashOnChange.ts does — it owns a timer too.
//
// Floating-ui positioning (offset/flip/shift/autoUpdate) and the actual
// hover/focus/keydown listeners are Tooltip.vue's job: this composable only
// tracks whether the bubble is shown.
import { getCurrentScope, onScopeDispose, ref } from 'vue';

const HOVER_DELAY_MS = 300;

// "Only one open at a time" (§2.5) — a module-level singleton, the same
// shape useToast.ts uses for its one-region-per-app queue. Holds the hide()
// of whichever tooltip is currently open, so a second one showing closes it.
let activeHide: (() => void) | null = null;

export function useTooltip() {
  const shown = ref(false);
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHoverTimer() {
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function open() {
    if (activeHide && activeHide !== hide) activeHide();
    activeHide = hide;
    shown.value = true;
  }

  /** mouseleave, blur and Escape all funnel here — closing an already-closed or never-opened tooltip is a no-op. */
  function hide() {
    clearHoverTimer();
    if (activeHide === hide) activeHide = null;
    shown.value = false;
  }

  /** Hover: waits HOVER_DELAY_MS. Leaving before it fires (mouseleave -> hide()) cancels it, never having opened. */
  function scheduleShow() {
    clearHoverTimer();
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      open();
    }, HOVER_DELAY_MS);
  }

  /** Keyboard focus: no delay. */
  function showNow() {
    clearHoverTimer();
    open();
  }

  // Guarded the same way useFlashOnChange.ts is: this composable is also
  // constructed outside a component in its unit test.
  if (getCurrentScope()) {
    onScopeDispose(() => {
      clearHoverTimer();
      if (activeHide === hide) activeHide = null;
    });
  }

  return { shown, scheduleShow, showNow, hide };
}
