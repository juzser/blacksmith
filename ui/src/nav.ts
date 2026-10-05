import { Activity, Coins, History, House, Kanban, Lightbulb } from '@lucide/vue';
import type { NavItem } from './components/kit/types.js';

// The app shell's SidebarNav / MobileTabBar item list (ds-spec.md §3, §5
// "DS1"). Home is HomePage at `/overview` (DS2, §4.1); `/` and `/projects`
// redirect there (router.ts). The other entries still point at the old
// pages until their own DS replaces them.
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: House, route: '/overview' },
  {
    id: 'work',
    label: 'Work',
    icon: Kanban,
    route: '/work/kanban',
    matchPrefix: '/work',
    // Operator decision 2026-10-05: Work gets two always-visible level-2
    // items on desktop (ds-spec.md §3) -- MobileTabBar never reads
    // `children`, so the phone stays a single flat "Work" tab.
    children: [
      { id: 'work-kanban', label: 'Kanban', route: '/work/kanban' },
      { id: 'work-roadmap', label: 'Roadmap', route: '/work/roadmap' },
    ],
  },
  { id: 'activity', label: 'Activity', icon: Activity, route: '/activity' },
  // Sessions (DS8 PR3 item 5): right after Activity, the other place that
  // shows a run in progress - History reads as "past runs" the same way
  // Activity's icon reads as "happening now".
  { id: 'sessions', label: 'Sessions', icon: History, route: '/sessions' },
  {
    id: 'cost-quality',
    label: 'Cost & quality',
    shortLabel: 'Cost',
    icon: Coins,
    route: '/analytics',
  },
  { id: 'lessons', label: 'Lessons', icon: Lightbulb, route: '/lessons' },
];

// A parent with level-2 `children` has no page of its own to land on --
// clicking it should go straight to the first child's page (operator
// decision 2026-10-05), derived here rather than duplicated at every call
// site so Work's `route` and `children[0].route` cannot drift apart.
export function navRoute(item: NavItem): string {
  const firstChild = item.children?.[0];
  return firstChild ? firstChild.route : item.route;
}
