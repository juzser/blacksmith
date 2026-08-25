import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Analytics', () => {
  test('renders the stat row, charts, and a11y basics', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page.locator('h1')).toHaveText('Analytics');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.getByText('Throughput', { exact: true })).toBeVisible();
    await expect(page.getByText('Cost per task by model tier')).toBeVisible();
  });

  // The only layer that renders AnalyticsPage.vue at all: ui/tsconfig.json
  // does not type-check .vue files and ui/vitest.config.ts has no component
  // harness, so a percentage computed in the template is a number no other
  // suite can reach. This fixture's rechecks are all still in flight, which
  // is the case D-219 got wrong — the card used to print a bare `0` under a
  // label promising a rate, which reads as "none of them passed" rather than
  // "none of them has finished".
  test('a rate with no denominator reads as absent, not as zero', async ({ page }) => {
    await page.goto('/analytics');
    const recheck = page.locator('.hds-stat', { hasText: 'Recheck pass rate' });
    await expect(recheck).toContainText('\u2014');
    await expect(recheck).toContainText('none settled yet');
    await expect(recheck).not.toContainText('0');
  });

  // The fixture runs one tier ("mid") on two providers, so the API's cost
  // series — keyed by the (model_tier, provider) pair — holds two rows for it.
  // The tier card used to chart those rows one-for-one and label each with the
  // tier half of its key: two bars both called "mid", neither of them the
  // tier's cost per task, and a duplicate `:key` on BarChart's v-for (D-221).
  test('charts one bar per tier, not one per (tier, provider) pair', async ({ page }) => {
    await page.goto('/analytics');
    const tierCard = page
      .locator('.hds-card')
      .filter({ has: page.getByText('Cost per task by model tier') });
    const labels = tierCard.locator('.hds-bars__x');
    await expect(labels).toHaveText(['mid']);
    // 2000 + 1300 + 5000 tokens over three tasks.
    await expect(tierCard.locator('.hds-bars__v')).toHaveText(['2767']);
  });

  // Its sibling plotted each provider's total token spend under a title the
  // design spec writes as "Cost per task by provider", so the busier provider
  // always read as the more expensive one and the two cards sat side by side
  // in different units.
  test('charts cost per task by provider, not the provider’s total spend', async ({ page }) => {
    await page.goto('/analytics');
    const providerCard = page
      .locator('.hds-card')
      .filter({ has: page.getByText('Cost per task by provider') });
    await expect(providerCard.locator('.hds-bars__x')).toHaveText(['claude', 'codex']);
    // claude: 3300 over two tasks. codex: 5000 over one — a total of 3300
    // would have made claude the more expensive of the two.
    await expect(providerCard.locator('.hds-bars__v')).toHaveText(['1650', '5000']);
    await expect(providerCard.getByRole('img')).toHaveAttribute(
      'aria-label',
      /Tokens per task by provider/,
    );
  });

  // The page's only surface for a provider that is not claude. Cost cannot be
  // that surface: it is read off `task-result-recorded`, which only a builder
  // writes, and every external provider in this factory judges rather than
  // builds -- so the cost cards above name claude in every real session ever
  // logged while codex and deepseek judge in the same log. This card was
  // hardcoded to "No quorum data wired yet" against sixteen shipped judge
  // runs, so the Analytics page reported a single-provider factory (D-255).
  test('names the cross-check judges, and does not read a missing rate as zero', async ({
    page,
  }) => {
    await page.goto('/analytics');
    const quorum = page.locator('.hds-card').filter({ has: page.getByText('Cross-check quorum') });
    await expect(quorum.locator('.hds-row__title')).toHaveText(['codex', 'deepseek']);
    // deepseek answered once out of two runs and agreed; codex never answered
    // at all. 0% would report a provider that never got to speak as one that
    // disagreed with every native call -- the opposite reading (D-168/D-31).
    await expect(quorum.locator('.hds-row__trail')).toHaveText(['no verdict', '100% agree']);
    // Anchored: "100% agree" contains "0% agree" as a substring.
    await expect(quorum).not.toContainText(/\b0% agree/);
    // The two failures are not the same failure, and the card says which (D-253).
    await expect(quorum).toContainText('provider.invalid-output');
    await expect(quorum).toContainText('provider.missing-api-key');
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/analytics');
        await expect(page.locator('h1')).toHaveText('Analytics');
        await settleForShot(page, page.getByText('Throughput', { exact: true }));
        await shoot(page, `analytics-${vpName}-${theme}`);
      });
    }
  }
});
