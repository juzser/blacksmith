import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Roadmap', () => {
  test('selecting a phase row updates the URL and marks it current', async ({ page }) => {
    await page.goto('/work/roadmap');
    await expect(page.locator('h1')).toHaveText('Work');
    const phase7 = page.getByRole('button', { name: /Phase 7 — envkit bootstrap/ });
    await phase7.click();
    await expect(page).toHaveURL(/[?&]phase=phase-7\b/);
    await expect(phase7).toHaveAttribute('aria-current', 'true');
  });

  test('a phase with no scheduled dates shows "Not scheduled" (phase-7 has no tasks)', async ({
    page,
  }) => {
    await page.goto('/work/roadmap?phase=phase-7');
    await expect(page.getByText('Not scheduled').first()).toBeVisible();
  });

  test('swimlane rows meet the 44px touch-target floor', async ({ page }) => {
    await page.goto('/work/roadmap');
    const row = page.locator('.lrow').first();
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('at 768px only the swimlane scrolls sideways, not the page', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/work/roadmap');
    await expect(page.locator('.rm-scroll')).toBeVisible();
    const pageScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const pageClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    // The document itself never grows wider than its viewport — only the
    // `.rm-scroll` region inside the swimlane is allowed to overflow.
    expect(pageScrollWidth).toBeLessThanOrEqual(pageClientWidth + 1);
    const laneOverflows = await page.evaluate(() => {
      const el = document.querySelector('.rm-scroll');
      return el ? el.scrollWidth > el.clientWidth : false;
    });
    expect(laneOverflows).toBe(true);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`screenshot phase desktop/${theme}`, async ({ page }) => {
      await setTheme(page, theme);
      await page.setViewportSize(VIEWPORTS.desktop);
      await page.goto('/work/roadmap');
      await expect(page.locator('h1')).toHaveText('Work');
      await settleForShot(page, page.locator('.lane').first());
      await shoot(page, `work-roadmap-phase-desktop-${theme}`);
    });
  }

  // No 390px mobile screenshot here (the old work-roadmap-mobile-{light,dark}
  // baselines are deleted, not renamed): below 640px this slice only ships the
  // swimlane's own sideways-scroll fallback, and freezing that into a baseline
  // would just lock in a shell S4's real phone layout is meant to replace. The
  // 768px shot below is what exercises this slice's phone-direction behavior.
  test('screenshot swimlane 768/light', async ({ page }) => {
    await setTheme(page, 'light');
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/work/roadmap');
    await expect(page.locator('h1')).toHaveText('Work');
    await settleForShot(page, page.locator('.lane').first());
    await shoot(page, 'work-roadmap-swimlane-768-light');
  });
});
