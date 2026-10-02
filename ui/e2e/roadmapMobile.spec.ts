import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot } from './helpers.js';

// DS4 S4 — the phone Roadmap (<=640px). phase-6b (demo-hub: epic-9/10/11,
// global-setup.ts) is the phase-mode fixture; epic-9 is the epic-mode
// fixture (past/current/upcoming waves, multiProjectFixture.ts).
test.describe('Roadmap mobile (DS4 S4)', () => {
  test('no sideways page scroll at 375px in phase mode', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/roadmap?phase=phase-6b');
    await expect(page.locator('.bs-roadmap-mobile__list')).toBeVisible();
    const pageScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const pageClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(pageScrollWidth).toBeLessThanOrEqual(pageClientWidth + 1);
  });

  test('no sideways page scroll at 375px in epic mode', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/roadmap?epic=epic-9');
    await expect(page.locator('.eblock')).toBeVisible();
    const pageScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const pageClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(pageScrollWidth).toBeLessThanOrEqual(pageClientWidth + 1);
  });

  test('tapping a phase-mode row switches to epic mode and updates the URL (R6)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/roadmap?phase=phase-6b');
    const row = page.locator('.bs-roadmap-mobile__row', { hasText: 'epic-9' });
    await expect(row).toBeVisible();
    await row.click();

    await expect(page).toHaveURL(/[?&]epic=epic-9\b/);
    await expect(page.locator('.eblock')).toHaveAttribute('aria-label', 'Epic epic-9');
  });

  test('the back link in epic mode returns to phase mode (R1)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/roadmap?epic=epic-9');
    const back = page.locator('.bs-roadmap-mobile__back');
    await expect(back).toBeVisible();
    await back.click();

    await expect(page).toHaveURL(/[?&]phase=phase-6b\b/);
    await expect(page.locator('.bs-roadmap-mobile__list')).toBeVisible();
  });

  test('the phase picker Select switches phases without the swimlane (R4)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/roadmap?phase=phase-6b');
    await expect(page.locator('.rm-scroll')).toHaveCount(0);
    const select = page.getByLabel('Phase', { exact: true });
    await expect(select).toBeVisible();
    await select.selectOption('phase-7');

    // phase-7 has no epics (global-setup.ts), so the swimlane's own "Not
    // scheduled" date text never applies here — that text lives only in
    // RoadmapSwimlane.vue, which is hidden on phone. The phone EpicBlock
    // header name is the stable signal that the phase actually switched.
    await expect(page).toHaveURL(/[?&]phase=phase-7\b/);
    await expect(page.locator('.eblock')).toContainText('Phase 7');
    await expect(page.locator('.bs-roadmap-mobile__item')).toHaveCount(0);
  });

  test('no wave-task-card and no TaskPeekPanel dialog in compact epic mode (R3)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/roadmap?epic=epic-9');
    await expect(page.locator('.wave-list')).toBeVisible();
    await expect(page.locator('.wave-task-card')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('touch targets clear 44px at 375px: back link, phase Select, waves summary, epic row, plan-version Select', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/roadmap?phase=phase-6b');
    const phaseSelect = page.getByLabel('Phase', { exact: true });
    await expect(phaseSelect).toBeVisible();
    const phaseSelectBox = await phaseSelect.boundingBox();
    expect(phaseSelectBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    const summary = page.locator('.bs-roadmap-mobile__waves summary').first();
    await expect(summary).toBeVisible();
    const summaryBox = await summary.boundingBox();
    expect(summaryBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    // S4 fix round 1 #6 — the epic row button itself.
    const row = page.locator('.bs-roadmap-mobile__row').first();
    await expect(row).toBeVisible();
    const rowBox = await row.boundingBox();
    expect(rowBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await page.goto('/work/roadmap?epic=epic-9');
    const back = page.locator('.bs-roadmap-mobile__back');
    await expect(back).toBeVisible();
    const backBox = await back.boundingBox();
    expect(backBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    // S4 fix round 1 #6 — the epic-mode plan-version Select trigger.
    const planVersionSelect = page.getByLabel('Plan version', { exact: true });
    await expect(planVersionSelect).toBeVisible();
    const planVersionBox = await planVersionSelect.boundingBox();
    expect(planVersionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  // S4 fix round 1 #5 — a long epic id must ellipsis, not overflow the
  // page. Stubbed via route interception (not a fixture change) so the
  // shared multiProjectFixture.ts stays untouched.
  test('a long epic id ellipsizes without causing horizontal scroll at 375px', async ({ page }) => {
    const LONG_EPIC_ID =
      'epic-9-with-an-identifier-so-long-no-phone-screen-should-ever-have-to-fit-it-on-one-line';
    await page.route('**/api/roadmap**', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const milestone of body as Array<{ epicIds: string[] }>) {
        milestone.epicIds = milestone.epicIds.map((id) => (id === 'epic-9' ? LONG_EPIC_ID : id));
      }
      await route.fulfill({ response, json: body });
    });
    await page.route('**/api/flow**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('epic') === LONG_EPIC_ID) {
        url.searchParams.set('epic', 'epic-9');
        const response = await route.fetch({ url: url.toString() });
        const body = await response.json();
        await route.fulfill({ response, json: body });
        return;
      }
      await route.continue();
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/roadmap?phase=phase-6b');
    const row = page.locator('.bs-roadmap-mobile__row-id', { hasText: LONG_EPIC_ID });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('title', LONG_EPIC_ID);

    const pageScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const pageClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(pageScrollWidth).toBeLessThanOrEqual(pageClientWidth);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`screenshot phone phase mode/${theme}`, async ({ page }) => {
      await setTheme(page, theme);
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto('/work/roadmap?phase=phase-6b');
      await settleForShot(page, page.locator('.bs-roadmap-mobile__list'));
      await shoot(page, `work-roadmap-mobile-phase-${theme}`);
    });

    test(`screenshot phone epic mode/${theme}`, async ({ page }) => {
      await setTheme(page, theme);
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto('/work/roadmap?epic=epic-9');
      await settleForShot(page, page.locator('.wave-list'));
      await shoot(page, `work-roadmap-mobile-epic-${theme}`);
    });
  }
});
