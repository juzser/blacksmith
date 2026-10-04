import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Analytics', () => {
  test('renders the period switch, charts, metric cards, and a11y basics', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page.locator('h1')).toHaveText('Cost & quality');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.getByRole('group', { name: 'Period' })).toBeVisible();
    await expect(
      page.locator('.bs-card__title').getByText('Tokens per day', { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.bs-card__title').getByText('Tokens per task', { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.bs-card__title').getByText('Second-opinion reviewers', { exact: true }),
    ).toBeVisible();
  });

  // A rate with no denominator reads as "not enough data", never as a bare
  // 0 or dash that could be misread as "none of them passed" (D-219).
  test('a rate with no denominator reads as not-enough-data, not as zero', async ({ page }) => {
    await page.goto('/analytics');
    const card = page.locator('.bs-card').filter({ hasText: 'Fixes that held on recheck' });
    await expect(card).toContainText('Not enough data yet');
    await expect(card).not.toContainText(/\b0%/);
  });

  // The page's only surface for a provider that is not claude. Cost cannot
  // be that surface: it is read off task-result-recorded, which only a
  // builder writes, while every external provider in this factory judges
  // rather than builds — so this aggregate agreement ring is the one place
  // codex/deepseek's calibration shows up at all (D-255).
  test('names no provider as a flat zero when it never answered', async ({ page }) => {
    await page.goto('/analytics');
    const card = page.locator('.bs-card').filter({ hasText: 'Second-opinion reviewers' });
    await expect(card).not.toContainText(/\b0%/);
  });

  test('charts cost per task by provider, not the provider’s total spend', async ({ page }) => {
    await page.goto('/analytics');
    const providerCard = page
      .locator('.bs-card')
      .filter({ has: page.getByText('Cost per task by provider', { exact: true }) });
    await expect(providerCard.locator('.bs-bars__x')).toHaveText(['claude', 'codex']);
    // claude: 2000 + 1300 + 900 over three tasks = 1400. codex: 5000 + 1000
    // over two tasks = 3000 (same claude/codex mid-tier buckets every other
    // suite reads off this fixture).
    await expect(providerCard.locator('.bs-bars__v')).toHaveText(['1400', '3000']);
    await expect(providerCard.getByRole('img')).toHaveAttribute(
      'aria-label',
      /Tokens per task by provider/,
    );
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/analytics');
        await expect(page.locator('h1')).toHaveText('Cost & quality');
        await settleForShot(
          page,
          page.locator('.bs-card__title').getByText('Tokens per day', { exact: true }),
        );
        await shoot(page, `analytics-${vpName}-${theme}`);
      });
    }
  }
});
