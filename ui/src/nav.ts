import { Activity, Coins, House, Kanban, Lightbulb } from '@lucide/vue';
import type { NavItem } from './components/kit/types.js';

// The app shell's SidebarNav / MobileTabBar item list (ds-spec.md §3, §5
// "DS1"). Home is HomePage at `/overview` (DS2, §4.1); `/` and `/projects`
// redirect there (router.ts). The other entries still point at the old
// pages until their own DS replaces them.
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: House, route: '/overview' },
  { id: 'work', label: 'Work', icon: Kanban, route: '/kanban' },
  { id: 'activity', label: 'Activity', icon: Activity, route: '/timeline' },
  {
    id: 'cost-quality',
    label: 'Cost & quality',
    shortLabel: 'Cost',
    icon: Coins,
    route: '/analytics',
  },
  { id: 'lessons', label: 'Lessons', icon: Lightbulb, route: '/lessons' },
];
