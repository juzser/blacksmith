/** Shared Left/Right/Home/End roving-tabindex key math for a tab row
 * (WAI-ARIA Tabs pattern). Fix brief round 5 item 3: kit/Tabs.vue and
 * ActivityPage.vue's phone kind filter used to hand-roll the same switch
 * twice. Pure: it only answers "which id is next", or null when the key
 * isn't one it handles or the current id isn't in the list — selecting
 * that id and moving focus to it stays each caller's own job, since the
 * two callers build their DOM ids differently (`tab-${id}` vs
 * `activity-kind-tab-${id}`). The event parameter only needs `key` and
 * `preventDefault`, not a real KeyboardEvent, so this stays test-friendly
 * under a DOM-less unit test environment.
 */
export interface RovingTabKeyEvent {
  key: string;
  preventDefault(): void;
}

export function nextRovingTabId(
  event: RovingTabKeyEvent,
  ids: string[],
  currentId: string,
): string | null {
  const idx = ids.indexOf(currentId);
  if (idx === -1) return null;
  let next = idx;
  if (event.key === 'ArrowRight') next = (idx + 1) % ids.length;
  else if (event.key === 'ArrowLeft') next = (idx - 1 + ids.length) % ids.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = ids.length - 1;
  else return null;
  event.preventDefault();
  return ids[next] ?? null;
}
