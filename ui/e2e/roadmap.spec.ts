import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';
import { stubWindowRoadmap, WINDOW_ROADMAP } from './roadmapWindowFixture.js';

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
      page.locator('.lrow.sub', { hasText: 'epic-9' }).locator('.lbar:not(.past)'),
    ).toBeVisible();
    await expect(
      page.locator('.lrow.sub', { hasText: 'epic-11' }).locator('.lbar:not(.past)'),
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

  for (const theme of ['light', 'dark'] as const) {
    test(`the empty track stays distinct on a selected and a hovered row (${theme})`, async ({
      page,
    }) => {
      await setTheme(page, theme);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('/work/roadmap?phase=phase-7');
      const selected = page.locator('.lrow.sel').first();
      await expect(selected).toBeVisible();
      const fills = (row: ReturnType<Page['locator']>) =>
        row.evaluate((el) => {
          const track = el.querySelector('.track');
          if (!track) throw new Error('row has no .track');
          return {
            row: getComputedStyle(el).backgroundColor,
            track: getComputedStyle(track).backgroundColor,
          };
        });
      // Summed per-channel distance; the unfixed light selected row (#f4f4f5
      // vs #f7f7f8) sits at 9, which the eye cannot tell apart.
      const gap = (a: string, b: string) => {
        const rgb = (c: string) => (c.match(/\d+/g) ?? []).slice(0, 3).map(Number);
        const [x, y] = [rgb(a), rgb(b)];
        return x.reduce((n, v, i) => n + Math.abs(v - (y[i] ?? 0)), 0);
      };
      const sel = await fills(selected);
      expect(
        gap(sel.track, sel.row),
        `selected row fill ${sel.row}, track ${sel.track}`,
      ).toBeGreaterThanOrEqual(10);

      const other = page.locator('.lrow:not(.sel)').first();
      await other.hover();
      await page.waitForTimeout(200);
      const hov = await fills(other);
      expect(
        gap(hov.track, hov.row),
        `hovered row fill ${hov.row}, track ${hov.track}`,
      ).toBeGreaterThanOrEqual(10);

      await selected.hover();
      await page.waitForTimeout(200);
      const both = await fills(selected);
      expect(
        gap(both.track, both.row),
        `selected+hovered row fill ${both.row}, track ${both.track}`,
      ).toBeGreaterThanOrEqual(10);
    });
  }

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

// DS4 S5c — server-derived epic header: the stacked status bar, the "Epic
// started from" quote, and the Copy-id/Open-PR icon buttons. epic-9 is the
// fixture's one epic with a recorded user_prompt and an integration PR
// (multiProjectFixture.ts).
test.describe('Roadmap: epic header server reads (DS4 S5c)', () => {
  test('shows the stacked status bar, the sourcePrompt quote and both icon buttons', async ({
    page,
  }) => {
    await page.goto('/work/roadmap?epic=epic-9');
    const head = page.locator('.esec-head');

    await expect(head.getByRole('button', { name: 'Copy epic id' })).toBeVisible();
    await expect(head.getByRole('link', { name: 'Open integration PR on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/example-org/demo-hub/pull/42',
    );

    await expect(page.locator('.bs-pbar').first()).toBeVisible();

    const quote = page.locator('.bs-request-quote');
    await expect(quote).toBeVisible();
    await expect(quote.locator('.bs-request-quote__label')).toHaveText('Epic started from');
    await expect(quote.locator('.bs-request-quote__text')).toContainText(
      'Build an employee directory',
    );
    // DS4 S5c fix round 1, fix 2 — this quote is short enough not to clamp
    // at 3 lines, so "Show more" must not render.
    await expect(quote.locator('.bs-request-quote__toggle')).toHaveCount(0);
  });

  test('header order: id, Copy, PR, project chip, status Tag (DS4 S5c fix round 1, fix 6)', async ({
    page,
  }) => {
    await page.goto('/work/roadmap?epic=epic-9');
    const head = page.locator('.esec-head');
    const chipIndex = await head
      .locator('.eh-project')
      .evaluate((el) => Array.from(el.parentElement?.children ?? []).indexOf(el));
    const tagIndex = await head
      .locator('.bs-tag')
      .last()
      .evaluate((el) => Array.from(el.parentElement?.children ?? []).indexOf(el));
    expect(chipIndex).toBeLessThan(tagIndex);
  });

  test('desktop: the plan-version Select sits on the header row, compact (DS4 S5c fix round 2)', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/work/roadmap?epic=epic-9');
    const head = page.locator('.esec-head');
    const epicId = head.locator('b').first();
    const select = page.getByLabel('Plan version', { exact: true });

    await expect(select).toBeVisible();
    const [headBox, idBox, selectBox] = await Promise.all([
      head.boundingBox(),
      epicId.boundingBox(),
      select.boundingBox(),
    ]);

    // Same row as the epic id: their vertical spans overlap (a dropped-below
    // row, by contrast, starts at or after the id row's bottom edge).
    const idTop = idBox?.y ?? 0;
    const idBottom = idTop + (idBox?.height ?? 0);
    const selectTop = selectBox?.y ?? Number.POSITIVE_INFINITY;
    const selectBottom = selectTop + (selectBox?.height ?? 0);
    expect(selectTop).toBeLessThan(idBottom);
    expect(selectBottom).toBeGreaterThan(idTop);
    expect(selectBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThan((headBox?.width ?? 0) / 2);
  });

  test('copying the epic id flips the button label to "Copied"', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/work/roadmap?epic=epic-9');
    const copyBtn = page.locator('.esec-head').getByRole('button', { name: 'Copy epic id' });
    await copyBtn.click();
    await expect(page.locator('.esec-head').getByRole('button', { name: 'Copied' })).toBeVisible();
  });

  test('touch targets clear 44px at 375px: Copy id, Open PR icon buttons and the quote link, no horizontal scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/roadmap?epic=epic-9');
    const head = page.locator('.esec-head');

    for (const locator of [
      head.getByRole('button', { name: 'Copy epic id' }),
      head.getByRole('link', { name: 'Open integration PR on GitHub' }),
      // DS4 S5c fix round 1, fix 1 — "View in timeline" (epic-9's quote is
      // short, so only the link renders here; the toggle gets its own check
      // against a long, clamped quote on Task Detail).
      page.locator('.bs-request-quote__link'),
    ]) {
      const box = await locator.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`screenshot epic header server reads desktop/${theme}`, async ({ page }) => {
      await setTheme(page, theme);
      await page.setViewportSize(VIEWPORTS.desktop);
      await page.goto('/work/roadmap?epic=epic-9');
      await settleForShot(page, page.locator('.esec-head'));
      await shoot(page, `work-roadmap-epic-header-desktop-${theme}`);
    });
  }
});

// DS4 S3 §2: phase mode's per-epic "Show waves" toggle — open by default on
// an In-progress epic, closed on Done/Todo (phase-6b, global-setup.ts: an
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

// UI spec Part 2 — one section per project, each windowed to 1 lane before
// the current one, the current one, and 2 after. roadmapWindowFixture.ts
// stubs project-a (8 phases, phase-4 current) and project-b (2 phases).
test.describe('Roadmap window (spec Part 2)', () => {
  const sectionFor = (page: Page, project: string) =>
    page
      .locator('.rm-section')
      .filter({ has: page.locator('.rm-section__head', { hasText: project }) });
  const earlierToggle = (page: Page) =>
    page.locator('button[aria-controls="rm-window-project-a-earlier"]');
  const laterToggle = (page: Page) =>
    page.locator('button[aria-controls="rm-window-project-a-later"]');
  const phaseNames = (page: Page, project: string) =>
    sectionFor(page, project).locator('.lrow:not(.sub) .lname');

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await stubWindowRoadmap(page);
  });

  test('one section per project, newest activity first, each with its done count', async ({
    page,
  }) => {
    await page.goto('/work/roadmap');
    const heads = page.locator('.rm-section__head');
    await expect(heads).toHaveCount(2);
    await expect(heads.nth(0)).toContainText('project-a');
    await expect(heads.nth(0)).toContainText('3 of 8 phases done');
    await expect(heads.nth(1)).toContainText('project-b');
    await expect(heads.nth(1)).toContainText('1 of 2 phases done');
    await expect(page.locator('h2.rm-section__head')).toHaveCount(2);
  });

  test('the disclosure buttons clear 24px on desktop', async ({ page }) => {
    await page.goto('/work/roadmap');
    const box = await earlierToggle(page).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  });

  test('only the window is in the DOM, with the current lane tagged', async ({ page }) => {
    await page.goto('/work/roadmap');
    await expect(phaseNames(page, 'project-a')).toHaveText([
      'Phase 3',
      'Phase 4',
      'Phase 5',
      'Phase 6',
    ]);
    const current = sectionFor(page, 'project-a').locator('[aria-current="step"]');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText('Phase 4');
    await expect(current.locator('.bs-tag')).toHaveText('Current');

    // project-b: phase-9 done, phase-10 current, nothing hidden either side.
    await expect(phaseNames(page, 'project-b')).toHaveText(['Phase 9', 'Phase 10']);
    await expect(sectionFor(page, 'project-b').locator('[aria-current="step"]')).toContainText(
      'Phase 10',
    );
    await expect(sectionFor(page, 'project-b').locator('.rm-window__more')).toHaveCount(0);
  });

  test('the earlier and later disclosures expand in place and flip to "Show fewer"', async ({
    page,
  }) => {
    await page.goto('/work/roadmap');
    const earlier = earlierToggle(page);
    const later = laterToggle(page);
    await expect(earlier).toHaveText('Show 2 earlier lanes');
    await expect(earlier).toHaveAttribute('aria-expanded', 'false');
    await expect(later).toHaveText('Show 2 later lanes');
    await expect(later).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#rm-window-project-a-earlier .lrow')).toHaveCount(0);

    await earlier.click();
    await expect(earlier).toHaveAttribute('aria-expanded', 'true');
    await expect(earlier).toHaveText('Show fewer earlier lanes');
    await expect(earlier).toBeFocused();
    await expect(phaseNames(page, 'project-a')).toHaveText([
      'Phase 1',
      'Phase 2',
      'Phase 3',
      'Phase 4',
      'Phase 5',
      'Phase 6',
    ]);
    await expect(page.locator('#rm-window-project-a-earlier .lrow')).toHaveCount(2);

    await later.click();
    await expect(later).toHaveAttribute('aria-expanded', 'true');
    await expect(later).toHaveText('Show fewer later lanes');
    await expect(phaseNames(page, 'project-a')).toHaveCount(8);

    await earlier.click();
    await expect(earlier).toHaveText('Show 2 earlier lanes');
    await expect(phaseNames(page, 'project-a')).toHaveText([
      'Phase 3',
      'Phase 4',
      'Phase 5',
      'Phase 6',
      'Phase 7',
      'Phase 8',
    ]);
  });

  test('the expand state survives a reload in the same tab', async ({ page }) => {
    await page.goto('/work/roadmap');
    await laterToggle(page).click();
    await expect(laterToggle(page)).toHaveAttribute('aria-expanded', 'true');

    await page.reload();
    await expect(laterToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(earlierToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(phaseNames(page, 'project-a')).toHaveText([
      'Phase 3',
      'Phase 4',
      'Phase 5',
      'Phase 6',
      'Phase 7',
      'Phase 8',
    ]);
  });

  test('a ?phase= deep link into a hidden lane opens that side and shows the row', async ({
    page,
  }) => {
    await page.goto('/work/roadmap?phase=phase-1');
    await expect(earlierToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(laterToggle(page)).toHaveAttribute('aria-expanded', 'false');
    const row = sectionFor(page, 'project-a').locator('.lrow[aria-current="true"]');
    await expect(row).toContainText('Phase 1');
    await expect(row).toBeInViewport();
    await expect(row).toBeFocused();
    // Selecting a lane never moves the Current marker.
    await expect(sectionFor(page, 'project-a').locator('[aria-current="step"]')).toContainText(
      'Phase 4',
    );
  });

  test('a reload of the data does not reopen a side the user collapsed after a deep link', async ({
    page,
  }) => {
    await page.goto('/work/roadmap?phase=phase-1');
    await expect(earlierToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await earlierToggle(page).click();
    await expect(earlierToggle(page)).toHaveAttribute('aria-expanded', 'false');

    // Re-run load() without touching ?phase=: a project scope change does it.
    const reloaded = page.waitForResponse(
      (r) => r.url().includes('/api/roadmap') && r.url().includes('project=project-a'),
    );
    await page.evaluate(() => {
      type Host = {
        __vue_app__: { config: { globalProperties: { $router: { push(l: unknown): void } } } };
      };
      const host = document.querySelector('#app') as unknown as Host;
      host.__vue_app__.config.globalProperties.$router.push({
        path: '/work/roadmap',
        query: { phase: 'phase-1', project: 'project-a' },
      });
    });
    await reloaded;
    await expect(page).toHaveURL(/project=project-a/);
    await expect(earlierToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.lname', { hasText: /^Phase 1$/ })).toHaveCount(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`screenshot window desktop/${theme}: earlier side expanded`, async ({ page }) => {
      await setTheme(page, theme);
      await page.goto('/work/roadmap');
      await earlierToggle(page).click();
      await settleForShot(page, page.locator('#rm-window-project-a-earlier .lrow').first());
      await shoot(page, `work-roadmap-window-desktop-${theme}`);
    });
  }
});

// Roadmap label and axis geometry (visual fix round 2): the fixture's long
// "Phase 6b — Remaining pages" lane is the current one, so its name sits beside
// the "Current" Tag. Every track column must start at the same x as the axis.
test.describe('Roadmap: label column and shared track column', () => {
  for (const width of [1280, 768]) {
    test.describe(`at ${width}px`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width, height: 1024 });
        await page.goto('/work/roadmap');
        await expect(page.locator('.lrow').first()).toBeVisible();
      });

      test('the current lane name is not truncated beside its Tag', async ({ page }) => {
        const head = page
          .locator('.lrow:not(.sub) .lhead')
          .filter({ has: page.locator('.bs-tag', { hasText: 'Current' }) })
          .first();
        const name = head.locator('.lname');
        await expect(name).toContainText('Remaining pages');
        await expect(head.locator('.bs-tag')).toBeVisible();
        const fit = await name.evaluate((el) => ({
          sw: el.scrollWidth,
          cw: el.clientWidth,
          sh: el.scrollHeight,
          ch: el.clientHeight,
        }));
        expect(fit.sw).toBeLessThanOrEqual(fit.cw);
        expect(fit.sh).toBeLessThanOrEqual(fit.ch);
        const lhead = await head.boundingBox();
        const tag = await head.locator('.bs-tag').boundingBox();
        expect((tag?.x ?? 0) + (tag?.width ?? 0)).toBeLessThanOrEqual(
          (lhead?.x ?? 0) + (lhead?.width ?? 0) + 1,
        );
      });

      test('every track starts at the axis and now-line column x', async ({ page }) => {
        const axis = await page.locator('.months-row').first().boundingBox();
        const nowCol = await page.locator('.now-track__col').first().boundingBox();
        expect(axis).not.toBeNull();
        const tracks = await page.locator('.lrow .track').all();
        expect(tracks.length).toBeGreaterThan(1);
        expect(await page.locator('.lrow.sub').count()).toBeGreaterThan(0);
        for (const t of tracks) {
          const box = await t.boundingBox();
          expect(Math.abs((box?.x ?? 0) - (axis?.x ?? 0))).toBeLessThanOrEqual(1);
        }
        expect(Math.abs((nowCol?.x ?? 0) - (axis?.x ?? 0))).toBeLessThanOrEqual(1);
      });

      test('the epic row name is indented, regular weight and subtle (mock .lrow.sub .lname)', async ({
        page,
      }) => {
        test.skip(width !== 1280, 'desktop width only');
        const name = (sel: string) => page.locator(sel).first().locator('.lname').first();
        const read = (loc: ReturnType<Page['locator']>) =>
          loc.evaluate((el) => {
            const s = getComputedStyle(el);
            const root = getComputedStyle(document.documentElement);
            return {
              pad: s.paddingLeft,
              weight: s.fontWeight,
              color: s.color,
              text: root.getPropertyValue('--bs-text').trim(),
              subtle: root.getPropertyValue('--bs-text-subtle').trim(),
            };
          });
        const resolve = (v: string) =>
          page.evaluate((c) => {
            const d = document.createElement('div');
            d.style.color = c;
            document.body.append(d);
            const out = getComputedStyle(d).color;
            d.remove();
            return out;
          }, v);
        const epic = await read(name('.lrow.sub:not(.sel)'));
        expect(epic.pad).toBe('14px');
        expect(epic.weight).toBe('400');
        expect(epic.color).toBe(await resolve(epic.subtle));
        const phase = await read(name('.lrow:not(.sub)'));
        expect(phase.pad).toBe('0px');
        expect(phase.color).not.toBe(await resolve(phase.subtle));
        await page.goto('/work/roadmap?epic=epic-9');
        const selEpic = await read(name('.lrow.sub.sel'));
        expect(selEpic.color).toBe(await resolve(selEpic.text));
      });

      test('every axis label stays inside the track column', async ({ page }) => {
        const axis = await page.locator('.months-row').first().boundingBox();
        const marks = await page.locator('.months-row').first().locator('.months-mark').all();
        expect(marks.length).toBeGreaterThan(1);
        for (const m of marks) {
          const box = await m.boundingBox();
          expect(box?.x ?? 0).toBeGreaterThanOrEqual((axis?.x ?? 0) - 1);
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
            (axis?.x ?? 0) + (axis?.width ?? 0) + 1,
          );
        }
      });
    });
  }

  test('at 768px the track column is at least 430px wide', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/work/roadmap');
    const box = await page.locator('.lrow:not(.sub) .track').first().boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(430);
  });
});

