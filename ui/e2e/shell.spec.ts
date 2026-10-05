import { expect, test } from './harness.js';
import { setTheme } from './helpers.js';

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

test.describe('BS kit stylesheets are loaded (ds-spec.md §1, §3)', () => {
  // DS1 moved the shell onto kit components whose look lives entirely in
  // bs-tokens.css + bs-primitives.css. With neither imported the shell still
  // mounts, every role-based assertion above still passes, and the operator
  // gets a column of unstyled text — so assert the CSS itself took effect.
  test('bs-* tokens resolve on :root, per theme', async ({ page }) => {
    await page.goto('/work/kanban');
    const token = (name: string) =>
      page.evaluate(
        (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
        name,
      );
    const light = await token('--bs-surface');
    expect(light).not.toBe('');
    expect(await token('--bs-text')).not.toBe('');

    await page.evaluate(() => document.documentElement.classList.add('dark'));
    const dark = await token('--bs-surface');
    expect(dark).not.toBe('');
    expect(dark).not.toBe(light);
  });

  test('the sidebar is laid out by bs-primitives, not the UA default', async ({ page }) => {
    await page.goto('/work/kanban');
    const side = page.locator('nav.bs-side');
    await expect(side).toBeVisible();
    const style = await side.evaluate((el) => {
      const s = getComputedStyle(el);
      return { display: s.display, flexDirection: s.flexDirection, width: s.width };
    });
    // A bare <nav> is display:block and as wide as its container.
    expect(style.display).toBe('flex');
    expect(style.flexDirection).toBe('column');
    // --bs-sidebar-width is 15rem = 240px.
    expect(style.width).toBe('240px');
  });

  // PR #280 nit: the mark's dark-haired artwork disappeared against
  // --bs-surface-sunken in dark mode (bs-primitives.css .bs-side__mark).
  test('the sidebar mark gets a non-transparent backing plate in dark mode only', async ({
    page,
  }) => {
    await setTheme(page, 'light');
    await page.goto('/work/kanban');
    const mark = page.locator('.bs-side__mark');
    const side = page.locator('nav.bs-side');
    const lightMark = await mark.evaluate((el) => getComputedStyle(el).backgroundColor);
    // No rule touches .bs-side__mark in light mode: transparent, same as before.
    expect(lightMark).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    const lightArt = await page.locator('.bs-side__mark img').boundingBox();
    // No plate, no ring of air: the light-mode box is the artwork itself.
    expect((await mark.boundingBox())?.width).toBe(lightArt?.width);

    await setTheme(page, 'dark');
    await page.reload();
    const darkMark = await mark.evaluate((el) => getComputedStyle(el).backgroundColor);
    const darkSide = await side.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(darkMark).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(darkMark).not.toBe(darkSide);
    // Operator 2026-10-05: an opaque white disc read as a sticker on the dark
    // sidebar. The plate is white at 30% so the surface shows through, and it
    // is wider than the artwork so the edge no longer touches the hair.
    expect(darkMark).toBe('rgba(255, 255, 255, 0.3)');
    const plate = await mark.boundingBox();
    const art = await page.locator('.bs-side__mark img').boundingBox();
    expect(plate && art && plate.width - art.width).toBeGreaterThanOrEqual(8);
    // The plate grows outward: the artwork itself does not move between
    // themes, so light mode keeps its pre-plate position (visual pass D1).
    expect(art?.x).toBe(lightArt?.x);
    expect(art?.y).toBe(lightArt?.y);
    expect(art?.width).toBe(lightArt?.width);
  });
});

test.describe('DS1 shell nav (ds-spec.md §3, §3.1)', () => {
  test('SidebarNav lists the 5 shell items and marks the active one', async ({ page }) => {
    await page.goto('/work/kanban');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    for (const label of ['Home', 'Work', 'Activity', 'Cost & quality', 'Lessons']) {
      await expect(nav.getByRole('button', { name: label })).toBeVisible();
    }
    // On a Work child the child is the page; Work is only the current section.
    await expect(nav.getByRole('button', { name: 'Work' })).toHaveAttribute('aria-current', 'true');
    await expect(nav.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('at 375px the shell swaps to MobileTopBar + MobileTabBar with the same 5 items', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/kanban');

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

  // ds-spec.md line 722: --bs-touch is 44px. IconButtons render at their "sm"
  // or "md" box (22/28px, bs-primitives.css), below that floor until the
  // ≤640px .bs-iconbtn media rule grows the hit area (operator 2026-10-02).
  // Collected generically (`.bs-iconbtn:visible`) rather than a hard-coded
  // list, so a new icon button anywhere in the shell is covered automatically
  // (review follow-up, 2026-10-02).
  test('every visible .bs-iconbtn meets the 44px touch target at the mobile viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    async function measureVisible(screen: string) {
      const buttons = page.locator('.bs-iconbtn:visible');
      const count = await buttons.count();
      for (let i = 0; i < count; i++) {
        const el = buttons.nth(i);
        const name = (await el.getAttribute('aria-label')) ?? `button #${i}`;
        const box = await el.boundingBox();
        expect(box?.width, `${screen}: "${name}" is narrower than 44px`).toBeGreaterThanOrEqual(44);
        expect(box?.height, `${screen}: "${name}" is shorter than 44px`).toBeGreaterThanOrEqual(44);
      }
      return count;
    }

    // Home: only the shell's own MobileTopBar trigger renders here.
    await page.goto('/overview');
    await measureVisible('Home');

    // Kanban: the column "..." menu only exists at desktop width (the phone
    // layout swaps the column head for tabs instead), so it never reaches
    // `:visible` here — the generic locator reflects that without special-
    // casing it.
    await page.goto('/kanban');
    await measureVisible('Kanban (overflow closed)');

    // Opening MobileTopBar's overflow menu reveals Pause/Resume, the theme
    // toggle, the disabled Settings placeholder, and (teleported in by
    // KanbanBoard) the display-options trigger.
    await page.getByRole('button', { name: 'More actions' }).click();
    await measureVisible('Kanban (overflow open, incl. display options)');
  });

  test('the breadcrumb updates immediately on navigation, before page data arrives', async ({
    page,
  }) => {
    await page.goto('/work/kanban');
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('button', { name: 'Activity' })
      .click();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Activity');
  });

  // Operator decision 2026-10-05: Work carries two always-visible level-2
  // items on desktop (ds-spec.md §3) — no fly-out, both visible at once.
  test('Work shows Kanban and Roadmap as level-2 items, and clicking Roadmap navigates there', async ({
    page,
  }) => {
    await page.goto('/work/kanban');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    const kanbanChild = nav.getByRole('button', { name: 'Kanban', exact: true });
    const roadmapChild = nav.getByRole('button', { name: 'Roadmap', exact: true });
    await expect(kanbanChild).toBeVisible();
    await expect(roadmapChild).toBeVisible();

    // Visual pass 2026-10-05: only the active child carries the fill; the
    // Work parent stays unfilled so the two rows never read as one block.
    const bg = (l: typeof kanbanChild) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
    const work = nav.getByRole('button', { name: 'Work' });
    expect(await bg(work)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(await bg(kanbanChild)).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    // Same row height as the parent (no smaller tap target in the Sheet).
    expect((await kanbanChild.boundingBox())?.height).toBe((await work.boundingBox())?.height);

    await roadmapChild.click();
    await expect(page).toHaveURL(/\/work\/roadmap$/);
    await expect(roadmapChild).toHaveAttribute('aria-current', 'page');
  });
});
