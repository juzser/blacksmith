// Work page shell (ds4-plan.md S1): the Kanban/Roadmap switcher, legacy
// redirects, and the phone overflow's View radio group. The unit specs
// (ui/test/workView.test.ts, workPageMobile.test.ts, kitSegmentedControl.test.ts)
// own the source-level contract; this is the one claim only a browser can
// settle — a real navigation, a real history stack, a real viewport.

import { stubActiveScope } from './activeScopeStub.js';
import { expect, type Page, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Work switcher', () => {
  test('switching view updates the URL, and back/forward move between them', async ({ page }) => {
    await page.goto('/work/kanban');
    await expect(page.locator('h1')).toHaveText('Work');

    await page.getByRole('link', { name: 'Roadmap' }).click();
    await expect(page).toHaveURL(/\/work\/roadmap$/);
    await expect(page.locator('.lrow').first()).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/work\/kanban$/);
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/\/work\/roadmap$/);
  });

  test('a legacy /roadmap link lands on /work/roadmap, keeping the query string', async ({
    page,
  }) => {
    await page.goto('/roadmap?project=black-smith');
    await expect(page).toHaveURL(/\/work\/roadmap\?project=black-smith$/);
    await expect(page.locator('h1')).toHaveText('Work');
  });

  test('a legacy /kanban link lands on /work/kanban, keeping the query string', async ({
    page,
  }) => {
    await page.goto('/kanban?epic=epic-1');
    await expect(page).toHaveURL(/\/work\/kanban\?epic=epic-1$/);
    await expect(page.locator('h1')).toHaveText('Work');
  });

  test('the session picker shows only on Roadmap, not Kanban', async ({ page }) => {
    await page.goto('/work/kanban');
    await expect(page.locator('select[aria-label="Session"]')).toHaveCount(0);

    await page.getByRole('link', { name: 'Roadmap' }).click();
    await expect(page.locator('select[aria-label="Session"]')).toBeVisible();
  });

  test('phone: the overflow menu carries the View switch, which closes it on pick', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');

    await page.getByRole('button', { name: 'More actions' }).click();
    const group = page.getByRole('group', { name: 'View' });
    await expect(group).toBeVisible();

    await group.getByRole('menuitemradio', { name: 'Roadmap' }).click();
    await expect(page).toHaveURL(/\/work\/roadmap$/);
    await expect(group).toBeHidden();
  });

  test('phone: both View menuitemradio rows meet the 44px touch target (DS4 S1 round 3, S2 finding 4)', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');

    await page.getByRole('button', { name: 'More actions' }).click();
    const group = page.getByRole('group', { name: 'View' });
    await expect(group).toBeVisible();

    const rowsLocator = group.getByRole('menuitemradio');
    await expect.poll(() => rowsLocator.count()).toBeGreaterThan(0);
    const rows = await rowsLocator.all();
    for (const row of rows) {
      const box = await row.boundingBox();
      if (!box) throw new Error('a View menuitemradio row has no box');
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('phone: the View items are menuitemradio with correct aria-checked, and the menu has no radiogroup/radio input (DS4 S1 round 6, S3 a11y finding)', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');

    await page.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu', { name: 'More actions' });
    await expect(menu).toBeVisible();

    await expect(menu.getByRole('radiogroup')).toHaveCount(0);
    await expect(menu.locator('input[type="radio"]')).toHaveCount(0);

    const kanban = menu.getByRole('menuitemradio', { name: 'Kanban' });
    const roadmap = menu.getByRole('menuitemradio', { name: 'Roadmap' });
    await expect(kanban).toHaveAttribute('aria-checked', 'true');
    await expect(roadmap).toHaveAttribute('aria-checked', 'false');
  });

  test('phone: the trigger has aria-haspopup=menu and aria-expanded', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');

    const trigger = page.getByRole('button', { name: 'More actions' });
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  test('phone: Tab out of the menu closes it (WAI-ARIA APG menu button pattern, DS4 S1 round 7)', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');

    const trigger = page.getByRole('button', { name: 'More actions' });
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'More actions' });
    await expect(menu).toBeVisible();

    const items = menu.locator('[role="menuitem"], [role="menuitemradio"]');
    await expect.poll(() => items.count()).toBeGreaterThanOrEqual(6); // see the round-6 walk test below
    const count = await items.count();
    await page.keyboard.press('End');
    await expect(items.nth(count - 1)).toBeFocused();
    await page.keyboard.press('Tab');

    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('phone: ArrowDown from the first item walks every menu item in order and wraps, Home/End jump (DS4 S1 round 6)', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');

    await page.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu', { name: 'More actions' });
    await expect(menu).toBeVisible();

    const items = menu.locator('[role="menuitem"], [role="menuitemradio"]');
    // Wait for every item before counting: the menu can be visible a frame
    // before its last item renders, and a count read then walks a short list.
    await expect.poll(() => items.count()).toBeGreaterThanOrEqual(6); // Pause, theme, Settings, Kanban, Roadmap, Display options
    const count = await items.count();

    // Opening the menu focuses the first item.
    await expect(items.nth(0)).toBeFocused();

    for (let i = 1; i < count; i += 1) {
      await page.keyboard.press('ArrowDown');
      await expect(items.nth(i)).toBeFocused();
    }
    // Wraps back to the first item.
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(0)).toBeFocused();

    await page.keyboard.press('End');
    await expect(items.nth(count - 1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.nth(0)).toBeFocused();

    // ArrowUp from the first item wraps to the last.
    await page.keyboard.press('ArrowUp');
    await expect(items.nth(count - 1)).toBeFocused();
  });

  test('phone: Enter switches the view, and Escape returns focus to the trigger (DS4 S1 round 6)', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');

    const trigger = page.getByRole('button', { name: 'More actions' });
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'More actions' });
    const roadmap = menu.getByRole('menuitemradio', { name: 'Roadmap' });
    await roadmap.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/work\/roadmap$/);

    await trigger.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('phone: the overflow renders as a vertical labeled menu, View stacked below the built-ins (DS4 S1 round 4)', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');

    await page.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu', { name: 'More actions' });
    await expect(menu).toBeVisible();

    const menuitemsLocator = menu.getByRole('menuitem');
    // Built-ins (Pause, Switch theme, Settings) plus Kanban's display-options
    // row, now also a menuitem (DS4 S1 round 5, S3 finding 2).
    await expect.poll(() => menuitemsLocator.count()).toBeGreaterThanOrEqual(4);
    const menuitems = await menuitemsLocator.all();
    const radiosLocator = menu.getByRole('menuitemradio');
    await expect.poll(() => radiosLocator.count()).toBeGreaterThan(0);
    const radios = await radiosLocator.all();

    // DOM order, not query order: a querySelectorAll-backed locator with a
    // grouped selector returns elements in document order, which on this
    // vertical flex column is also visual top-to-bottom order — menuitems
    // and menuitemradios interleave (the Kanban row sits below the View
    // rows).
    const rowsLocator = menu.locator('[role="menuitem"], [role="menuitemradio"]');
    await expect.poll(() => rowsLocator.count()).toBe(menuitems.length + radios.length);
    const rowEls = await rowsLocator.all();
    const rows: { top: number; bottom: number }[] = [];
    for (const el of rowEls) {
      const box = await el.boundingBox();
      if (!box) throw new Error('a menu row has no box');
      expect(box.height).toBeGreaterThanOrEqual(44);
      rows.push({ top: box.y, bottom: box.y + box.height });
    }
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      const prev = rows[i - 1];
      if (!row || !prev) throw new Error('row index out of range');
      expect(row.top).toBeGreaterThanOrEqual(prev.bottom);
    }

    await expect(page.getByText('View', { exact: true })).toBeVisible();
  });

  test('phone: the display-options row is a labeled row that still opens display options (DS4 S1 round 5, S3 finding 2)', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');

    await page.getByRole('button', { name: 'More actions' }).click();
    const row = page.getByRole('menuitem', { name: 'Display options' });
    await expect(row).toBeVisible();
    await expect(row).toHaveText(/Display options/);

    const box = await row.boundingBox();
    if (!box) throw new Error('the display-options row has no box');
    expect(box.height).toBeGreaterThanOrEqual(44);

    await row.click();
    await expect(page.getByText('Show summary')).toBeVisible();
  });

  test('phone: the overflow popover stays fully inside the viewport (DS4 S1 round 2, S2-major finding 5)', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');

    await page.getByRole('button', { name: 'More actions' }).click();
    const panel = page.getByRole('dialog', { name: 'More actions' });
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    if (!box) throw new Error('the overflow popover has no box');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(VIEWPORTS.mobile.width);
  });

  // UI audit fix round 2: the Work page header renders only an sr-only h1
  // (the crumb carries the visible title), so nothing in it should be a flex
  // item of .app-page's gapped stack — the toolbar must sit right at the
  // page's own top padding, not a stack gap below it (see PageHeader.vue's
  // isEmpty branch).
  for (const [path, toolbarClass] of [
    ['/work/kanban', '.bs-kanban-page__toolbar'],
    ['/work/roadmap', '.bs-roadmap-page__toolbar'],
  ] as const) {
    test(`the toolbar sits at the page top padding, with no leftover band above it (${path})`, async ({
      page,
    }) => {
      await page.goto(path);
      const toolbar = page.locator(toolbarClass);
      await expect(toolbar).toBeVisible();

      const pagePadding = await page.evaluate(() => {
        const el = document.querySelector('.app-page');
        if (!el) throw new Error('.app-page not found');
        return Number.parseFloat(getComputedStyle(el).paddingTop);
      });

      const pageBox = await page.locator('.app-page').boundingBox();
      const toolbarBox = await toolbar.boundingBox();
      if (!pageBox || !toolbarBox) throw new Error('the page or toolbar has no box');

      expect(Math.abs(toolbarBox.y - pageBox.y - pagePadding)).toBeLessThanOrEqual(1);
    });
  }

  // Operator report 2026-10-05: the switch rendered at the 44px touch floor
  // (much taller than the toolbar's other small controls) and sat flush
  // against the content below it (see
  // ui/e2e/__screenshots__/phase-6b/work-roadmap-epic-desktop-light.png).
  test.describe('view switch sizing and spacing (operator report 2026-10-05)', () => {
    test("desktop: the switch is no taller than the Kanban toolbar's Refresh button", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/work/kanban');
      const segctl = page.locator('#bs-work-view-switch .bs-segctl');
      const refresh = page
        .locator('.bs-kanban-page__toolbar')
        .getByRole('button', { name: 'Refresh', exact: true });
      await expect(segctl).toBeVisible();
      await expect(refresh).toBeVisible();

      const segBox = await segctl.boundingBox();
      const refreshBox = await refresh.boundingBox();
      if (!segBox || !refreshBox) throw new Error('the switch or Refresh button has no box');
      expect(segBox.height).toBeLessThanOrEqual(refreshBox.height);
    });

    for (const [path, toolbarClass, contentSelector] of [
      ['/work/kanban', '.bs-kanban-page__toolbar', '.bs-kanban-board'],
      ['/work/roadmap', '.bs-roadmap-page__toolbar', '.rm-stack'],
    ] as const) {
      test(`desktop: clears the spacing-token gap below the toolbar (${path})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(path);
        const toolbar = page.locator(toolbarClass);
        const content = page.locator(contentSelector).first();
        await expect(toolbar).toBeVisible();
        await expect(content).toBeVisible();

        // Read the gap token from the page rather than hard-coding its px
        // value, same pattern as touchTargets.spec.ts reads --bs-touch.
        const spaceToken = await page.evaluate(() =>
          parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bs-space-4')),
        );
        expect(spaceToken).toBeGreaterThan(0);

        const toolbarBox = await toolbar.boundingBox();
        const contentBox = await content.boundingBox();
        if (!toolbarBox || !contentBox) throw new Error('the toolbar or content has no box');
        const gap = contentBox.y - (toolbarBox.y + toolbarBox.height);
        expect(gap).toBeGreaterThanOrEqual(spaceToken - 1);
      });
    }
  });

  test('no horizontal scroll at 375px on either view', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    for (const path of ['/work/kanban', '/work/roadmap']) {
      await page.goto(path);
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflows).toBe(false);
    }
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`screenshot mobile overflow/${theme}`, async ({ page }) => {
      await setTheme(page, theme);
      await page.setViewportSize(VIEWPORTS.mobile);
      await stubActiveScope(page, ['epic-9']);
      await page.goto('/work/kanban?scope=all');
      await page.getByRole('button', { name: 'More actions' }).click();
      const group = page.getByRole('group', { name: 'View' });
      await settleForShot(page, group);
      await shoot(page, `work-mobile-overflow-${theme}`);
    });
  }
});

// A Teleport whose target is missing at mount never mounts its children; the
// next patch of one of them then throws mid-render and leaves the app shell
// dead (every screen blank until a reload). So these walks assert real page
// content at each stop and that the page logged no error at all.
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

async function walkEveryScreen(page: Page, errors: string[]): Promise<void> {
  const primary = page.getByRole('navigation', { name: 'Primary' });
  // Activity has no h1 of its own (the topbar carries the title); its feed is
  // the landmark that only renders once the page mounted.
  const screens = [
    { tab: /^Home/, content: page.getByRole('heading', { level: 1, name: 'Home' }) },
    { tab: /^Activity/, content: page.getByRole('feed', { name: 'Activity' }) },
    { tab: /^Sessions/, content: page.getByRole('heading', { level: 1, name: 'Sessions' }) },
    { tab: /^Cost/, content: page.getByRole('heading', { level: 1, name: 'Cost & quality' }) },
    { tab: /^Lessons/, content: page.getByRole('heading', { level: 1, name: 'Lessons' }) },
    { tab: /^Work/, content: page.getByRole('heading', { level: 1, name: 'Work' }) },
  ];
  for (const { tab, content } of screens) {
    await primary.getByRole('button', { name: tab }).first().click();
    await expect(content).toBeAttached();
  }
  expect(errors).toEqual([]);
}

test.describe('Work view switch keeps the app alive', () => {
  test('desktop: Kanban -> Roadmap (segmented control) -> Home, then every screen', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/overview');
    const primary = page.getByRole('navigation', { name: 'Primary' });
    await primary.getByRole('button', { name: 'Work', exact: true }).click();
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();

    await page.locator('#bs-work-view-switch').getByRole('link', { name: 'Roadmap' }).click();
    await expect(page).toHaveURL(/\/work\/roadmap$/);
    await expect(page.locator('.lrow').first()).toBeVisible();
    expect(errors).toEqual([]);

    await primary.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await walkEveryScreen(page, errors);
  });

  test('desktop: Kanban -> Roadmap (sidebar) -> Home, then every screen', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/overview');
    const primary = page.getByRole('navigation', { name: 'Primary' });
    await primary.getByRole('button', { name: 'Work', exact: true }).click();
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();

    await primary.getByRole('button', { name: 'Roadmap', exact: true }).click();
    await expect(page.locator('.lrow').first()).toBeVisible();
    expect(errors).toEqual([]);

    await primary.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await walkEveryScreen(page, errors);
  });

  test('phone: View switched through the overflow menu, then Home and the rest', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page
      .getByRole('group', { name: 'View' })
      .getByRole('menuitemradio', { name: 'Roadmap' })
      .click();
    await expect(page).toHaveURL(/\/work\/roadmap$/);

    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('button', { name: 'Home', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await walkEveryScreen(page, errors);
  });

  test('resize: desktop Kanban -> phone width -> Roadmap -> desktop -> Home', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/work/kanban');
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();

    await page.setViewportSize(VIEWPORTS.mobile);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page
      .getByRole('group', { name: 'View' })
      .getByRole('menuitemradio', { name: 'Roadmap' })
      .click();
    await expect(page).toHaveURL(/\/work\/roadmap$/);

    await page.setViewportSize(VIEWPORTS.desktop);
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('button', { name: 'Home', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await walkEveryScreen(page, errors);
  });
});
