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
      await expect(page.locator('.ds-skeleton')).toHaveCount(0);

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
      expect(await page.locator('.ds-skeleton').count()).toBe(0);
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

/**
 * D-243: Projects and Flow neither polled nor answered the shared topbar
 * Refresh (`LiveStatus.vue`'s "Refresh now" button, wired through
 * usePoll.ts's `triggerGlobalRefresh()`). Every other scoped page (Overview,
 * Sessions, Kanban, Timeline) already answers it via its own `usePoll(...)`;
 * these two now join them at the 15s cadence design-spec.md §8 states for
 * Kanban/Timeline.
 */
test.describe('Topbar Refresh reaches Projects and Flow (D-243)', () => {
  test('Projects: topbar Refresh re-fetches the overview', async ({ page }) => {
    await page.goto('/projects');
    await expect(
      page.getByRole('link', { name: /black-smith project, opens overview/ }),
    ).toBeVisible();

    const refetched = page.waitForResponse((r) => r.url().includes('/api/overview'));
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await refetched;
  });

  test('Projects: keeps its content on screen while the topbar Refresh is in flight', async ({
    page,
  }) => {
    await page.goto('/projects');
    await expect(
      page.getByRole('link', { name: /black-smith project, opens overview/ }),
    ).toBeVisible();
    await expect(page.locator('.ds-skeleton')).toHaveCount(0);

    await page.route('**/api/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.getByRole('button', { name: 'Refresh now' }).click();

    // Read synchronously, inside the route's hold — see the manual-refresh
    // block above for why a retrying matcher would prove nothing here.
    expect(await page.locator('.ds-skeleton').count()).toBe(0);
    expect(
      await page.getByRole('link', { name: /black-smith project, opens overview/ }).count(),
    ).toBe(1);
  });

  test('Flow: topbar Refresh re-fetches the graph', async ({ page }) => {
    await page.goto('/flow');
    await expect(page.locator('.flow-wave-label').first()).toBeVisible();

    const refetched = page.waitForResponse((r) => r.url().includes('/api/flow'));
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await refetched;
  });

  test('Flow: keeps its content on screen while the topbar Refresh is in flight', async ({
    page,
  }) => {
    await page.goto('/flow');
    await expect(page.locator('.flow-wave-label').first()).toBeVisible();
    await expect(page.locator('.ds-skeleton')).toHaveCount(0);

    await page.route('**/api/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.getByRole('button', { name: 'Refresh now' }).click();

    expect(await page.locator('.ds-skeleton').count()).toBe(0);
    expect(await page.locator('.flow-wave-label').count()).toBeGreaterThan(0);
  });

  // Round 12's per-wave disclosure is view state, not graph data — a poll
  // tick (or a topbar Refresh) must not fold an operator's open wave back up
  // underneath them. retainFlowView() (lib/flowView.ts) is what load() now
  // defers to instead of the unconditional reset load() used to do on every
  // success.
  test('Flow: an expanded wave survives a topbar Refresh', async ({ page }) => {
    await page.goto('/flow');
    await expect(page.locator('.flow-wave-label').first()).toBeVisible();

    const toggle = page.locator('.flow-wave-label__more').first();
    await expect(toggle).toBeVisible();
    const labelBeforeToggle = await toggle.textContent();
    await toggle.click();
    await expect(toggle).not.toHaveText(labelBeforeToggle ?? '');
    const labelAfterToggle = await toggle.textContent();

    const refetched = page.waitForResponse((r) => r.url().includes('/api/flow'));
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await refetched;

    await expect(toggle).toHaveText(labelAfterToggle ?? '');
  });
});
