// Shared breadcrumb state (design-spec.md §2's useBreadcrumb() composable):
// each page sets its own crumb trail on mount; the topbar renders whatever
// is current. Module-level singleton — one topbar, one breadcrumb slot.
import { ref } from 'vue';

export interface Crumb {
  label: string;
  to?: string;
}

const crumbs = ref<Crumb[]>([{ label: 'Overview' }]);

export function useBreadcrumb() {
  function setBreadcrumb(next: Crumb[]) {
    crumbs.value = next;
  }
  return { crumbs, setBreadcrumb };
}
