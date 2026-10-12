// The app shell's own poll: "is the factory still moving?"
//
// Liveness used to be an Overview fact. Every page polls its own data, and on
// the other nine a frozen server was indistinguishable from a quiet factory —
// which is precisely the confusion lib/liveness.ts was written to end, on the
// one page that had it. Hoisting the pill into the frame ends it everywhere.
//
// The transport is usePoll's, whatever usePoll's is: since design-spec.md's
// 2026-09-15 addendum to §8 that is the change stream, with this file's 5s
// interval behind it. /api/pulse is still column-projected and never reads an
// event body, so it costs a row count, not a log read.
//
// With one exemption, and it is this composable's whole reason for existing:
// the interval here runs whether or not the stream is open (`heartbeat`). The
// stream reports change, and every other poller is right to stand down when a
// live one is reporting none. This poll's question is not "did anything
// change" but "is the server answering", and silence is the ambiguity it was
// hoisted into the frame to resolve — a frozen server and a quiet factory
// send the same nothing. So the pill keeps asking, every five seconds, and
// `lastUpdatedAt` keeps meaning what load()'s catch says it means.
//
// The state is module-level on purpose: the topbar's pill and the shell-level
// readers that follow `pulseTick` are readings of one poll, and two polls
// could disagree about which is more recent. `usePulse` is therefore mounted
// exactly once, by App.vue; a second call site would start a second interval.

import type { MaybeRefOrGetter } from 'vue';
import { computed, onMounted, ref, toValue, watch } from 'vue';
import type { PulseResult } from '../lib/api.js';
import { fetchPulse } from '../lib/api.js';
import { triggerGlobalRefresh, usePoll } from './usePoll.js';

/** Matches Home's own interval — the shell should not read staler. */
export const PULSE_POLL_MS = 5000;

/** Bumped after every successful poll: what shell-level readers (useActiveScope) follow. */
export const pulseTick = ref(0);

const state = ref<PulseResult | null>(null);
const lastUpdatedAt = ref<string | null>(null);

async function load(project: string | undefined): Promise<void> {
  try {
    const next = await fetchPulse(undefined, project);
    state.value = next;
    lastUpdatedAt.value = new Date().toISOString();
    pulseTick.value += 1;
  } catch {
    // Deliberately leaves `lastUpdatedAt` alone. Its whole job is to let a
    // failed poll show up as age: stamping it here would make a dead server
    // read as "Live · updated just now", which is the exact lie the pill
    // exists to prevent.
  }
}

export function usePulse(project: MaybeRefOrGetter<string | undefined>) {
  usePoll(() => load(toValue(project)), PULSE_POLL_MS, { heartbeat: true });
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

  return {
    pulse: computed(() => state.value),
    lastUpdatedAt,
    // Not a private reload: the shell's Refresh sits above whatever page is
    // mounted, so it wakes every poller — this one included, since usePulse
    // polls through usePoll like everything else.
    refresh: triggerGlobalRefresh,
  };
}
