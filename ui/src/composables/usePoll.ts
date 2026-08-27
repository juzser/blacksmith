// Polling per design-spec.md §8: an interval that pauses via the Page
// Visibility API when the tab is hidden, plus a manual trigger for the
// Toolbar's "Refresh" button. No WebSockets — see §8's reasoning.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

/**
 * One shared "the operator asked for fresh data" tick.
 *
 * The freshness indicator moved from the Overview page into the app shell
 * (composables/usePulse.ts), and its Refresh button moved with it — but the
 * shell has no idea what the page under it fetches. Rather than teach it, the
 * button bumps this counter and every mounted poller re-runs its own callback.
 * A page therefore keeps ownership of its data and still answers a Refresh it
 * never had to know about.
 *
 * The watcher is registered inside usePoll's setup call, so Vue's effect scope
 * disposes it with the component; an unmounted page cannot be woken by it.
 */
const refreshSignal = ref(0);

export function triggerGlobalRefresh(): void {
  refreshSignal.value += 1;
}

export function usePoll(callback: () => void | Promise<void>, intervalMs: number) {
  let timer: ReturnType<typeof setInterval> | undefined;

  function start() {
    stop();
    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void callback();
    }, intervalMs);
  }

  function stop() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function handleVisibility() {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      stop();
      return;
    }
    // Fire once immediately on return, then resume the interval. Without
    // this, coming back to a tab that was hidden for an hour showed hour-old
    // data for a further `intervalMs` with nothing saying so — which is
    // exactly the failure the Overview's liveness indicator (lib/liveness.ts)
    // exists to expose. Better to close the window than to label it.
    void callback();
    start();
  }

  watch(refreshSignal, () => {
    void callback();
  });

  onMounted(() => {
    start();
    document.addEventListener('visibilitychange', handleVisibility);
  });
  onBeforeUnmount(() => {
    stop();
    document.removeEventListener('visibilitychange', handleVisibility);
  });

  return { refresh: () => void callback() };
}
