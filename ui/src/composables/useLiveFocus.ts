// The one shared read of /api/cli-sessions for the board pages: what the
// operator's live CLI sessions work on and do next. State is module-level, so
// however many components call useLiveFocus() there is one ref and one
// in-flight request; each caller only adds its own poll tick. When the last
// caller unmounts the sessions are dropped, so a page opened later never
// shows marks from before it was away.
import { onBeforeUnmount, readonly, ref } from 'vue';
import { fetchCliSessions } from '../lib/api.js';
import { afterRead, readOf } from '../lib/liveFocus.js';
import type { LiveCard } from '../lib/liveSessions.js';
import { usePoll } from './usePoll.js';

/** null = unknown: nothing read yet, or the reads are failing. */
const sessions = ref<LiveCard[] | null>(null);
let users = 0;
let failedAt: number | null = null;
let graceMs = 15000;
let current: Promise<void> | null = null;

function load(): Promise<void> {
  if (current) return current;
  const run = (async () => {
    let read: LiveCard[] | 'failed';
    try {
      const r = await fetchCliSessions();
      read = readOf(r);
    } catch {
      read = 'failed';
    }
    current = null;
    // Nobody is listening any more: do not bring marks back for the next page.
    if (users === 0) return;
    const next = afterRead(sessions.value, failedAt, read, Date.now(), graceMs);
    sessions.value = next.sessions;
    failedAt = next.failedAt;
  })();
  current = run;
  return run;
}

export function useLiveFocus(intervalMs = 15000) {
  users += 1;
  graceMs = intervalMs;
  usePoll(load, intervalMs);
  void load();
  onBeforeUnmount(() => {
    users -= 1;
    if (users === 0) {
      sessions.value = null;
      failedAt = null;
    }
  });
  return { sessions: readonly(sessions) };
}
