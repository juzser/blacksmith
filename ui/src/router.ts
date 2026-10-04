import type { RouteLocationNormalizedLoaded, RouteRecordRaw } from 'vue-router';
import { createRouter, createWebHistory } from 'vue-router';
import type { Crumb } from './composables/useBreadcrumb.js';
import { errorsRedirect, timelineRedirect } from './lib/activityRoute.js';
import { homeRedirect } from './lib/homeRoute.js';
import { legacyWorkRedirect } from './lib/workView.js';

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
  { path: '/timeline', redirect: timelineRedirect },
  {
    path: '/activity',
    name: 'timeline',
    component: () => import('./pages/ActivityPage.vue'),
    meta: { crumb: () => [{ label: 'Activity' }] },
  },
  {
    // Work: a Kanban/Roadmap switch, not two unrelated
    // pages. /work/kanban and /work/roadmap are child routes so WorkPage.vue
    // can own the shared header/SegmentedControl above `<router-view>`; the
    // crumb/title read "Work" on both (operator decision, not a per-view
    // label). `/kanban` and `/roadmap` below redirect here, query kept.
    path: '/work',
    component: () => import('./pages/WorkPage.vue'),
    children: [
      { path: '', redirect: '/work/kanban' },
      {
        path: 'kanban',
        name: 'work-kanban',
        component: () => import('./pages/KanbanPage.vue'),
        meta: { crumb: () => [{ label: 'Work' }] },
      },
      {
        path: 'roadmap',
        name: 'work-roadmap',
        component: () => import('./pages/RoadmapPage.vue'),
        meta: { crumb: () => [{ label: 'Work' }] },
      },
    ],
  },
  { path: '/kanban', redirect: legacyWorkRedirect('/work/kanban') },
  { path: '/roadmap', redirect: legacyWorkRedirect('/work/roadmap') },
  // DS4 S3 §4: /flow is retired — the epic filter is now the Roadmap's own
  // `?epic=` selection. `legacyWorkRedirect` already carries the full query
  // string, so `/flow?epic=X` lands on `/work/roadmap?epic=X`.
  { path: '/flow', redirect: legacyWorkRedirect('/work/roadmap') },
  {
    path: '/lessons',
    name: 'lessons',
    component: () => import('./pages/LessonsPage.vue'),
    meta: { crumb: () => [{ label: 'Lessons' }] },
  },
  { path: '/errors', redirect: errorsRedirect },
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
      crumb: (r) => [{ label: 'Work', to: '/work/kanban' }, { label: String(r.params.taskId) }],
    },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
