import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

const DEMO_HUB_WAIVABLE_TASK = 'epic-9/task-3'; // multiProjectFixture.ts's confirmed S3 finding
// epic-9/task-1: dispatched then completed (task-result-recorded, run_status
// done) — the smallest fixture task with more than one run-history row.
const DEMO_HUB_COMPLETED_TASK = 'epic-9/task-1';

test.describe('Task detail', () => {
  test('renders tabs and a11y basics', async ({ page }) => {
    await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_WAIVABLE_TASK)}`);
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.getByRole('tablist', { name: 'Task detail sections' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'What was asked' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  // DS4 S5c fix round 1, fix 2 — task-1's quote is the short epic-level
  // fallback (multiProjectFixture.ts), too short to clamp at 3 lines.
  test('RequestQuote: a short quote shows no "Show more" toggle', async ({ page }) => {
    await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_COMPLETED_TASK)}`);
    const quote = page.locator('.bs-request-quote');
    await expect(quote).toBeVisible();
    await expect(quote.locator('.bs-request-quote__toggle')).toHaveCount(0);
    await expect(quote.locator('.bs-request-quote__link')).toBeVisible();
  });

  // task-3 gets the long, task-specific prompt (multiProjectFixture.ts),
  // long enough to overflow the 3-line clamp.
  test('RequestQuote: a long quote shows "Show more" and expands on click', async ({ page }) => {
    await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_WAIVABLE_TASK)}`);
    const quote = page.locator('.bs-request-quote');
    const toggle = quote.locator('.bs-request-quote__toggle');
    await expect(toggle).toHaveText('Show more');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveText('Show less');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  // DS4 S5c fix round 1, fix 1 — both controls clear 44px on phone.
  test('RequestQuote touch targets clear 44px at 375px on Task Detail', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_WAIVABLE_TASK)}`);
    const quote = page.locator('.bs-request-quote');
    for (const locator of [
      quote.locator('.bs-request-quote__toggle'),
      quote.locator('.bs-request-quote__link'),
    ]) {
      const box = await locator.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  // Pattern 2 — the History tab's run history timeline (visual-pass item 3
  // moved it there from "What was asked"), fed by GET /api/tasks/:taskId/runs
  // (queries.ts's `taskRuns()`). This task has a dispatch row and a completed
  // result row: two distinct run kinds, so the timeline is proven to render
  // more than a single placeholder entry.
  test('Run history timeline shows a row per run, in the done tone for a completed result', async ({
    page,
  }) => {
    await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_COMPLETED_TASK)}`);
    await page.getByRole('tab', { name: 'History' }).click();
    const rows = page.locator('.bs-run-history .bs-timeline-row');
    await expect(rows.first()).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(page.locator('.bs-run-history').getByText('done', { exact: true })).toBeVisible();
  });

  // Item 4 — ds-spec.md §1.5: rail centre and dot centre both land on
  // --tl-rail-x (7px), dot top centres it on the first text line via
  // (--tl-lh - --tl-dot) / 2 (6px). Read straight off the ::before/::after
  // pseudo-elements rather than a screenshot diff, since this is exact pixel
  // geometry, not a visual regression.
  test('rail geometry matches the §1.5 tokens: rail/dot centred at 7px, dot top at 6px', async ({
    page,
  }) => {
    await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_COMPLETED_TASK)}`);
    await page.getByRole('tab', { name: 'History' }).click();
    const row = page.locator('.bs-run-history .bs-timeline-row').first();
    await expect(row).toBeVisible();
    const geometry = await row.evaluate((el) => {
      const before = getComputedStyle(el, '::before');
      const after = getComputedStyle(el, '::after');
      return {
        railLeft: Number.parseFloat(before.left),
        railWidth: Number.parseFloat(before.width),
        dotLeft: Number.parseFloat(after.left),
        dotWidth: Number.parseFloat(after.width),
        dotTop: Number.parseFloat(after.top),
      };
    });
    expect(geometry.railLeft + geometry.railWidth / 2).toBeCloseTo(7, 0);
    expect(geometry.dotLeft + geometry.dotWidth / 2).toBeCloseTo(7, 0);
    expect(geometry.dotTop).toBeCloseTo(6, 0);
  });

  test('Findings tab shows the Waive Popover confirm naming the fingerprint', async ({ page }) => {
    await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_WAIVABLE_TASK)}`);
    await page.getByRole('tab', { name: 'Findings' }).click();
    await page.getByRole('button', { name: 'Waive' }).click();
    await expect(page.getByText(/Waive finding/)).toBeVisible();
    await expect(page.locator('code')).toBeVisible();

    // `role="dialog"` requires an accessible name -- it is what a screen
    // reader announces on entry, and how the operator knows which of the
    // page's overlays they are standing in. This one declared the role and
    // supplied no name at all, so it announced as a bare "dialog" (D-239).
    await expect(page.getByRole('dialog', { name: 'Waive finding' })).toBeVisible();
  });

  // The History tab fetches on its own, separately from the task itself, so
  // /api/timeline can fail while /api/task is healthy. Before D-224 that call
  // had no catch: it rejected unhandled and the tab fell through to its empty
  // state, telling the operator the factory recorded nothing for this task --
  // a positive claim assembled out of a request that never answered.
  test('never claims a task has no history when the timeline API is what failed', async ({
    page,
  }) => {
    await page.route('**/api/timeline*', (route) => route.abort('failed'));
    await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_WAIVABLE_TASK)}`);
    await page.getByRole('tab', { name: 'History' }).click();

    await expect(page.getByText('No events recorded for this task.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  // The crumb was set inside load()'s try, AFTER the fetch resolved, so it only
  // ever named a task the server had answered for. A failed fetch left whatever
  // the previous page had put in the topbar: the operator stood on /tasks/<id>,
  // over a danger Banner about that task, under a crumb that still read plain
  // "Kanban". Every other page in the app sets its crumb before its fetch --
  // SessionsPage's own comment says why (D-230).
  //
  // Navigated here directly rather than via a Kanban card click: a card click
  // now opens the peek panel first (pattern 4), which would itself run into
  // the same aborted /api/tasks/* route and never reach a page navigation at
  // all. Going straight to the URL keeps this test's actual subject — the
  // page-level crumb surviving a failed fetch — independent of the peek
  // panel's own, separately-tested error handling.
  test('names the task in the breadcrumb even when the task fetch fails', async ({ page }) => {
    await page.route('**/api/tasks/*', (route) => route.abort('failed'));
    await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_WAIVABLE_TASK)}`);

    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.locator('.bs-crumbs__current')).toHaveText(DEMO_HUB_WAIVABLE_TASK);
  });

  // Every event in this tab was fetched with `{ task: <this task> }`, and
  // timeline() filters that column with a strict eq -- so every row's taskId is
  // already the one in the URL. The titles still rendered as buttons with a
  // pointer cursor, and clicking one pushed the route the operator was standing
  // on: a duplicated navigation vue-router discards. The affordance promised a
  // jump it could never make (D-231).
  test('History rows offer no link back to the task already on screen', async ({ page }) => {
    await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_WAIVABLE_TASK)}`);
    await page.getByRole('tab', { name: 'History' }).click();

    await expect(page.locator('.bs-timeline-row__title').first()).toBeVisible();
    await expect(page.locator('button.bs-timeline-row__title')).toHaveCount(0);
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_WAIVABLE_TASK)}`);
        await settleForShot(page, page.getByRole('tablist', { name: 'Task detail sections' }));
        await shoot(page, `task-detail-${vpName}-${theme}`);
      });
    }
  }

  // Evidence gap: no phase-6b screenshot showed the History tab, so the
  // RunHistoryTimeline move (item 3 above) had no visual record. Uses the
  // completed task — two run rows, same fixture as the "shows a row per
  // run" test above — so the capture proves the timeline renders real rows,
  // not just its empty state.
  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme} History tab`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_COMPLETED_TASK)}`);
        await page.getByRole('tab', { name: 'History' }).click();
        await settleForShot(page, page.locator('.bs-run-history .bs-timeline-row').first());
        await shoot(page, `task-detail-history-${vpName}-${theme}`);
      });
    }
  }
});
