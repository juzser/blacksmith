import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Errors', () => {
  test('renders charts, log table, and a11y basics', async ({ page }) => {
    await page.goto('/errors');
    await expect(page.locator('h1')).toHaveText('Errors');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.getByText('Errors over time')).toBeVisible();
    await expect(page.getByText('By group', { exact: true })).toBeVisible();
    await expect(page.locator('svg[role="img"]').first()).toBeVisible();
  });

  test('row click opens the error detail Dialog', async ({ page }) => {
    await page.goto('/errors');
    await page.locator('.hds-table tbody tr[data-clickable]').first().click();
    await expect(page.getByRole('dialog', { name: 'Error detail' })).toBeVisible();
    await expect(page.locator('pre')).toBeVisible();
  });

  // Every panel here chained its empty state off `loading` alone, and the
  // page's error Banner sat outside those chains. A failed fetch therefore
  // rendered the banner alongside three separate all-clears -- and on this
  // page the all-clear is the reassuring reading: "No errors logged yet."
  // says the factory is healthy, on the strength of a request that failed.
  test('a failed errors fetch never renders as a clean error log', async ({ page }) => {
    await page.route('**/api/errors*', (route) => route.abort('failed'));
    await page.goto('/errors');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    await expect(page.getByText('No errors logged yet.')).toHaveCount(0);
    await expect(page.getByText('No provider disagreements logged.')).toHaveCount(0);
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/errors');
        await expect(page.locator('h1')).toHaveText('Errors');
        await settleForShot(page, page.locator('svg[role="img"]').first());
        await shoot(page, `errors-${vpName}-${theme}`);
      });
    }
  }
});
