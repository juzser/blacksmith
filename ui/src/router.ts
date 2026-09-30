import type { RouteLocationNormalizedLoaded, RouteRecordRaw } from 'vue-router';
import { createRouter, createWebHistory } from 'vue-router';
import type { Crumb } from './composables/useBreadcrumb.js';
import { homeRedirect } from './lib/homeRoute.js';

// Routes: Home (ds-spec.md §4.1, Overview + Projects merged) renders at
// `/overview` in global mode and at `/p/:project/overview` scoped to one
// project; `/` and the retired `/projects` redirect there through
// homeRedirect, keeping the deep-link query and turning `?project=` into the
// project route. Every other page keeps its path and accepts a `?project=`
// query param via the topbar switcher (useProjectContext.ts).
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
  { path: '/', redirect: homeRedirect },
  { path: '/projects', redirect: homeRedirect },
  {
    path: '/overview',
    name: 'overview-global',
    component: () => import('./pages/HomePage.vue'),
    meta: { crumb: () => [{ label: 'Home' }] },
  },
  {
    path: '/p/:project/overview',
    name: 'overview-project',
    component: () => import('./pages/HomePage.vue'),
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
