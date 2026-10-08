import type { Page } from '@playwright/test';
import { stubActiveScope } from './activeScopeStub.js';
import { expect, test } from './harness.js';
import {
  dropRoutes,
  growToPageHeight,
  setTheme,
  settleForShot,
  shoot,
  VIEWPORTS,
} from './helpers.js';

// Route proxies that call route.fetch() must not outlive their test.
test.afterEach(async ({ page }) => dropRoutes(page));

// Several roles (not just the base fixture's single "Builder"), plus an
// unmeasured run and a zero-token day — both screenshot baselines and the
// "more than two role categories" assertion test share this one override
// (DS7 PR2 round 4 defect 1), so the charts, the table and the phone role
// list all show more than one row instead of baking a one-role screenshot.
async function withMultiRoleFixture(page: Page): Promise<void> {
  await page.route('**/api/analytics*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.tokensByRoleAndModelTier = [
      {
        role: 'coder',
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
        unmeasuredRunCount: 2,
      },
    ];
    // Explicit, not derived from the base fixture's own days: the daily
    // series must sum exactly to the by-role totals above (Builder 4200,
    // Code reviewer 1800, Planner 600, overall 6600), with one day entirely
    // empty so the zero-token track has something real to prove (defect 8).
    body.tokensByDay = [
      { day: '2026-01-01', tokensByRole: {}, tokensByModelTier: {}, unmeasuredRunCount: 0 },
      {
        day: '2026-01-02',
        tokensByRole: { coder: 2000, reviewer: 900, planner: 300 },
        tokensByModelTier: { mid: 2900, high: 300 },
        unmeasuredRunCount: 1,
      },
      {
        day: '2026-01-03',
        tokensByRole: { coder: 2200, reviewer: 900, planner: 300 },
        tokensByModelTier: { mid: 3100, high: 300 },
        unmeasuredRunCount: 1,
      },
    ];
    await route.fulfill({ response, json: body });
  });
}

// S9: Cost & quality follows the Active/All scope. The e2e server cannot read
// live CLI sessions (unmeasured), so the older tests run under a measured
// answer naming every home-store session the fixture seeds.
const homeSessions = (...ids: string[]) => ids.map((sessionId) => ({ storeId: 'home', sessionId }));

test.describe('Analytics', () => {
  test.beforeEach(async ({ page }) => {
    await stubActiveScope(page, [], {
      factorySessions: homeSessions('sess-fixture', 'sess-multiproject-fixture'),
    });
  });

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
    await withMultiRoleFixture(page);
    await page.goto('/analytics');
    await expect(page.locator('h1')).toHaveText('Cost & quality');
    const byRoleCard = page
      .locator('.bs-card')
      .filter({ has: page.getByText('Total tokens, by selected period', { exact: true }) });
    // The Not-measured row shares the same label class but reads "Not
    // measured" (short label, no wrap) — excluded here so this only asserts
    // the three real role rows. The run count lives in the sr-only table.
    await expect(
      byRoleCard.locator('.bs-analytics-page__hlabel').filter({ hasNotText: 'Not measured' }),
    ).toHaveText(['Builder', 'Code reviewer', 'Planner']);
    await expect(byRoleCard.locator('.bs-analytics-page__hlabel').last()).toHaveText(
      'Not measured',
    );
    await expect(byRoleCard).toContainText('runs');
    await expect(page.locator('.bs-bars__track--empty').first()).toBeVisible();
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await withMultiRoleFixture(page);
        await page.goto('/analytics');
        await expect(page.locator('h1')).toHaveText('Cost & quality');
        // Phone drops the charts/table (defect 6) — settle on the phone-only
        // metrics grid there instead of a desktop-only chart title.
        const marker =
          vpName === 'mobile'
            ? page.locator('.bs-analytics-page__phone-metrics')
            : page.locator('.bs-card__title').getByText('Tokens per day', { exact: true });
        await settleForShot(page, marker);
        await growToPageHeight(page);
        await shoot(page, `analytics-${vpName}-${theme}`);
      });
    }
  }

  // The second-opinion rate is null with no verdicts and a real 0 when every
  // verdict disagreed. The page must show "Not enough data yet" and no ring for
  // the first, and a 0% ring for the second, on both widths.
  const providerRow = (verdicts: number, agreementRate: number | null) => ({
    provider: 'codex',
    runs: verdicts,
    verdicts,
    agreementRate,
    latencySamples: 0,
    meanLatencyMs: null,
    schemaFailureRate: 0,
    transportFailureRate: 0,
    failuresByCode: {},
  });
  async function stubProviderAgreement(page: Page, rows: unknown[]): Promise<void> {
    await page.route('**/api/analytics*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.providerAgreement = rows;
      await route.fulfill({ response, json: body });
    });
  }

  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['phone', { width: 375, height: 812 }],
  ] as const) {
    const scope = (page: Page) =>
      name === 'desktop'
        ? page.locator('.bs-card').filter({ hasText: 'Second-opinion reviewers' })
        : page
            .locator('.bs-analytics-page__phone-stat')
            .filter({ hasText: 'Second-opinion agreed' });

    test(`${name}: no second-opinion review shows not-enough-data and no ring`, async ({
      page,
    }) => {
      await stubProviderAgreement(page, []);
      await page.setViewportSize(viewport);
      await page.goto('/analytics');
      const box = scope(page);
      await expect(box).toContainText('Not enough data yet');
      await expect(box.getByRole('img')).toHaveCount(0);
      await expect(box).not.toContainText('0%');
      if (name === 'desktop') {
        await expect(box).toContainText('No second-opinion reviews in this period.');
      }
    });

    test(`${name}: second-opinion reviews that all disagreed show a 0% ring`, async ({ page }) => {
      await stubProviderAgreement(page, [providerRow(4, 0)]);
      await page.setViewportSize(viewport);
      await page.goto('/analytics');
      const box = scope(page);
      await expect(
        box.getByRole('img', { name: /^0% .*agreed with the main reviewer$/ }),
      ).toBeVisible();
      await expect(box).not.toContainText('Not enough data yet');
      if (name === 'desktop') {
        await expect(box).toContainText('agreed with the main reviewer.');
        await expect(box).not.toContainText('No second-opinion reviews in this period.');
      }
    });
  }
});

