import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Lessons', () => {
  test('renders the approved lesson and a11y basics', async ({ page }) => {
    await page.goto('/lessons');
    await expect(page.locator('h1')).toHaveText('Lessons');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await page.getByRole('button', { name: 'All' }).click();
    await expect(page.getByText(/loop bound/)).toBeVisible();
  });

  // The fixture's only lesson is already `approved`, and architecture §9.4
  // lets an approved lesson move only to superseded or invalidated. So the
  // Dialog must not offer Approve or Edit here — pressing either could do
  // nothing but return `lessons.illegal-transition` into a red Banner
  // (P9-36). Reject stays: invalidated is a legal move.
  test('row click opens the review Dialog, offering only the legal actions', async ({ page }) => {
    await page.goto('/lessons');
    await page.getByRole('button', { name: 'All' }).click();
    await page.getByText(/loop bound/).click();
    const dialog = page.getByRole('dialog', { name: 'Review lesson' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Reject' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    // And it says why, rather than leaving a footer that looks half-rendered.
    await expect(dialog.getByText(/nothing left to approve/)).toBeVisible();
  });

  /**
   * D-220. The fixture's second lesson is `invalidated` — the status this
   * page's own Reject button writes. It used to be in neither bucket the API
   * returned, so rejecting a lesson made the row disappear from every filter
   * the page had, "All" included.
   */
  test('shows a rejected lesson under Closed and under All', async ({ page }) => {
    await page.goto('/lessons');
    await expect(page.getByText(/no network access/)).toHaveCount(0);

    await page.getByRole('button', { name: /^Closed/ }).click();
    await expect(page.getByText(/no network access/)).toBeVisible();
    await expect(page.getByText(/loop bound/)).toHaveCount(0);

    await page.getByRole('button', { name: 'All' }).click();
    await expect(page.getByText(/no network access/)).toBeVisible();
    await expect(page.getByText(/loop bound/)).toBeVisible();

    // And it says why the footer has no buttons, rather than looking broken.
    await page.getByText(/no network access/).click();
    const dialog = page.getByRole('dialog', { name: 'Review lesson' });
    await expect(dialog.getByText(/terminal status/)).toBeVisible();
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/lessons');
        await expect(page.locator('h1')).toHaveText('Lessons');
        await settleForShot(page, page.getByText(/Nothing waiting/));
        await shoot(page, `lessons-${vpName}-${theme}`);
      });
    }
  }
});
