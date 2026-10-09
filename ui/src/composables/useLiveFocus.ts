// The one shared read of /api/cli-sessions for the board pages: what the
// operator's live CLI sessions work on and do next. State is module-level, so
// however many components call useLiveFocus() there is one ref and one
// in-flight request; each caller only adds its own poll tick. When the last
// caller unmounts the sessions are dropped, so a page opened later never
// shows marks from before it was away.
import { onBeforeUnmount, readonly, ref } from 'vue';
import { fetchCliSessions } from '../lib/api.js';
import { afterRead } from '../lib/liveFocus.js';
import type { LiveCard } from '../lib/liveSessions.js';
import { usePoll } from './usePoll.js';

/** null = unknown: nothing read yet, or the reads are failing. */
const sessions = ref<LiveCard[] | null>(null);
let users = 0;
let misses = 0;
let current: Promise<void> | null = null;

function load(): Promise<void> {
  if (current) return current;
  const run = (async () => {
    let read: LiveCard[] | 'failed';
    try {
      const r = await fetchCliSessions();
      read = r.state === 'ok' ? r.sessions : [];
    } catch {
      read = 'failed';
    }
    const next = afterRead(sessions.value, misses, read);
    sessions.value = next.sessions;
    misses = next.misses;
    current = null;
  })();
  current = run;
  return run;
}

export function useLiveFocus(intervalMs = 15000) {
  users += 1;
  usePoll(load, intervalMs);
  void load();
  onBeforeUnmount(() => {
    users -= 1;
    if (users === 0) {
      sessions.value = null;
      misses = 0;
    }
  });
  return { sessions: readonly(sessions) };
}
