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
 * D-243, extended: Projects and Flow neither polled nor answered the shared
 * topbar Refresh (`LiveStatus.vue`'s "Refresh now" button, wired through
 * usePoll.ts's `triggerGlobalRefresh()`). The polling pages (Overview,
 * Sessions, Kanban, Timeline) answer it via their own `usePoll(...)`; these
 * two now join them at the 15s cadence design-spec.md §8 states for
 * Kanban/Timeline. Roadmap still does not, and the manual-refresh pages
 * above never will by design.
 *
 * The "re-fetches" tests bound their wait well under the 15s poll, so it is
 * the click that must produce the response, not the next tick.
 */
test.describe('Topbar Refresh reaches Projects and Flow (D-243)', () => {
  test('Projects: topbar Refresh re-fetches the overview', async ({ page }) => {
    await page.goto('/projects');
    await expect(
      page.getByRole('link', { name: /black-smith project, opens overview/ }),
    ).toBeVisible();

    const refetched = page.waitForResponse((r) => r.url().includes('/api/overview'), {
      timeout: 5000,
    });
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

    await page.route('**/api/overview*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    const inFlight = page.waitForRequest((r) => r.url().includes('/api/overview'));
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await inFlight;

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

    const refetched = page.waitForResponse((r) => r.url().includes('/api/flow'), {
      timeout: 5000,
    });
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await refetched;
  });

  test('Flow: keeps its content on screen while the topbar Refresh is in flight', async ({
    page,
  }) => {
    await page.goto('/flow');
    await expect(page.locator('.flow-wave-label').first()).toBeVisible();
    await expect(page.locator('.ds-skeleton')).toHaveCount(0);

    // Hold the graph fetch only. The page's refresh tick awaits the picker's
    // /api/overview BEFORE load() runs, so a hold on every /api/** route
    // would have parked the tick there and the reads below would have run
    // before `loading` could ever have been raised -- a version that showed
    // the skeleton on every load would have passed. Waiting for the graph
    // request itself puts the reads inside load()'s in-flight window.
    await page.route('**/api/flow**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    const inFlight = page.waitForRequest((r) => r.url().includes('/api/flow'));
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await inFlight;

    expect(await page.locator('.ds-skeleton').count()).toBe(0);
    expect(await page.locator('.flow-wave-label').count()).toBeGreaterThan(0);
  });

  // A scope switch is a reset load: the graph on hand is the old epic's, so
  // when the new epic's fetch fails there is nothing true to draw under the
  // banner -- not the previous scope's DAG beneath a toolbar that names the
  // new one.
  test('Flow: a scope switch whose fetch fails shows the banner alone', async ({ page }) => {
    await page.goto('/flow');
    await expect(page.locator('.flow-wave-label').first()).toBeVisible();

    await page.route('**/api/flow**', (route) => route.abort('failed'));
    await page.getByLabel('Epic', { exact: true }).selectOption('epic-1');

    await expect(page.locator('.ds-banner')).toBeVisible();
    await expect(page.locator('.ds-skeleton')).toHaveCount(0);
    await expect(page.locator('.flow-node')).toHaveCount(0);
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

    // A response event fires before the page has parsed the body and Vue
    // has flushed, so a bare waitForResponse could read the toggle before
    // the re-render it is meant to check. Stamp the refetched graph and wait
    // for the stamp to reach the DOM instead.
    await page.route('**/api/flow**', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.nodes[0].title = 'Refetched by the topbar';
      await route.fulfill({ response, json: body });
    });
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect(
      page.locator('.flow-node__title', { hasText: 'Refetched by the topbar' }),
    ).toHaveCount(1);

    await expect(toggle).toHaveText(labelAfterToggle ?? '');
  });
});
