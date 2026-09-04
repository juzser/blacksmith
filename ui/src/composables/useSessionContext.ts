// D-264's other half: the session scope the topbar picker sets and every
// scopable page reads, carried in the route query so it survives a reload and
// a copied link. Mirrors useProjectContext -- same route-as-the-single-source
// shape, same "derive, never mirror into a ref" rule -- and adds the width
// the project scope has no analogue for.
//
// The rules the scope itself obeys live in lib/sessionScope.ts, which is
// where they have a gate on them; this file is the Vue binding and nothing
// more.
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ALL_SESSIONS,
  readSessionScope,
  type SessionScope,
  scopeWidth,
  sessionScopeKey,
  withScopeWidth,
} from '../lib/sessionScope.js';

export function useSessionContext() {
  const route = useRoute();
  const router = useRouter();

  const sessionScope = computed<SessionScope | undefined>(() => readSessionScope(route.query));

  /** What pages watch. The computed above rebuilds its object on every route
   *  query change, so watching it re-fetches on an unrelated `?project=`
   *  edit; this changes only when the scope means something different. */
  const sessionKey = computed<string>(() => sessionScopeKey(sessionScope.value));

  const width = computed<string>(() => scopeWidth(sessionScope.value));

  function push(next: SessionScope | undefined): void {
    const query = { ...route.query };
    if (next) {
      query.session = next.session;
      if (next.lineage) query.lineage = 'true';
      else delete query.lineage;
    } else {
      delete query.session;
      // A lineage without a session is the pair the server refuses, so
      // clearing the session clears the widening with it rather than leaving
      // a param behind that would 400 the moment a session came back.
      delete query.lineage;
    }
    router.push({ ...route, query });
  }

  /** The picker's handler. Takes the raw <select> value, ALL_SESSIONS
   *  included, and keeps the current width across a change of session. */
  function setSession(next: string): void {
    if (next === ALL_SESSIONS) {
      push(undefined);
      return;
    }
    push(withScopeWidth({ session: next }, width.value));
  }

  /** The width control's handler. A no-op with no session selected, which is
   *  also when App.vue does not render it. */
  function setWidth(next: string): void {
    push(withScopeWidth(sessionScope.value, next));
  }

  return { sessionScope, sessionKey, width, setSession, setWidth };
}
