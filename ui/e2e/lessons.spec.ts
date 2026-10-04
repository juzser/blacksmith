import type { LessonRecord, LessonsResult } from '../src/lib/api.js';
import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

/** Full `LessonRecord` shape (ui/src/lib/api.ts) for a `page.route` stub. */
function lesson(partial: Partial<LessonRecord> & { lessonId: string }): LessonRecord {
  return {
    sessionId: 'csb-audit-1',
    lessonType: 'mistake',
    lessonLevel: 'task',
    lessonStatus: 'candidate',
    lessonScope: 'stack-wide',
    statement: 'Run the full test suite at the gate.',
    provenanceEventIds: '[]',
    evidence: null,
    timesPrevented: 0,
    validFrom: '2026-09-07T00:00:00.000Z',
    claimPath: null,
    agentRole: null,
    caseType: null,
    ...partial,
  };
}

const CARD_FIXTURE: LessonsResult = {
  pending: [lesson({ lessonId: 'lesson-pending', lessonStatus: 'candidate' })],
  approved: [
    lesson({
      lessonId: 'lesson-approved',
      sessionId: 'claim-path-1',
      lessonStatus: 'approved',
      statement: 'Always check the upper loop bound against array length, not a hardcoded value.',
      lessonScope: 'claim-path',
      claimPath: 'ui/src/components/kit/**',
      timesPrevented: 2,
    }),
  ],
  closed: [
    lesson({
      lessonId: 'lesson-closed',
      sessionId: 'security-1',
      lessonStatus: 'invalidated',
      statement: 'CI runners have no network access, so tests must not fetch remote fixtures.',
      lessonScope: 'security',
    }),
  ],
  lastCheckedAt: FIXTURE_NOW_ISO,
};

/** Cards in every tab, and a non-null `lastCheckedAt` (DS8 PR2 item 4). */
async function serveLessonsWithCards(page: import('@playwright/test').Page) {
  await page.route('**/api/lessons*', (route) => route.fulfill({ json: CARD_FIXTURE }));
}

/** Pending empty, but the factory has already run once. */
async function serveLessonsPendingChecked(page: import('@playwright/test').Page) {
  await page.route('**/api/lessons*', (route) =>
    route.fulfill({
      json: {
        pending: [],
        approved: [],
        closed: [],
        lastCheckedAt: FIXTURE_NOW_ISO,
      } as LessonsResult,
    }),
  );
}

