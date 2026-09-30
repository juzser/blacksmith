// Where `/` and the retired `/projects` land (ds-spec.md §4.1: Home is
// Overview + Projects merged). Kept out of router.ts because that module
// calls createWebHistory() at import time, which the DOM-free unit suite
// cannot run.
import type { LocationQuery, RouteLocationRaw } from 'vue-router';

export function homeRedirect(to: { query: LocationQuery }): RouteLocationRaw {
  const { project, ...query } = to.query;
  if (typeof project === 'string' && project.length > 0) {
    return { name: 'overview-project', params: { project }, query };
  }
  return { name: 'overview-global', query };
}
