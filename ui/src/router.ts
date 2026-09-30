import type { RouteLocationNormalizedLoaded, RouteRecordRaw } from 'vue-router';
import { createRouter, createWebHistory } from 'vue-router';
import type { Crumb } from './composables/useBreadcrumb.js';

// Routes per design-spec.md §2 + Phase 6b's multi-project hub addendum:
// `/` redirects to `/projects` (the new app default route); `/overview` is
// "global mode" (aggregated across projects); `/p/:project/overview`
// scopes the same page to one project. Every other page keeps its 6a path
// and additionally accepts a `?project=` query param via the topbar
// switcher (useProjectContext.ts).
//
// `meta.crumb` (ds-spec.md §3, DS1): the app shell derives the topbar
// Breadcrumb from route meta so it updates the instant navigation happens,
// before any page's own data has arrived. It reads only the route (params/
// query), never a page's fetched payload.
declare module 'vue-router' {
  interface RouteMeta {
    crumb?: (route: RouteLocationNormalizedLoaded) => Crumb[];
  }
}

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/projects' },
  {
    path: '/projects',
    name: 'projects',
    component: () => import('./pages/ProjectsPage.vue'),
    meta: { crumb: () => [{ label: 'Projects' }] },
  },
  {
    path: '/overview',
    name: 'overview-global',
    component: () => import('./pages/OverviewPage.vue'),
    meta: { crumb: () => [{ label: 'Home' }] },
  },
  {
    path: '/p/:project/overview',
    name: 'overview-project',
    component: () => import('./pages/OverviewPage.vue'),
    props: true,
    meta: { crumb: (r) => [{ label: `${r.params.project} · Home` }] },
  },
  {
    path: '/sessions',
    name: 'sessions',
    component: () => import('./pages/SessionsPage.vue'),
    meta: {
      crumb: (r) => [{ label: r.query.project ? `${r.query.project} · Sessions` : 'Sessions' }],
    },
  },
  {
    path: '/timeline',
    name: 'timeline',
    component: () => import('./pages/TimelinePage.vue'),
    meta: { crumb: () => [{ label: 'Activity' }] },
  },
  {
    path: '/kanban',
    name: 'kanban',
    component: () => import('./pages/KanbanPage.vue'),
    meta: { crumb: () => [{ label: 'Work' }] },
  },
  {
    path: '/roadmap',
    name: 'roadmap',
    component: () => import('./pages/RoadmapPage.vue'),
    meta: { crumb: () => [{ label: 'Roadmap' }] },
  },
  {
    path: '/flow',
    name: 'flow',
    component: () => import('./pages/FlowPage.vue'),
    meta: { crumb: () => [{ label: 'Flow' }] },
  },
  {
    path: '/lessons',
    name: 'lessons',
    component: () => import('./pages/LessonsPage.vue'),
    meta: { crumb: () => [{ label: 'Lessons' }] },
  },
  {
    path: '/errors',
    name: 'errors',
    component: () => import('./pages/ErrorsPage.vue'),
    meta: { crumb: () => [{ label: 'Errors' }] },
  },
  {
    path: '/analytics',
    name: 'analytics',
    component: () => import('./pages/AnalyticsPage.vue'),
    meta: { crumb: () => [{ label: 'Cost & quality' }] },
  },
  {
    path: '/tasks/:taskId',
    name: 'task-detail',
    component: () => import('./pages/TaskDetailPage.vue'),
    props: true,
    meta: {
      crumb: (r) => [{ label: 'Work', to: '/kanban' }, { label: String(r.params.taskId) }],
    },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
