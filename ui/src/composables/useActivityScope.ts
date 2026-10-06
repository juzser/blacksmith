// The Active/All scope, carried in the route query like useSessionContext's
// scope: the route is the single source, `scope` is derived and never
// mirrored into a ref. Rules live in lib/activityScope.ts.
import { computed } from 'vue';
import { type RouteLocationRaw, useRoute, useRouter } from 'vue-router';
import { type ActivityScope, parseActivityScope, scopeQuery } from '../lib/activityScope.js';

export function useActivityScope() {
  const route = useRoute();
  const router = useRouter();

  const scope = computed<ActivityScope>(() => parseActivityScope(route.query.scope));

  /** The link for `next`, keeping the other query keys -- what a toggle renders. */
  function scopeTo(next: ActivityScope): RouteLocationRaw {
    return { query: scopeQuery(route.query, next) } as RouteLocationRaw;
  }

  function setScope(next: ActivityScope): void {
    void router.push(scopeTo(next));
  }

  return { scope, setScope, scopeTo };
}
