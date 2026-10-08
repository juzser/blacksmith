import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { navigationClosesOverflow } from '../src/lib/overflowNav.js';

const Stub = { render: () => null };

function makeRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/work/kanban' },
      { path: '/work/kanban', component: Stub },
      { path: '/work/roadmap', component: Stub },
    ],
  });
  const closes: boolean[] = [];
  router.afterEach((to, from, failure) => {
    closes.push(navigationClosesOverflow(to, from, failure));
  });
  return { router, closes };
}

describe('navigationClosesOverflow', () => {
  it('does not close on the first navigation of a cold start', async () => {
    const { router, closes } = makeRouter();
    await router.push('/');
    expect(closes).toEqual([false]);
  });

  it('closes when the user then navigates somewhere else', async () => {
    const { router, closes } = makeRouter();
    await router.push('/work/kanban');
    await router.push('/work/roadmap');
    expect(closes).toEqual([false, true]);
  });

  it('does not close on a failed or duplicated navigation', async () => {
    const { router, closes } = makeRouter();
    await router.push('/work/kanban');
    await router.push('/work/kanban');
    expect(closes).toEqual([false, false]);
  });

  it('does not close when a navigation to a different path is aborted', async () => {
    const { router, closes } = makeRouter();
    router.beforeEach((to) => (to.path === '/work/roadmap' ? false : true));
    await router.push('/work/kanban');
    await router.push('/work/roadmap');
    expect(closes).toEqual([false, false]);
  });
});