// S9 (ds-spec.md §4.4 Scope).
test.describe('Cost & quality follows Active/All (S9)', () => {
  const analyticsRequests = (page: Page) => {
    const urls: URL[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname === '/api/analytics') urls.push(u);
    });
    return urls;
  };

  test("Active sends the scope's sessions; All sends none", async ({ page }) => {
    await stubActiveScope(page, [], { factorySessions: homeSessions('sess-fixture') });
    const urls = analyticsRequests(page);
    await page.goto('/analytics');
    await expect(
      page.locator('.bs-card__title').getByText('Tokens per day', { exact: true }),
    ).toBeVisible();
    expect(
      urls.every((u) => u.searchParams.getAll('sessions').join() === 'home/sess-fixture'),
    ).toBe(true);
    expect(urls.every((u) => u.searchParams.get('stores') === 'all')).toBe(true);
    await page.getByRole('link', { name: 'All', exact: true }).click();
    await expect(page).toHaveURL(/scope=all/);
    await expect.poll(() => urls.some((u) => !u.searchParams.has('sessions'))).toBe(true);
  });

  // A response that was still in flight when the scope or period changed must
  // not overwrite the newer answer. `hold` picks the request to park; it is
  // answered "no usage" after `release()`, every other request with real usage.
  async function holdAnalytics(page: Page, hold: (u: URL) => boolean) {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = false;
    let settled = Promise.resolve();
    await page.route('**/api/analytics*', async (route) => {
      const isHeld = hold(new URL(route.request().url()));
      const response = await route.fetch();
      const body = await response.json();
      body.tokensByDay = isHeld
        ? []
        : [
            {
              day: '2026-01-02',
              tokensByRole: { coder: 100 },
              tokensByModelTier: { mid: 100 },
              unmeasuredRunCount: 0,
            },
          ];
      if (isHeld) {
        started = true;
        settled = gate;
        await gate;
      }
      await route.fulfill({ response, json: body });
    });
    return { release, started: () => started, settled: () => settled };
  }

  test('a held All answer landing after the switch to Active does not replace it', async ({
    page,
  }) => {
    await stubActiveScope(page, [], { factorySessions: homeSessions('sess-fixture') });
    const h = await holdAnalytics(page, (u) => !u.searchParams.has('sessions'));
    await page.goto('/analytics?scope=all');
    await expect.poll(h.started).toBe(true);
    await page
      .getByRole('navigation', { name: 'Activity scope' })
      .getByRole('link', { name: 'Active', exact: true })
      .click();
    await expect(
      page
        .locator('.bs-card')
        .filter({ hasText: 'Tokens per day' })
        .getByText('Nothing has run in this period yet.'),
    ).toHaveCount(0);
    await expect(page.locator('.bs-card__title').getByText('Tokens per day')).toBeVisible();
    h.release();
    await h.settled();
    await page.waitForTimeout(300);
    await expect(
      page
        .locator('.bs-card')
        .filter({ hasText: 'Tokens per day' })
        .getByText('Nothing has run in this period yet.'),
    ).toHaveCount(0);
  });

  test('a held answer for the old period does not replace the new period', async ({ page }) => {
    await stubActiveScope(page, [], { factorySessions: homeSessions('sess-fixture') });
    const h = await holdAnalytics(page, (u) => u.searchParams.get('period') === '30d');
    await page.goto('/analytics');
    await expect.poll(h.started).toBe(true);
    await page.getByRole('button', { name: '7 days' }).click();
    await expect(
      page
        .locator('.bs-card')
        .filter({ hasText: 'Tokens per day' })
        .getByText('Nothing has run in this period yet.'),
    ).toHaveCount(0);
    await expect(page.locator('.bs-card__title').getByText('Tokens per day')).toBeVisible();
    h.release();
    await h.settled();
    await page.waitForTimeout(300);
    await expect(
      page
        .locator('.bs-card')
        .filter({ hasText: 'Tokens per day' })
        .getByText('Nothing has run in this period yet.'),
    ).toHaveCount(0);
  });

  test('nothing live: only the edge line, no request, no charts or zero totals', async ({
    page,
  }) => {
    await stubActiveScope(page, [], { liveSessions: 0 });
    const urls = analyticsRequests(page);
    await page.goto('/analytics');
    await expect(page.getByText('Nothing is active right now.')).toBeVisible();
    await expect(page.locator('.bs-card')).toHaveCount(0);
    await expect(page.locator('.bs-analytics-page__phone-metrics')).toHaveCount(0);
    expect(urls).toHaveLength(0);
  });

  test('none on an epic, and no other-store line is drawn', async ({ page }) => {
    await stubActiveScope(page, [], {
      liveSessions: 1,
      unlinkedSessions: 1,
      projects: [{ storeId: 'store-b', project: 'project-b', liveSessions: 1, agentsWorking: 0 }],
    });
    await page.goto('/analytics');
    await expect(page.getByText('1 live session, none on an epic')).toBeVisible();
    await expect(page.getByText('in another store')).toHaveCount(0);
  });

  test('unmeasured: fetches All and says live sessions cannot be read', async ({ page }) => {
    await stubActiveScope(page, [], { measured: false });
    const urls = analyticsRequests(page);
    await page.goto('/analytics');
    await expect(page.getByText("Live sessions can't be read here")).toBeVisible();
    await expect(
      page.locator('.bs-card__title').getByText('Tokens per day', { exact: true }),
    ).toBeVisible();
    expect(urls.every((u) => !u.searchParams.has('sessions'))).toBe(true);
  });

  test('Active holds while the scope read is in flight: no analytics request yet', async ({
    page,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await page.route('**/api/active-scope*', async (route) => {
      await gate;
      await route.fulfill({
        json: {
          measured: true,
          readAt: '2026-10-07T12:00:00.000Z',
          liveSessions: 1,
          unlinkedSessions: 0,
          projects: [],
          epics: [],
          factorySessions: homeSessions('sess-fixture'),
        },
      });
    });
    const urls = analyticsRequests(page);
    await page.goto('/analytics');
    await page.waitForTimeout(400);
    expect(urls).toHaveLength(0);
    release();
    await expect.poll(() => urls.length).toBeGreaterThan(0);
    expect(
      urls.every((u) => u.searchParams.getAll('sessions').join() === 'home/sess-fixture'),
    ).toBe(true);
  });

  test('an explicit ?session= wins: no sessions param, no toggle', async ({ page }) => {
    await stubActiveScope(page, [], { factorySessions: homeSessions('sess-multiproject-fixture') });
    const urls = analyticsRequests(page);
    await page.goto('/analytics?session=sess-fixture');
    await expect(
      page.locator('.bs-card__title').getByText('Tokens per day', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Activity scope' })).toHaveCount(0);
    expect(urls.every((u) => !u.searchParams.has('sessions'))).toBe(true);
    expect(urls.every((u) => !u.searchParams.has('stores'))).toBe(true);
  });

  test('phone 375: the toggle clears 44px and the toolbar does not scroll sideways', async ({
    page,
  }) => {
    await stubActiveScope(page, [], { factorySessions: homeSessions('sess-fixture') });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/analytics');
    const toggle = page.getByRole('navigation', { name: 'Activity scope' });
    await expect(toggle).toBeVisible();
    const tab = toggle.getByRole('link', { name: 'All', exact: true });
    expect((await tab.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test('screenshot active desktop light', async ({ page }) => {
    await stubActiveScope(page, [], { factorySessions: homeSessions('sess-fixture') });
    await setTheme(page, 'light');
    await page.setViewportSize(VIEWPORTS.desktop);
    await withMultiRoleFixture(page);
    await page.goto('/analytics');
    await settleForShot(
      page,
      page.locator('.bs-card__title').getByText('Tokens per day', { exact: true }),
    );
    await growToPageHeight(page);
    await shoot(page, 'analytics-active-desktop-light');
  });

  test('screenshot active phone light', async ({ page }) => {
    await stubActiveScope(page, [], { factorySessions: homeSessions('sess-fixture') });
    await setTheme(page, 'light');
    await page.setViewportSize({ width: 375, height: 812 });
    await withMultiRoleFixture(page);
    await page.goto('/analytics');
    await settleForShot(page, page.locator('.bs-analytics-page__phone-metrics'));
    await growToPageHeight(page);
    await shoot(page, 'analytics-active-phone-light');
  });

  test('screenshot nothing active desktop light', async ({ page }) => {
    await stubActiveScope(page, [], { liveSessions: 0 });
    await setTheme(page, 'light');
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/analytics');
    await settleForShot(page, page.getByText('Nothing is active right now.'));
    await shoot(page, 'analytics-nothing-active-desktop-light');
  });
});
