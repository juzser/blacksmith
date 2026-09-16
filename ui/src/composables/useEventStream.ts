// The browser half of the change stream (design-spec.md's 2026-09-15 addendum
// to §8). Thin on purpose: every decision this file makes is delegated to
// lib/eventStream.ts, which ui/vitest.config.ts covers; what is left here is
// EventSource wiring, which is Playwright's job to exercise (ui/e2e).
import { onBeforeUnmount, readonly, ref } from 'vue';
import type { SessionAdvance, StreamState } from '../lib/eventStream';
import { hasNews, parseAdvanced, shouldRunInterval } from '../lib/eventStream';

/**
 * One EventSource for the whole app, module-level for the same reason
 * usePulse.ts's state is: a page mounts several pollers and a route change
 * mounts several more. A connection per poller would be a connection per
 * component, and browsers cap concurrent connections per origin at six.
 *
 * The connection is opened by the first subscriber and closed by the last, so
 * a build that never calls usePoll — or a test that mounts one component —
 * opens nothing.
 */
const state = ref<StreamState>('idle');
const advanceSignal = ref(0);
const seen = new Map<string, number>();
let source: EventSource | null = null;
let subscribers = 0;

function close(): void {
  source?.close();
  source = null;
  seen.clear();
  state.value = 'closed';
}

function open(): void {
  if (source !== null) return;
  // A browser without EventSource, or a non-DOM environment (the SFC contract
  // tests import components in node), leaves state at 'idle' — which
  // shouldRunInterval() reads as "keep polling", the honest answer.
  if (typeof EventSource === 'undefined') return;
  state.value = 'connecting';
  const es = new EventSource('/api/stream');
  source = es;

  // 'ready' and not 'open': the browser fires onopen as soon as it has
  // response headers, which a proxy can produce before this server has
  // written anything. The named frame is the server's own statement that the
  // scan is held and the subscription is live, so it is what flips the page
  // off its interval.
  es.addEventListener('ready', () => {
    state.value = 'open';
  });

  es.addEventListener('advanced', (event) => {
    const advances: SessionAdvance[] = parseAdvanced((event as MessageEvent<string>).data);
    if (!hasNews(advances, seen)) return;
    for (const { session, events } of advances) seen.set(session, events);
    advanceSignal.value += 1;
  });

  es.onerror = () => {
    // EventSource reconnects on its own, so this is not a place to retry —
    // it is a place to stop claiming the stream is carrying the page. The
    // interval fallback resumes the moment this flips, and a successful
    // reconnect sends 'ready' again.
    if (state.value === 'open') state.value = 'connecting';
  };
}

/**
 * Subscribe to the change stream. Returns the signal a caller watches and the
 * state that says whether the caller still needs its own interval.
 *
 * Registered against the calling component's lifecycle: the last component to
 * unmount closes the connection, so a hidden tab that unmounts nothing keeps
 * one connection and a closed tab keeps none.
 */
export function useEventStream() {
  subscribers += 1;
  open();

  onBeforeUnmount(() => {
    subscribers -= 1;
    if (subscribers === 0) close();
  });

  return {
    advanceSignal: readonly(advanceSignal),
    streamState: readonly(state),
    needsInterval: (heartbeat = false) => shouldRunInterval(state.value, heartbeat),
  };
}
