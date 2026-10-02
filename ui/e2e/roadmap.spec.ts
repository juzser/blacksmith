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

  test('renders all four bar states: past, now, upcoming, not-scheduled (fix round 1 #6)', async ({
    page,
  }) => {
    // epic-10 (both tasks finished) reads "past" independent of the clock.
    // epic-9 (task-3 still live) reads "now" once the clock sits at or after
    // its dispatch. epic-11 (dispatched last, never started relative to
    // "now") reads "upcoming" only before its own dispatch. The fixture
    // packs every event onto a single-second-per-event timeline
    // (fixtureClock.ts), so epic-9's dispatch is a handful of seconds before
    // epic-11's, not hours — the clock has to land strictly between the two,
    // not merely "24h before epic-11", or it also lands before epic-9's own
    // dispatch and reads epic-9 as "upcoming" too.
    const roadmap = await page.request.get('/api/roadmap?project=demo-hub');
    const milestones: Array<{ epics: Array<{ epicId: string; startedAt: string | null }> }> =
      await roadmap.json();
    const epic11 = milestones.flatMap((m) => m.epics).find((e) => e.epicId === 'epic-11');
    if (!epic11?.startedAt) throw new Error('expected epic-11 to have a startedAt');
    const justBeforeEpic11 = new Date(new Date(epic11.startedAt).getTime() - 500);
    await page.clock.setFixedTime(justBeforeEpic11);

    // Unscoped: demo-hub's own three epics cover past/now/upcoming, but none
    // of them is ever `not-scheduled` — that state only exists on envkit's
    // phase-7 (no tasks at all), which only renders on the all-projects view.
    await page.goto('/work/roadmap');
    const pastBar = page.locator('.lrow.sub', { hasText: 'epic-10' }).locator('.lbar.past');
    await expect(pastBar).toBeVisible();
    await expect(
      page.locator('.lrow.sub', { hasText: 'epic-9' }).locator('.lbar.now'),
    ).toBeVisible();
    await expect(
      page.locator('.lrow.sub', { hasText: 'epic-11' }).locator('.lbar.up'),
    ).toBeVisible();
    await expect(page.getByText('Not scheduled').first()).toBeVisible();

    // Fix round 2 #2: a done/past bar must read as filled (done), not as an
    // empty, near-transparent box that looks unstarted.
    const pastStyle = await pastBar.evaluate((el) => {
      const style = getComputedStyle(el);
      return { backgroundColor: style.backgroundColor, opacity: Number(style.opacity) };
    });
    expect(pastStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(pastStyle.opacity).toBeLessThan(1);
  });

  test('no sideways page scroll at 390px on /work/roadmap', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/work/roadmap');
    const pageScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const pageClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(pageScrollWidth).toBeLessThanOrEqual(pageClientWidth + 1);
  });

  test('at 480px only the swimlane scrolls sideways, not the page', async ({ page }) => {
    // Fix round 1 #9 dropped `.lane`'s min-width from 720px to 520px (spec
    // and mock both say 520px). `.rm-scroll` only overflows once its own
    // content width drops below that floor, which no longer happens at
    // 768px (the old viewport here) — that leaves ~656px of room, comfortably
    // above 520px. 480px leaves less room than the floor needs, which is what
    // this test is actually for: the lane overflowing while the page itself
    // does not.
    await page.setViewportSize({ width: 480, height: 1024 });
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
