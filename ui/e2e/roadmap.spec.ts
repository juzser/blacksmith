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

  // DS4 S4 — 480px is inside the phone breakpoint (<=640px), so the swimlane
  // and its sideways-scrolling `.rm-scroll` fallback no longer render at all:
  // the phone phase list replaces it outright (roadmapMobile.spec.ts covers
  // that list's own behavior; this just confirms the swap and the no-scroll
  // floor still hold at 480px specifically).
  test('at 480px the swimlane is replaced by the phone phase list, no sideways scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 480, height: 1024 });
    await page.goto('/work/roadmap');
    await expect(page.locator('.rm-scroll')).toHaveCount(0);
    await expect(page.locator('.bs-roadmap-mobile__list')).toBeVisible();
    const pageScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const pageClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(pageScrollWidth).toBeLessThanOrEqual(pageClientWidth + 1);
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

// DS4 S3 §4: `/flow` is retired outright. Both redirects go through the
// existing `legacyWorkRedirect()`, already proven generically elsewhere;
// this is the one assertion specific to Roadmap's own new destination.
test.describe('Roadmap: /flow retirement (ds4-s3-uiux-spec.md §4)', () => {
  test('/flow lands on /work/roadmap', async ({ page }) => {
    await page.goto('/flow');
    await expect(page).toHaveURL(/\/work\/roadmap$/);
  });

  test('/flow?epic=X lands on /work/roadmap?epic=X', async ({ page }) => {
    await page.goto('/flow?epic=epic-9');
    await expect(page).toHaveURL(/\/work\/roadmap\?epic=epic-9\b/);
  });
});

// DS4 S3 §1/§2/§3/§5: epic mode's WaveList, the peek, the "Show waves"
// toggle and the phone touch-target floor. epic-9 (multiProjectFixture.ts)
// is the fixture's past/current/upcoming target: task-1 and task-2 done
// (past waves), task-3 in progress (the current wave, with cards), task-4
// never dispatched (the upcoming wave).
test.describe('Roadmap: epic mode WaveList (ds4-s3-uiux-spec.md §1-3, §5)', () => {
  test('shows the past, current and upcoming waves', async ({ page }) => {
    await page.goto('/work/roadmap?epic=epic-9');
    await expect(page.locator('.eblock')).toHaveAttribute('aria-label', 'Epic epic-9');
    await expect(page.locator('.wave-list')).toBeVisible();

    await expect(page.locator('.wave.past')).toHaveCount(2);
    const current = page.locator('.wave.cur');
    await expect(current).toHaveCount(1);
    await expect(current.locator('.wave-task-card')).toHaveCount(1);
    await expect(page.locator('.wave.next')).toHaveCount(1);
    // Upcoming waves show no cards (spec §2).
    await expect(page.locator('.wave.next .wave-task-card')).toHaveCount(0);
  });

  test('clicking a wave card opens the peek; Esc returns focus to the card', async ({ page }) => {
    await page.goto('/work/roadmap?epic=epic-9');
    const card = page.locator('.wave-task-card').first();
    await expect(card).toBeVisible();
    await card.click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(card).toBeFocused();
  });

  // DS4 S4 R3 — at 375px WaveList renders compact (no cards), so the touch
  // floor is checked on the wave row itself instead of `.wave-task-card`.
  test('touch targets clear 44px at 375px: compact wave rows and the Select trigger', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/roadmap?epic=epic-9');
    const wave = page.locator('.wave').first();
    await expect(wave).toBeVisible();
    await expect(page.locator('.wave-task-card')).toHaveCount(0);

    for (const locator of [wave, page.getByLabel('Plan version', { exact: true })]) {
      const box = await locator.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`screenshot epic mode desktop/${theme}`, async ({ page }) => {
      await setTheme(page, theme);
      await page.setViewportSize(VIEWPORTS.desktop);
      await page.goto('/work/roadmap?epic=epic-9');
      await settleForShot(page, page.locator('.wave-list'));
      await shoot(page, `work-roadmap-epic-desktop-${theme}`);
    });
  }

  test('screenshot epic mode 768/light', async ({ page }) => {
    await setTheme(page, 'light');
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/work/roadmap?epic=epic-9');
    await settleForShot(page, page.locator('.wave-list'));
    await shoot(page, 'work-roadmap-epic-768-light');
  });
});

// DS4 S3 §2: phase mode's per-epic "Show waves" toggle — open by default on
// an In-progress epic, closed on Done/To do (phase-6b, global-setup.ts: an
// in-progress phase with demo-hub's epic-9/epic-10/epic-11).
test.describe('Roadmap: phase mode "Show waves" toggle (ds4-s3-uiux-spec.md §2, §5)', () => {
  test('flips aria-expanded and the WaveList with it', async ({ page }) => {
    await page.goto('/work/roadmap?phase=phase-6b');
    const esec9 = page.locator('.esec', { hasText: 'epic-9' });
    const toggle = esec9.locator('.linkbtn');

    // In progress -> open by default.
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(esec9.locator('.wave-list')).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(esec9.locator('.wave-list')).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(esec9.locator('.wave-list')).toBeVisible();
  });

  // DS4 S4 — at 375px phase mode renders the phone stacked list instead of
  // `.esec`/`.linkbtn` (roadmapMobile.spec.ts), so the floor here moves to
  // the row that replaces the toggle.
  test('touch target: the phone row clears 44px at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/roadmap?phase=phase-6b');
    const row = page.locator('.bs-roadmap-mobile__row', { hasText: 'epic-9' });
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('screenshot phase waves desktop/light: one epic expanded, one collapsed', async ({
    page,
  }) => {
    await setTheme(page, 'light');
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/work/roadmap?phase=phase-6b');
    // epic-9 (In progress) defaults open; epic-10 (Done) defaults closed.
    await settleForShot(page, page.locator('.esec', { hasText: 'epic-9' }).locator('.wave-list'));
    await shoot(page, 'work-roadmap-phase-waves-desktop-light');
  });
});
