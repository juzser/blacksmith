import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { expect, test } from './harness.js';

/**
 * The app shell's own poll — design-spec.md §8's first bullet and §A.6.
 *
 * Everything here is a claim the unit tests cannot make. `lib/navBadges.ts` is
 * covered thoroughly as a fold over two pulses, but a fold that is correct and
 * never mounted still leaves the operator staring at a frozen server that
 * looks exactly like a quiet factory. What is asserted below is the wiring:
 * that the shell polls where a page does not, that its Refresh reaches the
 * page rather than only the pulse, and that a counter growing while you are
 * elsewhere actually reaches the rail.
 */

/** `/api/pulse`'s shape (lib/api.ts `PulseResult`). */
function pulseBody(events: number, errors: number, lessonsPending = 0) {
  return {
    lastEventAt: FIXTURE_NOW_ISO,
    lastEventType: 'task.completed',
    counts: { events, errors },
    lessonsPending,
  };
}

test.describe('App shell liveness (design-spec §A.6)', () => {
  test('reports the factory pulse on a page that is not Overview', async ({ page }) => {
    // The readout used to live on Overview alone. On the other nine pages a
    // server that had stopped answering was indistinguishable from a factory
    // with nothing to do.
    await page.goto('/timeline');
    const pulse = page.locator('.app-topbar__pulse');
    await expect(pulse).toBeVisible();
    await expect(pulse).toHaveText(/^last event (just now|\d+[smhd] ago)$/);
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

    // Timeline's own poll is 15s away; this resolves in milliseconds.
    const refetch = page.waitForRequest('**/api/timeline*');
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await refetch;
  });

  test('badges a nav item whose counter grew while you were elsewhere', async ({ page }) => {
    let served = 0;
    await page.route('**/api/pulse*', async (route) => {
      served += 1;
      // Errors holds still while events climbs, so a rail that badged on
      // "there are some" rather than "three arrived" fails here.
      await route.fulfill({ json: pulseBody(served === 1 ? 10 : 13, 2) });
    });

    await page.goto('/overview');

    // The first pulse is a baseline, not an arrival: everything the log
    // already held predates you opening the page, and badging it would greet
    // every fresh session with a wall of numbers.
    await expect(page.getByRole('button', { name: 'Timeline', exact: true })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Timeline, 3 new' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: 'Errors', exact: true })).toBeVisible();
  });

  test('clears a badge when you visit the page it was counting for', async ({ page }) => {
    let served = 0;
    await page.route('**/api/pulse*', async (route) => {
      served += 1;
      await route.fulfill({ json: pulseBody(served === 1 ? 10 : 13, 2) });
    });

    await page.goto('/overview');
    await expect(page.getByRole('button', { name: 'Timeline, 3 new' })).toBeVisible({
      timeout: 15_000,
    });

    // Reading the page is what "seen" means. The count restarts from here,
    // so the badge cannot come back for events you have already looked at.
    await page.getByRole('button', { name: 'Timeline, 3 new' }).click();
    await expect(page.getByRole('button', { name: 'Timeline', exact: true })).toBeVisible();
  });
});
