// The app shell's own poll: "is the factory still moving, and what has
// arrived since I looked?"
//
// Liveness used to be an Overview fact. Every page polls its own data, and on
// the other nine a frozen server was indistinguishable from a quiet factory —
// which is precisely the confusion lib/liveness.ts was written to end, on the
// one page that had it. Hoisting the pill into the frame ends it everywhere,
// and the same payload feeds the sidebar's arrival badges (lib/navBadges.ts).
//
// Nothing changes about the transport: design-spec.md §8 ("No WebSockets")
// still holds. This is the same polling contract, asked once for the frame
// instead of once more per page — /api/pulse is column-projected and never
// reads an event body, so it costs a row count, not a log read.
//
// The state is module-level on purpose: the topbar's pill and the sidebar's
// badges are two readings of one poll, and two polls could disagree about
// which is more recent. `usePulse` is therefore mounted exactly once, by
// App.vue; a second call site would start a second interval.

import type { MaybeRefOrGetter } from 'vue';
import { computed, onMounted, ref, toValue, watch } from 'vue';
import { fetchPulse } from '../lib/api.js';
import type { PulseState } from '../lib/navBadges.js';
import { applyNav, applyPulse, EMPTY_PULSE_STATE, navBadges } from '../lib/navBadges.js';
import { triggerGlobalRefresh, usePoll } from './usePoll.js';

/** Matches OverviewPage's own interval — the shell should not read staler. */
export const PULSE_POLL_MS = 5000;

const state = ref<PulseState>(EMPTY_PULSE_STATE);
const lastUpdatedAt = ref<string | null>(null);
/** The nav item currently on screen, which by definition has nothing unread. */
const currentNavId = ref<string | undefined>(undefined);

async function load(project: string | undefined): Promise<void> {
  try {
    const next = await fetchPulse(undefined, project);
    state.value = applyPulse(state.value, next, project ?? '', currentNavId.value);
    lastUpdatedAt.value = new Date().toISOString();
  } catch {
    // Deliberately leaves `lastUpdatedAt` alone. Its whole job is to let a
    // failed poll show up as age: stamping it here would make a dead server
    // read as "Live · updated just now", which is the exact lie the pill
    // exists to prevent.
  }
}

export function usePulse(project: MaybeRefOrGetter<string | undefined>) {
  const badges = computed(() => navBadges(state.value.pulse, state.value.seen));

  usePoll(() => load(toValue(project)), PULSE_POLL_MS);
  // usePoll's interval does not fire until one interval has elapsed, and the
  // shell must not spend its first five seconds saying "Connecting…".
  onMounted(() => {
    void load(toValue(project));
  });
  watch(
    () => toValue(project),
    (next) => {
      void load(next);
    },
  );

  /** The operator navigated: that page's badge clears and counts again from here. */
  function seePage(navId: string | undefined): void {
    currentNavId.value = navId;
    state.value = applyNav(state.value, navId);
  }

  return {
    pulse: computed(() => state.value.pulse),
    lastUpdatedAt,
    badges,
    seePage,
    // Not a private reload: the shell's Refresh sits above whatever page is
    // mounted, so it wakes every poller — this one included, since usePulse
    // polls through usePoll like everything else.
    refresh: triggerGlobalRefresh,
  };
}
