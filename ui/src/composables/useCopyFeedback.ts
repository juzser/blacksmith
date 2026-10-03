// "Copy id" -> "Copied" -> back to "Copy id" after a beat, with a timer that
// cannot outlive the component or stack a second firing on a rapid re-click.
//
// DS4 S5c fix round 1, fix 8: EpicBlock.vue's inline setTimeout left the
// timeout id in a bare local, so unmounting mid-flash (or re-arming on a
// fast second click) never cleared it — a leaked timer that could still
// write to a ref after its owner was gone. Modeled on useFlashOnChange.ts,
// the one other composable in this codebase that owns a setTimeout.
import { getCurrentScope, onScopeDispose, ref } from 'vue';

export function useCopyFeedback(idleLabel: string, flashLabel = 'Copied', durationMs = 1500) {
  const label = ref(idleLabel);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flash() {
    clear();
    label.value = flashLabel;
    timer = setTimeout(() => {
      label.value = idleLabel;
      timer = null;
    }, durationMs);
  }

  // Resets the idle label (e.g. the epic id changed) and cancels any pending
  // flash so a stale timer cannot overwrite the new label a moment later.
  function reset(nextIdleLabel: string) {
    clear();
    idleLabel = nextIdleLabel;
    label.value = idleLabel;
  }

  function stop() {
    clear();
  }

  if (getCurrentScope()) onScopeDispose(stop);

  return { label, flash, reset, stop };
}
