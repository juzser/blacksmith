import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot } from './helpers.js';
import { stubWindowRoadmap } from './roadmapWindowFixture.js';

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
    // UI spec Part 2: one collapsible section per project, each with its own
    // picker over its window; envkit's section is closed until tapped open.
    await page.locator('summary.rm-section__head', { hasText: 'envkit' }).click();
    const select = page.getByLabel('envkit phase', { exact: true });
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
    const phaseSelect = page.getByLabel('demo-hub phase', { exact: true });
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

  // S4 fix round 2 — the current wave row must stay on one line: the Tag
  // shares the same line as the bold title, not wrapped underneath.
  test('the current wave row keeps its Tag on the same line as the title at 375px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/work/roadmap?epic=epic-9');
    const curRow = page.locator('.wave.cur');
    await expect(curRow).toBeVisible();

    const title = curRow.locator('.wave__title');
    const tag = curRow.locator('.bs-tag');
    const titleBox = await title.boundingBox();
    const tagBox = await tag.boundingBox();
    expect(titleBox).not.toBeNull();
    expect(tagBox).not.toBeNull();
    const titleCenterY = (titleBox?.y ?? 0) + (titleBox?.height ?? 0) / 2;
    const tagCenterY = (tagBox?.y ?? 0) + (tagBox?.height ?? 0) / 2;
    expect(Math.abs(titleCenterY - tagCenterY)).toBeLessThan(4);

    const rowBox = await curRow.boundingBox();
    expect(rowBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  // S4 fix round 3 — information beats bar length: the current wave row's
  // title + done count must stay fully visible (un-truncated), with the
  // ProgressBarMini shrinking instead, in both phase mode and epic mode.
  for (const [label, url] of [
    ['phase', '/work/roadmap?phase=phase-6b'],
    ['epic', '/work/roadmap?epic=epic-9'],
  ] as const) {
    test(`the current wave row shows "0/1 done" un-truncated in ${label} mode at 375px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(url);
      if (label === 'phase') {
        const summary = page.locator('.bs-roadmap-mobile__waves summary').first();
        await expect(summary).toBeVisible();
        if ((await page.locator('.wave.cur').count()) === 0) {
          await summary.click();
        }
      }
      const curRow = page.locator('.wave.cur').first();
      await expect(curRow).toBeVisible();
      await expect(curRow).toContainText('0/1 done');

      const titleWrap = curRow.locator('.whead > span:first-child').first();
      const [scrollWidth, clientWidth] = await titleWrap.evaluate((el) => [
        el.scrollWidth,
        el.clientWidth,
      ]);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      const title = curRow.locator('.wave__title').first();
      const tag = curRow.locator('.bs-tag').first();
      const titleBox = await title.boundingBox();
      const tagBox = await tag.boundingBox();
      expect(titleBox).not.toBeNull();
      expect(tagBox).not.toBeNull();
      const titleCenterY = (titleBox?.y ?? 0) + (titleBox?.height ?? 0) / 2;
      const tagCenterY = (tagBox?.y ?? 0) + (tagBox?.height ?? 0) / 2;
      expect(Math.abs(titleCenterY - tagCenterY)).toBeLessThan(4);
    });
  }

  // S4 fix round 4 — the % number must never overlap the Tag: the track
  // is the element that gives way when space is short.
  for (const [label, url] of [
    ['phase', '/work/roadmap?phase=phase-6b'],
    ['epic', '/work/roadmap?epic=epic-9'],
  ] as const) {
    test(`the current wave row's % and Tag never overlap in ${label} mode at 375px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(url);
      if (label === 'phase') {
        const summary = page.locator('.bs-roadmap-mobile__waves summary').first();
        await expect(summary).toBeVisible();
        if ((await page.locator('.wave.cur').count()) === 0) {
          await summary.click();
        }
      }
      const curRow = page.locator('.wave.cur').first();
      await expect(curRow).toBeVisible();

      const pnum = curRow.locator('.bs-pnum').first();
      const tag = curRow.locator('.bs-tag').first();
      const pnumBox = await pnum.boundingBox();
      const tagBox = await tag.boundingBox();
      expect(pnumBox).not.toBeNull();
      expect(tagBox).not.toBeNull();

      const pnumRight = (pnumBox?.x ?? 0) + (pnumBox?.width ?? 0);
      const pnumTop = pnumBox?.y ?? 0;
      const pnumBottom = pnumTop + (pnumBox?.height ?? 0);
      const tagLeft = tagBox?.x ?? 0;
      const tagTop = tagBox?.y ?? 0;
      const tagBottom = tagTop + (tagBox?.height ?? 0);

      const verticallyOverlaps = pnumTop < tagBottom && tagTop < pnumBottom;
      const horizontallyOverlaps = pnumRight > tagLeft;
      expect(verticallyOverlaps && horizontallyOverlaps).toBe(false);

      expect(tagLeft - pnumRight).toBeGreaterThanOrEqual(4);
    });
  }

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