test.describe('Lessons', () => {
  test('renders the approved lesson and a11y basics', async ({ page }) => {
    await page.goto('/lessons');
    await expect(page.locator('h1')).toHaveText('Lessons');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await page.getByRole('tab', { name: /^All/ }).click();
    // Each tab's panel stays in the DOM (v-show), so an unscoped text query
    // can hit the same lesson row twice across panels; the accessibility
    // tree only exposes the one currently visible (display:none drops the
    // rest), so scoping through role=tabpanel disambiguates it.
    await expect(page.getByRole('tabpanel').getByText(/loop bound/)).toBeVisible();
  });

  // The fixture's only lesson is already `approved`, and architecture §9.4
  // lets an approved lesson move only to superseded or invalidated. So the
  // Dialog must not offer Approve or Edit here — pressing either could do
  // nothing but return `lessons.illegal-transition` into a red Banner
  // (P9-36). Reject stays: invalidated is a legal move.
  test('row click opens the review Dialog, offering only the legal actions', async ({ page }) => {
    await page.goto('/lessons');
    await page.getByRole('tab', { name: /^All/ }).click();
    await page
      .getByRole('tabpanel')
      .getByText(/loop bound/)
      .click();
    const dialog = page.getByRole('dialog', { name: 'Review lesson' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Reject' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    // And it says why, rather than leaving a footer that looks half-rendered.
    await expect(dialog.getByText(/nothing left to approve/)).toBeVisible();
  });

  /**
   * D-220. The fixture's second lesson is `invalidated` — the status this
   * page's own Reject button writes. It used to be in neither bucket the API
   * returned, so rejecting a lesson made the row disappear from every filter
   * the page had, "All" included.
   */
  test('shows a rejected lesson under Closed and under All', async ({ page }) => {
    await page.goto('/lessons');
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByText(/no network access/)).toHaveCount(0);

    await page.getByRole('tab', { name: /^Closed/ }).click();
    await expect(panel.getByText(/no network access/)).toBeVisible();
    await expect(panel.getByText(/loop bound/)).toHaveCount(0);

    await page.getByRole('tab', { name: /^All/ }).click();
    await expect(panel.getByText(/no network access/)).toBeVisible();
    await expect(panel.getByText(/loop bound/)).toBeVisible();

    // And it says why the footer has no buttons, rather than looking broken.
    await panel.getByText(/no network access/).click();
    const dialog = page.getByRole('dialog', { name: 'Review lesson' });
    await expect(dialog.getByText(/terminal status/)).toBeVisible();
  });

  // The fixture seeds no pending-status lesson and no lessons-pass-completed
  // event, so the Pending tab (the page's default) renders the new empty
  // state with no "Last checked" line (ds-spec.md §4.5: that line reads
  // lastCheckedAt, null here).
  test('Pending tab shows the empty state with no Last-checked line when dream() has never run', async ({
    page,
  }) => {
    await page.goto('/lessons');
    await expect(page.getByText('Nothing to review.')).toBeVisible();
    await expect(page.getByText(/Last checked/)).toHaveCount(0);
  });

  // ds-spec.md §4.5's own audit item: all four tabs show a count, including
  // Approved (not just Pending/Closed).
  test('every tab shows a count', async ({ page }) => {
    await page.goto('/lessons');
    await expect(page.getByRole('tab', { name: /^Pending review \d+/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Approved \d+/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Closed \d+/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^All \d+/ })).toBeVisible();
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/lessons');
        await expect(page.locator('h1')).toHaveText('Lessons');
        await settleForShot(page, page.getByText('Nothing to review.'));
        await shoot(page, `lessons-${vpName}-${theme}`);
      });
    }
  }

  // The Pending empty state always explains the tab, and only shows "Last
  // checked" once dream() has actually run (ds-spec.md §4.5, audit Lessons-2).
  // Fails without the feature: the pre-fix body was empty text whenever
  // lastCheckedAt was set, so this sentence was never there to find.
  test('Pending tab explains itself and shows Last checked once the factory has run', async ({
    page,
  }) => {
    await serveLessonsPendingChecked(page);
    await page.goto('/lessons');
    await expect(page.getByText('Nothing to review.')).toBeVisible();
    await expect(page.getByText(/factory proposes new lessons/)).toBeVisible();
    await expect(page.getByText(/Last checked/)).toBeVisible();
  });

  // Cards render with the three-sentence copy (ds-spec.md §4.5), not raw
  // status strings. Fails without the feature: before lessonLabels.ts's
  // formatShortDate fix this read "07/09/2026", not "7 Sep".
  test('All tab renders cards with the short date and scope labels', async ({ page }) => {
    await serveLessonsWithCards(page);
    await page.goto('/lessons');
    await page.getByRole('tab', { name: /^All/ }).click();
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByText(/csb-audit-1 on 7 Sep/)).toBeVisible();
    await expect(panel.getByText('Applies to all projects').first()).toBeVisible();
    await expect(panel.getByText('ui/src/components/kit/**')).toBeVisible();
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot cards ${vpName}/${theme}`, async ({ page }) => {
        await serveLessonsWithCards(page);
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/lessons');
        await page.getByRole('tab', { name: /^All/ }).click();
        await settleForShot(page, page.getByRole('tabpanel').getByText(/csb-audit-1/));
        await shoot(page, `lessons-cards-${vpName}-${theme}`);
      });
    }
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`screenshot dialog desktop/${theme}`, async ({ page }) => {
      await serveLessonsWithCards(page);
      await setTheme(page, theme);
      await page.setViewportSize(VIEWPORTS.desktop);
      await page.goto('/lessons');
      await page
        .getByRole('tabpanel')
        .getByText(/Run the full test suite/)
        .click();
      const dialog = page.getByRole('dialog', { name: 'Review lesson' });
      await settleForShot(page, dialog);
      await shoot(page, `lessons-dialog-desktop-${theme}`);
    });
  }

  // Phone row deviation (ds-review.html .mrow): the one-line layout crowded
  // the title down to a sliver next to the tag and meta text ("Run...",
  // "A...", "CI r..."). The binding mock is a two-line grid: title + tag on
  // row 1, meta spanning both columns on row 2. Fails without the fix. A
  // short title is the case the acceptance criterion names -- a title long
  // enough to outgrow even half the row still ellipsis-truncates by design,
  // same as the tag beside it.
  test('compact phone row renders a short title in full, above the meta', async ({ page }) => {
    await page.route('**/api/lessons*', (route) =>
      route.fulfill({
        json: {
          pending: [lesson({ lessonId: 'lesson-short', statement: 'Run tests at the gate.' })],
          approved: [],
          closed: [],
          lastCheckedAt: FIXTURE_NOW_ISO,
        } as LessonsResult,
      }),
    );
    await setTheme(page, 'light');
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/lessons');
    const title = page.getByRole('tabpanel').getByText('Run tests at the gate.');
    await expect(title).toBeVisible();
    const meta = page.getByRole('tabpanel').getByText(/From csb-audit-1.*7 Sep/);
    await expect(meta).toBeVisible();

    const [titleOverflow, titleBox, metaBox] = await Promise.all([
      title.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })),
      title.boundingBox(),
      meta.boundingBox(),
    ]);
    expect(titleOverflow.scrollWidth).toBeLessThanOrEqual(titleOverflow.clientWidth);
    expect(metaBox?.y).toBeGreaterThan(titleBox?.y ?? 0);
  });

  test('screenshot dialog mobile/light', async ({ page }) => {
    await serveLessonsWithCards(page);
    await setTheme(page, 'light');
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/lessons');
    await page
      .getByRole('tabpanel')
      .getByText(/Run the full test suite/)
      .click();
    const dialog = page.getByRole('dialog', { name: 'Review lesson' });
    await settleForShot(page, dialog);
    await shoot(page, 'lessons-dialog-mobile-light');
  });
});
