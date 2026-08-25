import type { NavItem } from './components/hds/types.js';

// design-spec.md §2's SidebarNav item array, 2 groups + Phase 6b's Projects
// hub / Flow additions. All pages ship this phase — nothing disabled.
export const NAV_ITEMS: (NavItem & { route?: string })[] = [
  { category: 'Monitor' },
  { id: 'projects', label: 'Projects', icon: 'layers', route: '/projects' },
  { id: 'overview', label: 'Overview', icon: 'layout-dashboard', route: '/overview' },
  // Sessions sits under Monitor and directly after Overview because it reads
  // the SAME /api/overview payload — it is the "Now running" card as a canvas.
  // Filed under Work would imply it shows planned work; it only ever shows
  // what is running at this second.
  { id: 'sessions', label: 'Sessions', icon: 'play', route: '/sessions' },
  { id: 'timeline', label: 'Timeline', icon: 'history', route: '/timeline' },
  { id: 'errors', label: 'Errors', icon: 'triangle-alert', route: '/errors' },
  { id: 'analytics', label: 'Analytics', icon: 'bar-chart-3', route: '/analytics' },
  { category: 'Work' },
  { id: 'kanban', label: 'Kanban', icon: 'kanban', route: '/kanban' },
  { id: 'roadmap', label: 'Roadmap', icon: 'map', route: '/roadmap' },
  { id: 'flow', label: 'Flow', icon: 'git-merge', route: '/flow' },
  { id: 'lessons', label: 'Lessons', icon: 'graduation-cap', route: '/lessons' },
];
