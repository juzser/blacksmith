import { Activity, Coins, House, Kanban, Lightbulb } from '@lucide/vue';
import type { NavItem } from './components/kit/types.js';

// The app shell's SidebarNav / MobileTabBar item list (ds-spec.md §3, §5
// "DS1"). DS1 keeps every old route working — these 5 entries point at
// EXISTING pages; old pages are unchanged, only the shell around them is new.
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: House, route: '/overview' },
  { id: 'work', label: 'Work', icon: Kanban, route: '/kanban' },
  { id: 'activity', label: 'Activity', icon: Activity, route: '/timeline' },
  { id: 'cost-quality', label: 'Cost & quality', shortLabel: 'Cost', icon: Coins, route: '/analytics' },
  { id: 'lessons', label: 'Lessons', icon: Lightbulb, route: '/lessons' },
];