// Bar colour follows status (not dates), and one legend explains the four tones.
test.describe('Roadmap: status tones and legend', () => {
  const TONES = ['done', 'review', 'in-progress', 'todo'] as const;
  const LABELS = ['Done', 'In review', 'In progress', 'Todo'];
  const counts = (c: Partial<(typeof WINDOW_ROADMAP)[number]['statusCounts']>) => ({
    done: 0,
    review: 0,
    inProgress: 0,
    todo: 0,
    superseded: 0,
    ...c,
  });
  // One project-a phase per tone. Finished phases are past (dimmed) but keep
  // their tone; the Todo phase starts after the pinned clock (a stub bar).
  const TONE_ROADMAP = [
    {
      ...WINDOW_ROADMAP[0],
      milestoneId: 'phase-1',
      name: 'Phase 1',
      tasksTotal: 2,
      tasksCompleted: 2,
      statusCounts: counts({ done: 2 }),
      startedAt: '2025-12-01T09:00:00.000Z',
      finishedAt: '2025-12-20T09:00:00.000Z',
    },
    {
      ...WINDOW_ROADMAP[0],
      milestoneId: 'phase-2',
      name: 'Phase 2',
      sequence: 2,
      status: 'in-progress',
      tasksTotal: 3,
      tasksCompleted: 1,
      statusCounts: counts({ done: 1, review: 2 }),
      startedAt: '2025-12-22T09:00:00.000Z',
      finishedAt: '2026-01-05T09:00:00.000Z',
    },
    {
      ...WINDOW_ROADMAP[0],
      milestoneId: 'phase-3',
      name: 'Phase 3',
      sequence: 3,
      status: 'in-progress',
      tasksTotal: 3,
      tasksCompleted: 1,
      statusCounts: counts({ done: 1, inProgress: 1, todo: 1 }),
      startedAt: '2026-01-06T09:00:00.000Z',
      finishedAt: null,
    },
    {
      ...WINDOW_ROADMAP[0],
      milestoneId: 'phase-4',
      name: 'Phase 4',
      sequence: 4,
      status: 'planned',
      tasksTotal: 2,
      tasksCompleted: 0,
      statusCounts: counts({ todo: 2 }),
      startedAt: '2026-02-01T09:00:00.000Z',
      finishedAt: null,
    },
  ];

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await stubWindowRoadmap(page);
    await page.route('**/api/roadmap**', (route) => route.fulfill({ json: TONE_ROADMAP }));
  });
  // The window hides lanes before the current one; open them so all four show.
  const openAllLanes = async (page: Page) => {
    await page.goto('/work/roadmap');
    await expect(page.locator('.rm-legend')).toBeVisible();
    const earlier = page.locator('button[aria-controls="rm-window-project-a-earlier"]');
    if ((await earlier.count()) > 0) await earlier.click();
  };

  test('one legend lists the four tones in order, each swatch styled like its bar', async ({
    page,
  }) => {
    await openAllLanes(page);
    const legend = page.locator('.rm-legend');
    await expect(legend).toHaveCount(1);
    await expect(legend).toBeVisible();
    await expect(legend.locator('.rm-legend__item')).toHaveText(LABELS);
    const style = (loc: import('@playwright/test').Locator) =>
      loc.evaluate((el) => {
        const c = getComputedStyle(el);
        return {
          bg: c.backgroundColor,
          borderStyle: c.borderTopStyle,
          borderColor: c.borderTopColor,
        };
      });
    for (const tone of TONES) {
      const bar = page.locator(`.lbar.lbar--${tone}`).first();
      await expect(bar).toBeVisible();
      const swatch = legend.locator(`.rm-legend__swatch.lbar--${tone}`);
      const barStyle = await style(bar);
      const swatchStyle = await style(swatch);
      expect(swatchStyle.bg).toBe(barStyle.bg);
      if (tone === 'todo') {
        expect(swatchStyle.borderStyle).toBe('dashed');
        expect(barStyle.borderStyle).toBe('dashed');
        expect(swatchStyle.borderColor).toBe(barStyle.borderColor);
      }
    }
    // A finished bar keeps its tone but is dimmed.
    const dim = await page
      .locator('.lbar.lbar--done.past')
      .first()
      .evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(dim).toBeLessThan(1);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`fill tones reach 3:1 against the surface (${theme})`, async ({ page }) => {
      await setTheme(page, theme);
      await page.goto('/work/roadmap');
      const legend = page.locator('.rm-legend');
      await expect(legend).toBeVisible();
      const surface = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.background = 'var(--bs-surface)';
        document.body.append(probe);
        const bg = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return bg;
      });
      const rgb = (css: string) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          const c = (v ?? 0) / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r as number) + 0.7152 * f(g as number) + 0.0722 * f(b as number);
      };
      for (const tone of ['done', 'review', 'in-progress'] as const) {
        const bg = await legend
          .locator(`.rm-legend__swatch.lbar--${tone}`)
          .evaluate((el) => getComputedStyle(el).backgroundColor);
        const [a, b] = [lum(rgb(bg)), lum(rgb(surface))];
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        console.log(`contrast ${tone} ${theme}: ${ratio.toFixed(2)}`);
        expect(ratio).toBeGreaterThanOrEqual(3);
      }
    });

    test(`screenshot status tones desktop/${theme}`, async ({ page }) => {
      await setTheme(page, theme);
      await openAllLanes(page);
      await settleForShot(page, page.locator('.rm-legend'));
      await shoot(page, `work-roadmap-tones-desktop-${theme}`);
    });
  }

  test('each phase bar agrees with the phase badge and the header count', async ({ page }) => {
    await stubWindowRoadmap(page);
    await page.goto('/work/roadmap');
    const doneBars = page.locator('.rm-section').first().locator('.lrow:not(.sub) .lbar--done');
    await page.locator('button[aria-controls="rm-window-project-a-earlier"]').click();
    const head = await page.locator('.rm-section__head').first().innerText();
    const declaredDone = Number(/(\d+) of \d+ phases done/.exec(head)?.[1]);
    // The window shows 6 of the 8 phases; the 2 hidden later ones are planned.
    await expect(doneBars).toHaveCount(declaredDone);
    for (const phase of ['phase-3', 'phase-4']) {
      await page.goto(`/work/roadmap?phase=${phase}`);
      const badge = (
        await page
          .locator('.bs-tag')
          .filter({ hasText: /^(Done|In progress)$/ })
          .first()
          .innerText()
      ).trim();
      const row = page
        .locator('.lrow:not(.sub)')
        .filter({ hasText: `Phase ${phase.slice(6)}` })
        .first();
      const cls = (await row.locator('.lbar').first().getAttribute('class')) ?? '';
      if (badge === 'Done') expect(cls).toContain('lbar--done');
      else expect(cls).toMatch(/lbar--(in-progress|review)/);
    }
  });

  test('the legend is hidden at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/work/roadmap');
    await expect(page.locator('.bs-roadmap-mobile__phase-select').first()).toBeVisible();
    await expect(page.locator('.rm-legend')).toHaveCount(0);
  });
});
