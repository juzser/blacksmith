import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

const DEMO_HUB_WAIVABLE_TASK = 'epic-9/task-3'; // multiProjectFixture.ts's confirmed S3 finding

test.describe('Task detail', () => {
  test('renders tabs and a11y basics', async ({ page }) => {
    await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_WAIVABLE_TASK)}`);
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.getByRole('tablist', { name: 'Task detail sections' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
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
  test('names the task in the breadcrumb even when the task fetch fails', async ({ page }) => {
    await page.route('**/api/tasks/*', (route) => route.abort('failed'));
    await page.goto('/kanban');
    await page.locator('.kanban-card').first().click();
    await page.waitForURL('**/tasks/**');
    const taskId = decodeURIComponent(new URL(page.url()).pathname.replace(/^\/tasks\//, ''));

    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.locator('.hds-crumbs__current')).toHaveText(taskId);
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

    await expect(page.locator('.timeline-row__title').first()).toBeVisible();
    await expect(page.locator('button.timeline-row__title')).toHaveCount(0);
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
});
