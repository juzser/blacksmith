import { expect, test } from './harness.js';
import { growToPageHeight, setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

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

  // Scoped to the base project alone, only claude ever wrote a
  // task-result-recorded row: the provider comparison card must not render
  // at all below two real providers (D-219's shape — no block pretending a
  // single bar is a comparison).
  test('hides the provider comparison block below two real providers', async ({ page }) => {
    await page.goto('/analytics?project=black-smith');
    await expect(page.locator('h1')).toHaveText('Cost & quality');
    await expect(
      page.locator('.bs-card').filter({ hasText: 'Cost per task by provider' }),
    ).toHaveCount(0);
  });

  test('renders an empty state for a project with no analytics data', async ({ page }) => {
    await page.goto('/analytics?project=no-such-project');
    await expect(page.locator('h1')).toHaveText('Cost & quality');
    await expect(page.getByText('No token usage recorded yet.').first()).toBeVisible();
  });

  // The base fixture only exercises builder/reviewer roles. A third role
  // (and a day with zero tokens) confirms the "Total tokens, by selected
  // period" chart renders more than two categories and the empty-day track
  // stays visibly empty rather than reading as a full bar (defect 2/6/8).
  test('renders more than two role categories, and keeps a zero-token day empty', async ({
    page,
  }) => {
    await page.route('**/api/analytics*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.tokensByRoleAndModelTier = [
        {
          role: 'builder',
          modelTier: 'mid',
          runCount: 3,
          tokens: 4200,
          avgTokensPerRun: 1400,
          unmeasuredRunCount: 0,
        },
        {
          role: 'reviewer',
          modelTier: 'mid',
          runCount: 2,
          tokens: 1800,
          avgTokensPerRun: 900,
          unmeasuredRunCount: 0,
        },
        {
          role: 'planner',
          modelTier: 'high',
          runCount: 1,
          tokens: 600,
          avgTokensPerRun: 600,
          unmeasuredRunCount: 0,
        },
      ];
      body.tokensByDay = [
        ...(body.tokensByDay ?? []).slice(1),
        { day: '2026-01-01', tokensByRole: {}, tokensByModelTier: {}, unmeasuredRunCount: 0 },
      ];
      await route.fulfill({ response, json: body });
    });
    await page.goto('/analytics');
    await expect(page.locator('h1')).toHaveText('Cost & quality');
    const byRoleCard = page
      .locator('.bs-card')
      .filter({ has: page.getByText('Total tokens, by selected period', { exact: true }) });
    await expect(byRoleCard.locator('.bs-bars__x')).toHaveText(['builder', 'reviewer', 'planner']);
    await expect(page.locator('.bs-bars__track--empty').first()).toBeVisible();
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
        await growToPageHeight(page);
        await shoot(page, `analytics-${vpName}-${theme}`);
      });
    }
  }
});
