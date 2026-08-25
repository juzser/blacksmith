// A shared ticking "now", so every elapsed/relative label on a page counts up
// on its own instead of freezing between data fetches.
//
// Operator directive (Phase 6b round 7): "một dạng real-time update". Overview
// already re-fetched every 5s, but every timestamp on it was formatted against
// `Date.now()` at render time — so a label only moved when the fetch happened
// to change something else on the page, and a page with no changes looked
// frozen. Passing this ref into formatElapsed()/formatRelative() as their
// `nowIso` argument makes the clock, not the data, drive those labels.
//
// It is a clock, not a fetch: the 1s tick re-renders text nodes only, and it
// pauses with the tab (usePoll's Page Visibility handling — design-spec §8).
import { ref } from 'vue';
import { usePoll } from './usePoll.js';

export function useNow(intervalMs = 1000) {
  const now = ref(new Date().toISOString());
  usePoll(() => {
    now.value = new Date().toISOString();
  }, intervalMs);
  return now;
}