// UI spec Part 2 §2.4 — on phone each project is a <details> section whose
// picker lists the window's lanes, with the same two disclosure rows.
// roadmapWindowFixture.ts: project-a (8 phases, phase-4 current), project-b.
test.describe('Roadmap window mobile (spec Part 2)', () => {
  const PHONE = { width: 390, height: 844 };

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
    await stubWindowRoadmap(page);
  });

  test('project sections are <details> with 44px summaries, the current one open', async ({
    page,
  }) => {
    await page.goto('/work/roadmap');
    const summaries = page.locator('summary.rm-section__head');
    await expect(summaries).toHaveCount(2);
    await expect(summaries.nth(0)).toContainText('project-a');
    await expect(summaries.nth(1)).toContainText('project-b');
    for (const summary of await summaries.all()) {
      const box = await summary.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    // project-a holds the default selection (its current lane, phase-4).
    await expect(page.locator('details.rm-section').nth(0)).toHaveAttribute('open', '');
    await expect(page.locator('details.rm-section').nth(1)).not.toHaveAttribute('open', '');
  });

  test('the picker lists the window, and the 44px disclosure rows widen it', async ({ page }) => {
    await page.goto('/work/roadmap');
    const picker = page.getByLabel('project-a phase', { exact: true });
    await expect(picker).toHaveValue('phase-4');
    await expect(picker.locator('option')).toHaveText(['Phase 3', 'Phase 4', 'Phase 5', 'Phase 6']);

    // On phone the disclosures widen the picker's options, so they name it.
    const section = page.locator('details.rm-section').nth(0);
    const earlier = section.locator('.rm-window__more', { hasText: 'earlier' });
    const later = section.locator('.rm-window__more', { hasText: 'later' });
    await expect(earlier).toHaveText('Show 2 earlier lanes');
    await expect(later).toHaveText('Show 2 later lanes');
    await expect(picker).toHaveAttribute('id', 'rm-window-project-a-picker');
    for (const button of [earlier, later]) {
      await expect(button).toHaveAttribute('aria-controls', 'rm-window-project-a-picker');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
    }
    for (const button of [earlier, later]) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await earlier.click();
    await expect(earlier).toHaveAttribute('aria-expanded', 'true');
    await expect(earlier).toHaveText('Show fewer earlier lanes');
    await expect(picker.locator('option')).toHaveText([
      'Phase 1',
      'Phase 2',
      'Phase 3',
      'Phase 4',
      'Phase 5',
      'Phase 6',
    ]);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`screenshot window phone 390/${theme}`, async ({ page }) => {
      await setTheme(page, theme);
      await page.goto('/work/roadmap');
      await settleForShot(page, page.getByLabel('project-a phase', { exact: true }));
      await shoot(page, `work-roadmap-window-mobile-390-${theme}`);
    });
  }
});
