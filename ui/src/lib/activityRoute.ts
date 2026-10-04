// Where the retired `/timeline` and `/errors` routes land (DS6 PR3, scope
// item 1). Kept out of router.ts, same reason as homeRoute.ts: router.ts
// calls createWebHistory() at import time, which the DOM-free unit suite
// cannot run.
import type { LocationQuery, RouteLocationRaw } from 'vue-router';

export function timelineRedirect(to: { query: LocationQuery }): RouteLocationRaw {
  return { path: '/activity', query: to.query };
}

/** The old Errors page becomes the Errors kind filter on Activity (brief's
 * "Errors keeps its own chip" decision) — any existing `kind` in the query
 * is overwritten, since a link into `/errors` always meant "errors only". */
export function errorsRedirect(to: { query: LocationQuery }): RouteLocationRaw {
  return { path: '/activity', query: { ...to.query, kind: 'errors' } };
}
