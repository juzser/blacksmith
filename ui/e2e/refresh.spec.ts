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
  },
  { name: 'Lessons', path: '/lessons', ready: null },
  { name: 'Errors', path: '/errors', ready: null },
  { name: 'Analytics', path: '/analytics', ready: null },
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
      await page.goto(surface.path);
      if (surface.ready) {
        await expect(page.getByRole('tablist', { name: surface.ready })).toBeVisible();
      }
      await expect(page.locator('.hds-skeleton')).toHaveCount(0);

      // Hold the refetch open so the in-flight state is observable rather
      // than raced (the kanban.spec.ts idiom).
      await page.route('**/api/**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
      });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();

      // Read synchronously, inside the route's hold. A retrying matcher would
      // go green the moment the refetch lands -- which is precisely the
      // blank-and-restore flash this forbids. §8 asks for manual refresh
      // because a list re-sorting mid-read is bad; replacing the whole page
      // with a skeleton (and, on Task detail, the Refresh button with it) is
      // strictly worse than the re-sort it was meant to avoid.
      expect(await page.locator('.hds-skeleton').count()).toBe(0);
    });
  }

  // The control: §8's other two polling surfaces already satisfy this, so a
  // sweep that passed everywhere for the wrong reason would show up here.
  for (const path of ['/timeline', '/kanban']) {
    test(`${path} still offers its Refresh control`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    });
  }
});
