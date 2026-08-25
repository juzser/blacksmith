// Phase 6b multi-project hub: the current project scope, derived from the
// route (either the /p/:project/overview path param, or a `?project=`
// query param on every other scoped page — Timeline/Kanban/Roadmap/Flow
// per the operator's own routing requirement), plus a setter the topbar's
// project-switcher Select calls.
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

export function useProjectContext() {
  const route = useRoute();
  const router = useRouter();

  const project = computed<string | undefined>(() => {
    const p = route.params.project;
    if (typeof p === 'string' && p.length > 0) return p;
    const q = route.query.project;
    return typeof q === 'string' && q.length > 0 ? q : undefined;
  });

  function setProject(next: string | undefined): void {
    if (route.name === 'overview-global' || route.name === 'overview-project') {
      if (next) router.push({ name: 'overview-project', params: { project: next } });
      else router.push({ name: 'overview-global' });
      return;
    }
    const query = { ...route.query };
    if (next) query.project = next;
    else delete query.project;
    router.push({ ...route, query });
  }

  return { project, setProject };
}
