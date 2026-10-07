// The one shared read of /api/active-scope: what the operator's live CLI
// sessions are driving. State and the watcher are module-level on purpose, so
// however many components call useActiveScope() there is one ref and one fetch
// per shell pulse (usePulse bumps `pulseTick` after each successful poll).
// Nothing mounts a poll of its own.
import { effectScope, ref, watch } from 'vue';
import { type ActiveScopeResult, fetchActiveScope } from '../lib/api.js';
import { pulseTick } from './usePulse.js';

const scope = ref<ActiveScopeResult | null>(null);
let started = false;
let inFlight = false;

async function load(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    scope.value = await fetchActiveScope();
  } catch {
    // Keep the last answer: a failed read is the pulse pill's story to tell.
  } finally {
    inFlight = false;
  }
}

export function useActiveScope() {
  if (!started) {
    started = true;
    // Detached scope: the first caller's component must not own the watcher,
    // or it stops when that component unmounts and the scope never refreshes.
    effectScope(true).run(() => watch(pulseTick, () => void load()));
    void load();
  }
  return { scope };
}
