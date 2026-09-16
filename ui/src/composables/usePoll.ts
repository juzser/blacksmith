// Three triggers, per design-spec.md §8 as amended by that file's 2026-09-15
// addendum: the change stream (`/api/stream`, the usual one), the Toolbar's
// "Refresh" button, and an interval that pauses via the Page Visibility API
// when the tab is hidden. The interval is the documented FALLBACK — it runs
// whenever the stream is not confirmed open, at exactly §8's intervals, so a
// client with no EventSource behaves as §8 originally specified.
//
// `heartbeat` callers keep their interval no matter what the stream says; see
// lib/eventStream.ts's shouldRunInterval for why liveness is not a question a
// silent stream can answer. usePulse.ts is the only one.
//
// Still no WebSockets, and the addendum says why a stream is not one.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useEventStream } from './useEventStream';

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

export interface PollOptions {
  /**
   * Keep the interval running even while the change stream is open. For a
   * poll whose subject is the server's own liveness rather than the data —
   * one caller, composables/usePulse.ts.
   */
  heartbeat?: boolean;
}

export function usePoll(
  callback: () => void | Promise<void>,
  intervalMs: number,
  options: PollOptions = {},
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const heartbeat = options.heartbeat ?? false;
  const { advanceSignal, needsInterval } = useEventStream();

  function start() {
    stop();
    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      // The stream carries the page while it is open, so the interval stands
      // down rather than being cleared. Keeping the timer alive is what makes
      // a dropped stream cost nothing to recover from: EventSource reconnects
      // on its own, needsInterval() flips back to true in between, and the
      // next tick is already scheduled.
      if (!needsInterval(heartbeat)) return;
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

  // The stream's trigger. Same visibility rule as the interval: a hidden tab
  // does no work, and handleVisibility() fires once on return, so nothing
  // heard while hidden is lost — it is collapsed into that one refetch.
  watch(advanceSignal, () => {
    if (typeof document !== 'undefined' && document.hidden) return;
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
