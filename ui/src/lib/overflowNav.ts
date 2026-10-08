import type { RouteLocationNormalized } from 'vue-router';

/**
 * Whether a finished navigation should close an open overflow menu.
 *
 * The router's first navigation (START_LOCATION to the landing page, with a
 * lazy route chunk to load on a cold start) is not the user going anywhere:
 * it can resolve after the user has already opened the menu, and closing on
 * it makes the menu vanish under their finger. A start location matches no
 * route record, which is what tells it apart.
 */
export function navigationClosesOverflow(
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
  failure?: unknown,
): boolean {
  if (failure) return false;
  if (from.matched.length === 0) return false;
  return to.fullPath !== from.fullPath;
}
