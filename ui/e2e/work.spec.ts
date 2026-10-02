// Work page shell (ds4-plan.md S1): the Kanban/Roadmap switcher, legacy
// redirects, and the phone overflow's View radio group. The unit specs
// (ui/test/workView.test.ts, workPageMobile.test.ts, kitSegmentedControl.test.ts)
// own the source-level contract; this is the one claim only a browser can
// settle — a real navigation, a real history stack, a real viewport.
import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Work switcher', () => {
  test('switching view updates the URL, and back/forward move between them', async ({ page }) => {
    await page.goto('/work/kanban');
    await expect(page.locator('h1')).toHaveText('Work');

    await page.getByRole('link', { name: 'Roadmap' }).click();
    await expect(page).toHaveURL(/\/work\/roadmap$/);
    await expect(page.locator('.roadmap-node').first()).toBeVisible();

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
    const radiogroup = page.getByRole('radiogroup', { name: 'View' });
    await expect(radiogroup).toBeVisible();

    await radiogroup.getByRole('radio', { name: 'Roadmap' }).check();
    await expect(page).toHaveURL(/\/work\/roadmap$/);
    await expect(radiogroup).toBeHidden();
  });

  test('phone: both View radio rows meet the 44px touch target (DS4 S1 round 3, S2 finding 4)', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');

    await page.getByRole('button', { name: 'More actions' }).click();
    const radiogroup = page.getByRole('radiogroup', { name: 'View' });
    await expect(radiogroup).toBeVisible();

    const rows = await radiogroup.getByRole('radio').all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const box = await row.locator('xpath=..').boundingBox();
      if (!box) throw new Error('a View radio row has no box');
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('phone: the overflow renders as a vertical labeled menu, View stacked below the built-ins (DS4 S1 round 4)', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');

    await page.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu', { name: 'More actions' });
    await expect(menu).toBeVisible();

    const menuitems = await menu.getByRole('menuitem').all();
    // Built-ins (Pause, Switch theme, Settings) plus Kanban's display-options
    // row, now also a menuitem (DS4 S1 round 5, S3 finding 2).
    expect(menuitems.length).toBeGreaterThanOrEqual(4);
    const radios = await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio').all();
    expect(radios.length).toBeGreaterThan(0);

    // DOM order, not query order: a querySelectorAll-backed locator with a
    // grouped selector returns elements in document order, which on this
    // vertical flex column is also visual top-to-bottom order — menuitems
    // and radios interleave (the Kanban row sits below the View radios).
    const rowEls = await menu.locator('[role="menuitem"], [role="radio"]').all();
    const rows: { top: number; bottom: number }[] = [];
    for (const el of rowEls) {
      const role = await el.getAttribute('role');
      const target = role === 'radio' ? el.locator('xpath=..') : el;
      const box = await target.boundingBox();
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
      await page.goto('/work/kanban');
      await page.getByRole('button', { name: 'More actions' }).click();
      const radiogroup = page.getByRole('radiogroup', { name: 'View' });
      await settleForShot(page, radiogroup);
      await shoot(page, `work-mobile-overflow-${theme}`);
    });
  }
});
