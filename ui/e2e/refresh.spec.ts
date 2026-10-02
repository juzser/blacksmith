import { expect, test } from './harness.js';

/**
 * design-spec.md §8, verbatim: "**Task detail, Lessons, Errors, Analytics**:
 * **manual refresh only**, no auto-poll -- these are pages the operator is
 * actively reading/deciding on; a table or findings list re-sorting under
 * their cursor mid-read is a worse UX than a slightly stale view with an
 * explicit Refresh button."
 *
 * All four shipped with neither half: no `usePoll`, and no Refresh control
 * either. "Manual refresh only" became "no refresh at all" -- the only way to
 * see a newly raised finding, a graded lesson or a task that has since moved
 * was a full browser reload (D-243).
 *
 * Swept by role name, not by CSS class: what §8 promises the operator is a
 * control they can find and press, so that is what this asserts.
 */
const MANUAL_REFRESH_PAGES = [
  {
    name: 'Task detail',
    path: `/tasks/${encodeURIComponent('epic-9/task-3')}`,
    ready: 'Task detail sections',
    api: '/api/tasks/',
  },
  { name: 'Lessons', path: '/lessons', ready: null, api: '/api/lessons' },
  { name: 'Errors', path: '/errors', ready: null, api: '/api/errors' },
  { name: 'Analytics', path: '/analytics', ready: null, api: '/api/analytics' },
] as const;

test.describe('Manual refresh (design-spec §8)', () => {
  for (const surface of MANUAL_REFRESH_PAGES) {
    test(`${surface.name} offers a Refresh control`, async ({ page }) => {
      await page.goto(surface.path);
      // Data-gated where the page has a landmark to wait on: an <h1> renders
      // before any /api/ response lands, and asserting against a skeleton
      // proves nothing (D-150).
      if (surface.ready) {
        await expect(page.getByRole('tablist', { name: surface.ready })).toBeVisible();
      }
      const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
      await expect(refresh).toBeVisible();

      // Pressing it must actually re-fetch -- a button that only looks like
      // one is the same stale view with more confidence attached.
      const refetched = page.waitForResponse((r) => r.url().includes('/api/'));
      await refresh.click();
      await refetched;
    });
  }

  for (const surface of MANUAL_REFRESH_PAGES) {
    test(`${surface.name} keeps its content on screen while refreshing`, async ({ page }) => {
      // The route is lazy-loaded (router.ts's `component: () => import(...)`),
      // so goto() can resolve, and even surface.ready's landmark can go
      // visible, before the page's own load() has run at all -- the skeleton
      // check below would then pass for having nothing mounted yet rather
      // than for having real content. The page's `loading` gate is
      // `data.value === null` (see e.g. ErrorsPage.vue's load()), so the
      // skeleton this test forbids during refresh is only actually avoidable
      // once the first fetch has landed and data is non-null. Wait for that
      // fetch -- armed before goto() so it cannot be missed -- before
      // touching anything else.
      const initialLoad = page.waitForResponse((r) => r.url().includes(surface.api));
      await page.goto(surface.path);
      await initialLoad;

      if (surface.ready) {
        await expect(page.getByRole('tablist', { name: surface.ready })).toBeVisible();
      }
      await expect(page.locator('.bs-skeleton')).toHaveCount(0);

      // Hold the refetch open so the in-flight state is observable rather
      // than raced (the kanban.spec.ts idiom).
      await page.route('**/api/**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
      });
      // Resolves the moment the refetch is issued, so the read below lands
      // inside load()'s in-flight window instead of racing the click itself
      // (kanban.spec.ts's "a failing refresh..." idiom).
      const inFlight = page.waitForRequest((r) => r.url().includes(surface.api));
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await inFlight;

      // Read synchronously, inside the route's hold. A retrying matcher would
      // go green the moment the refetch lands -- which is precisely the
      // blank-and-restore flash this forbids. §8 asks for manual refresh
      // because a list re-sorting mid-read is bad; replacing the whole page
      // with a skeleton (and, on Task detail, the Refresh button with it) is
      // strictly worse than the re-sort it was meant to avoid.
      expect(await page.locator('.ds-skeleton').count()).toBe(0);
    });
  }

  // The control: §8's other two polling surfaces already satisfy this, so a
  // sweep that passed everywhere for the wrong reason would show up here.
  for (const path of ['/timeline', '/work/kanban']) {
    test(`${path} still offers its Refresh control`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    });
  }
});

/**
 * D-243, extended: Projects and Flow neither polled nor answered the shared
 * topbar Refresh (`LiveStatus.vue`'s "Refresh now" button, wired through
 * usePoll.ts's `triggerGlobalRefresh()`). The polling pages (Sessions,
 * Kanban, Timeline) answer it via their own `usePoll(...)`; Flow joined them
 * at the 15s cadence design-spec.md §8 states for Kanban/Timeline. Projects
 * is now part of Home (ds-spec.md §4.1), which polls too, so its tests run
 * against Home's per-project cards. Roadmap still does not, and the manual-refresh pages
 * above never will by design.
 *
 * The "re-fetches" tests bound their wait well under the 15s poll, so it is
 * the click that must produce the response, not the next tick.
 *
 * DS4 S3 §4: FlowPage is deleted outright, and its `/flow` replacement,
 * Roadmap's `?epic=` mode (RoadmapPage.vue), has no `usePoll(...)` call of
 * its own — it never did even in phase mode. The four Flow tests that used
 * to live here (topbar Refresh re-fetching the graph, keeping content on
 * screen during that refetch, a failed scope-switch fetch, an expanded wave
 * surviving a topbar Refresh) all proved behaviour that lived in
 * usePoll/triggerGlobalRefresh wiring FlowPage had and Roadmap does not —
 * there is no page left anywhere that answers the topbar Refresh with flow
 * data, so there is nothing left for them to re-point at. Dropped rather
 * than rewritten against a control that does not exist.
 */
test.describe('Topbar Refresh reaches Home (D-243)', () => {
  test('Home: topbar Refresh re-fetches the overview', async ({ page }) => {
    await page.goto('/overview');
    await expect(page.getByRole('link', { name: 'View black-smith in Work' })).toBeVisible();

    const refetched = page.waitForResponse((r) => r.url().includes('/api/overview'), {
      timeout: 5000,
    });
    // Refresh is aria-disabled while live (ds-spec.md §2.2) — pause first.
    await page.getByRole('button', { name: 'Pause updates' }).click();
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await refetched;
  });

  test('Home: keeps its content on screen while the topbar Refresh is in flight', async ({
    page,
  }) => {
    await page.goto('/overview');
    await expect(page.getByRole('link', { name: 'View black-smith in Work' })).toBeVisible();
    await expect(page.locator('.bs-skeleton')).toHaveCount(0);

    await page.route('**/api/overview*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    const inFlight = page.waitForRequest((r) => r.url().includes('/api/overview'));
    // Refresh is aria-disabled while live (ds-spec.md §2.2) — pause first.
    await page.getByRole('button', { name: 'Pause updates' }).click();
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await inFlight;

    // Read synchronously, inside the route's hold — see the manual-refresh
    // block above for why a retrying matcher would prove nothing here.
    expect(await page.locator('.bs-skeleton').count()).toBe(0);
    expect(await page.getByRole('link', { name: 'View black-smith in Work' }).count()).toBe(1);
  });
});
