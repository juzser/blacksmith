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
