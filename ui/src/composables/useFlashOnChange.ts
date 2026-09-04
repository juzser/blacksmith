// "Did anything just change?" — a boolean that is true for a moment after a
// watched signature moves, and false the rest of the time.
//
// Operator directive (Phase 6b round 9): "updates and blocks need more motion,
// so you can actually see the factory running." The Overview polls every 5s,
// but a poll
// that returns new data looked exactly like a poll that returned the same
// data: numbers swapped in place, silently. This is the missing half — the
// arrival of new data becomes visible for ~1s, then gets out of the way.
//
// It is deliberately driven by a *signature of the data*, not by the fetch:
// a successful poll that changed nothing must not flash, or the flash stops
// meaning anything and becomes a 5s metronome.
import { getCurrentScope, onScopeDispose, ref, watch } from 'vue';

export function useFlashOnChange(source: () => string, durationMs = 900) {
  const flashing = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  const stopWatch = watch(source, () => {
    // Restart rather than stack: two changes 200ms apart should leave one
    // flash that ends `durationMs` after the *second* one, not an earlier
    // timer firing mid-flash and cutting it short.
    clear();
    flashing.value = true;
    timer = setTimeout(() => {
      flashing.value = false;
      timer = null;
    }, durationMs);
  });

  function stop() {
    stopWatch();
    clear();
    flashing.value = false;
  }

  // Guarded because this is also constructed outside a component in its unit
  // test; onScopeDispose warns (and does nothing) with no active scope.
  if (getCurrentScope()) onScopeDispose(stop);

  return { flashing, stop };
}
