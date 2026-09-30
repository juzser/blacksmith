import { expect, test } from './harness.js';

/**
 * The app shell's own poll (design-spec.md §8's first bullet and §A.6), and
 * DS1's shell wiring (ds-spec.md §3, §3.1) — the 5-item nav and the mobile
 * shell at 375px. Everything here is a claim the unit tests cannot make: a
 * `LiveIndicator` that is correct and never mounted still leaves the operator
 * staring at a frozen server that looks exactly like a quiet factory.
 */

test.describe('App shell liveness (design-spec §A.6)', () => {
  test('reports the factory pulse on a page that is not Overview', async ({ page }) => {
    // The readout used to live on Overview alone. On the other nine pages a
    // server that had stopped answering was indistinguishable from a factory
    // with nothing to do.
    await page.goto('/timeline');
    const live = page.locator('.bs-live');
    await expect(live).toBeVisible();
    await expect(live.locator('.bs-live__text')).toHaveText(/^(Live|Paused)/);
  });

  test('polls on a page that has no poll of its own', async ({ page }) => {
    // Lessons is one of §8's manual-refresh-only pages: it fetches once and
    // then never again. The shell's poll is the only thing keeping its
    // freshness indicator honest, so it has to fire there too.
    let pulses = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/pulse')) pulses += 1;
    });
    await page.goto('/lessons');
    // Two, not one: a single request is just the mount. A second proves the
    // 5s interval is running on a page that polls for nothing itself.
    await expect.poll(() => pulses, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  });

  test('the topbar Refresh refetches the page you are on, not just the pulse', async ({ page }) => {
    // The shell owns a Refresh button on every page, and a button that
    // refreshed only the indicator beside it would be the most misleading
    // control in the app: the timestamp would go green while the data under
    // it stayed exactly as stale. usePoll's global signal is what makes the
    // claim true, and this is the only layer that can see it.
    await page.goto('/timeline');
    await expect(page.locator('.ds-skeleton')).toHaveCount(0);

    // Refresh is aria-disabled while live (ds-spec.md §2.2) — pause first.
    await page.getByRole('button', { name: 'Pause updates' }).click();

    // Timeline's own poll is 15s away; this resolves in milliseconds.
    const refetch = page.waitForRequest('**/api/timeline*');
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await refetch;
  });

  test('the Pause control stops usePoll driving further automatic refreshes', async ({ page }) => {
    await page.goto('/lessons');
    await page.getByRole('button', { name: 'Pause updates' }).click();
    await expect(page.getByRole('button', { name: 'Resume updates' })).toBeVisible();

    let pulses = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/pulse')) pulses += 1;
    });
    // usePoll's interval is 5s; if paused truly stands it down, nothing new
    // arrives inside a window comfortably longer than one tick.
    await page.waitForTimeout(6_000);
    expect(pulses).toBe(0);
  });
});

test.describe('DS1 shell nav (ds-spec.md §3, §3.1)', () => {
  test('SidebarNav lists the 5 shell items and marks the active one', async ({ page }) => {
    await page.goto('/kanban');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    for (const label of ['Home', 'Work', 'Activity', 'Cost & quality', 'Lessons']) {
      await expect(nav.getByRole('button', { name: label })).toBeVisible();
    }
    await expect(nav.getByRole('button', { name: 'Work' })).toHaveAttribute('aria-current', 'page');
  });

  test('at 375px the shell swaps to MobileTopBar + MobileTabBar with the same 5 items', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/kanban');

    await expect(page.locator('.bs-mtopbar')).toBeVisible();
    const tabbar = page.getByRole('navigation', { name: 'Primary' });
    await expect(tabbar).toBeVisible();
    // MobileTabBar uses the short label ("Cost", not "Cost & quality") — DS1
    // has no room for the full label at 375px (ds-spec.md §3).
    for (const label of ['Home', 'Work', 'Activity', 'Cost', 'Lessons']) {
      await expect(tabbar.getByRole('button', { name: label })).toBeVisible();
    }
    await expect(tabbar.getByRole('button', { name: 'Work' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the breadcrumb updates immediately on navigation, before page data arrives', async ({
    page,
  }) => {
    await page.goto('/kanban');
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('button', { name: 'Activity' })
      .click();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Activity');
  });
});
