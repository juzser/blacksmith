import { createRouter, createWebHistory } from 'vue-router';

// Routes per design-spec.md §2 + Phase 6b's multi-project hub addendum:
// `/` redirects to `/projects` (the new app default route); `/overview` is
// "global mode" (aggregated across projects); `/p/:project/overview`
// scopes the same page to one project. Every other page keeps its 6a path
// and additionally accepts a `?project=` query param via the topbar
// switcher (useProjectContext.ts).
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/projects' },
    { path: '/projects', name: 'projects', component: () => import('./pages/ProjectsPage.vue') },
    {
      path: '/overview',
      name: 'overview-global',
      component: () => import('./pages/OverviewPage.vue'),
    },
    {
      path: '/p/:project/overview',
      name: 'overview-project',
      component: () => import('./pages/OverviewPage.vue'),
      props: true,
    },
    { path: '/sessions', name: 'sessions', component: () => import('./pages/SessionsPage.vue') },
    { path: '/timeline', name: 'timeline', component: () => import('./pages/TimelinePage.vue') },
    { path: '/kanban', name: 'kanban', component: () => import('./pages/KanbanPage.vue') },
    { path: '/roadmap', name: 'roadmap', component: () => import('./pages/RoadmapPage.vue') },
    { path: '/flow', name: 'flow', component: () => import('./pages/FlowPage.vue') },
    { path: '/lessons', name: 'lessons', component: () => import('./pages/LessonsPage.vue') },
    { path: '/errors', name: 'errors', component: () => import('./pages/ErrorsPage.vue') },
    { path: '/analytics', name: 'analytics', component: () => import('./pages/AnalyticsPage.vue') },
    {
      path: '/tasks/:taskId',
      name: 'task-detail',
      component: () => import('./pages/TaskDetailPage.vue'),
      props: true,
    },
  ],
});

export default router;
