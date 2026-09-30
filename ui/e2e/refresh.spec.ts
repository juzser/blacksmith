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
 * usePoll.ts's `triggerGlobalRefresh()`). The polling pages (Sessions,
 * Kanban, Timeline) answer it via their own `usePoll(...)`; Flow joined them
 * at the 15s cadence design-spec.md §8 states for Kanban/Timeline. Projects
 * is now part of Home (ds-spec.md §4.1), which polls too, so its tests run
 * against Home's per-project cards. Roadmap still does not, and the manual-refresh pages
 * above never will by design.
 *
 * The "re-fetches" tests bound their wait well under the 15s poll, so it is
 * the click that must produce the response, not the next tick.
 */
test.describe('Topbar Refresh reaches Home and Flow (D-243)', () => {
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

  test('Flow: topbar Refresh re-fetches the graph', async ({ page }) => {
    await page.goto('/flow');
    await expect(page.locator('.flow-wave-label').first()).toBeVisible();

    const refetched = page.waitForResponse((r) => r.url().includes('/api/flow'), {
      timeout: 5000,
    });
    // Refresh is aria-disabled while live (ds-spec.md §2.2) — pause first.
    await page.getByRole('button', { name: 'Pause updates' }).click();
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await refetched;
  });

  test('Flow: keeps its content on screen while the topbar Refresh is in flight', async ({
    page,
  }) => {
    await page.goto('/flow');
    await expect(page.locator('.flow-wave-label').first()).toBeVisible();
    await expect(page.locator('.bs-skeleton')).toHaveCount(0);

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
    // Refresh is aria-disabled while live (ds-spec.md §2.2) — pause first.
    await page.getByRole('button', { name: 'Pause updates' }).click();
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
    await expect(page.locator('.bs-skeleton')).toHaveCount(0);
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
    // Refresh is aria-disabled while live (ds-spec.md §2.2) — pause first.
    await page.getByRole('button', { name: 'Pause updates' }).click();
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect(
      page.locator('.flow-node__title', { hasText: 'Refetched by the topbar' }),
    ).toHaveCount(1);

    await expect(toggle).toHaveText(labelAfterToggle ?? '');
  });
});
