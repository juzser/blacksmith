// The one shared read of /api/active-scope: what the operator's live CLI
// sessions are driving. State and the watcher are module-level on purpose, so
// however many components call useActiveScope() there is one ref and one fetch
// per shell pulse (usePulse bumps `pulseTick` after each successful poll).
// Nothing mounts a poll of its own.
import { effectScope, readonly, ref, watch } from 'vue';
import { type ActiveScopeResult, fetchActiveScope } from '../lib/api.js';
import { pulseTick } from './usePulse.js';

const scope = ref<ActiveScopeResult | null>(null);
// True once the first read has settled, answer or failure: a caller that must
// tell "still loading" (scope null, settled false) from "the read failed"
// (scope null, settled true) reads it.
const settled = ref(false);
let started = false;
let current: Promise<void> | null = null;
// A reload() asked for while a read was running: that read may predate the
// change the caller wants to see, so one more read runs when it ends.
let rereadAfter: Promise<void> | null = null;

function load(): Promise<void> {
  if (current) return current;
  const run = (async () => {
    try {
      scope.value = await fetchActiveScope();
    } catch {
      // Keep the last answer: a failed read is the pulse pill's story to tell.
    } finally {
      current = null;
      settled.value = true;
    }
  })();
  current = run;
  return run;
}

// Re-read the scope once now. Callers during one in-flight read share the one
// follow-up read; the promise settles when it has.
function reload(): Promise<void> {
  if (!current) return load();
  rereadAfter ??= current.then(() => {
    rereadAfter = null;
    return load();
  });
  return rereadAfter;
}

export function useActiveScope() {
  if (!started) {
    started = true;
    // Detached scope: the first caller's component must not own the watcher,
    // or it stops when that component unmounts and the scope never refreshes.
    effectScope(true).run(() => watch(pulseTick, () => void load()));
    void load();
  }
  return { scope, settled: readonly(settled), reload };
}
