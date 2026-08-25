import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Kanban', () => {
  test('renders the board grouped by status and a11y basics', async ({ page }) => {
    await page.goto('/kanban');
    await expect(page.locator('h1')).toHaveText('Kanban');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.getByRole('region', { name: /lane/ })).toBeVisible();
    await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  });

  test('clicking a task card navigates to the real task detail page', async ({ page }) => {
    await page.goto('/kanban');
    const firstCard = page.locator('.kanban-card').first();
    await expect(firstCard).toBeVisible();
    const taskId = await firstCard.locator('.kanban-card__id').innerText();
    await firstCard.click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId.replace('/', '%2F')}`));
    await expect(page.getByRole('tablist', { name: 'Task detail sections' })).toBeVisible();
  });

  test('"All epics" option boards tasks across every epic', async ({ page }) => {
    await page.goto('/kanban');
    await page.getByLabel('Epic').selectOption('');
    await expect(page.getByRole('region', { name: 'All epics lane' })).toBeVisible();
  });

  test('never sits on the skeleton when the epic list is what failed', async ({ page }) => {
    // The epic picker is fed by /api/overview; the board comes from
    // /api/kanban. The picker's fetch ran first and unguarded, so its failure
    // took the whole page down: `loading` never cleared and `error` was never
    // set, leaving the operator on the skeleton row forever — a state
    // indistinguishable from "still loading" (D-222).
    await page.route('**/api/overview*', (route) => route.abort('failed'));
    await page.goto('/kanban');
    await expect(page.locator('h1')).toHaveText('Kanban');
    await expect(page.locator('.hds-skeleton')).toHaveCount(0);
    await expect(page.locator('.hds-banner')).toBeVisible();
    // The board's own endpoint is healthy, so the tasks still arrive.
    await expect(page.locator('.kanban-card').first()).toBeVisible();
  });

  // Two rules read the same payload: the server groups by raw task_status and
  // hides nothing, KanbanBoard re-folds those rows and drops `failed` and
  // `superseded` from the default board. The Toolbar summed the first and
  // labelled the second, so it counted cards that were never drawn (D-242).
  // Latent against the live DB today -- it holds no terminal tasks -- so the
  // payload is stubbed to put one on the board.
  test('the toolbar counts the cards the board actually draws', async ({ page }) => {
    const task = (taskId: string, taskStatus: string) => ({
      taskId,
      taskStatus,
      title: taskId,
      agentRole: null,
      agentModelTier: null,
      milestoneId: null,
      tags: { case: null, origin: null, severity: null },
    });
    await page.route('**/api/kanban*', (route) =>
      route.fulfill({
        json: [
          { taskStatus: 'todo', tasks: [task('epic-1/task-1', 'todo')] },
          { taskStatus: 'failed', tasks: [task('epic-1/task-2', 'failed')] },
          { taskStatus: 'superseded', tasks: [task('epic-1/task-3', 'superseded')] },
        ],
      }),
    );
    await page.goto('/kanban');

    // `.hds-toolbar__count` also labels the Epic Select, so scope to the end
    // slot where Toolbar.vue puts the real one.
    const count = page.locator('.hds-toolbar__end .hds-toolbar__count');
    await expect(count).toHaveText('1 tasks');
    await expect(page.locator('.kanban-card')).toHaveCount(1);
  });

  // The other half of the same number: a board of nothing but terminal tasks
  // draws no cards, and the empty state is gated on that count.
  test('a board of only hidden statuses says so', async ({ page }) => {
    await page.route('**/api/kanban*', (route) =>
      route.fulfill({
        json: [
          {
            taskStatus: 'superseded',
            tasks: [
              {
                taskId: 'epic-1/task-9',
                taskStatus: 'superseded',
                title: 'replaced',
                agentRole: null,
                agentModelTier: null,
                milestoneId: null,
                tags: { case: null, origin: null, severity: null },
              },
            ],
          },
        ],
      }),
    );
    await page.goto('/kanban');
    await expect(page.locator('.hds-toolbar__end .hds-toolbar__count')).toHaveText('0 tasks');
    await expect(page.getByText('No tasks match these filters.')).toBeVisible();
  });

  test('the loading skeleton actually occupies the board', async ({ page }) => {
    // `height="240"` is a static attribute, so Skeleton received the string
    // '240' and wrote `height: 240` — not a CSS length, dropped by the
    // browser, zero-height element. Every skeleton in the app was invisible,
    // so "loading" and "empty" looked the same (D-223). Only a rendered
    // template can catch that, which means only this layer can.
    await page.route('**/api/kanban*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto('/kanban');
    const skeleton = page.locator('.hds-skeleton').first();
    await expect(skeleton).toBeVisible();
    const box = await skeleton.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(100);
  });

  // The one capture whose subject is a failure, so it cannot wait on a data
  // marker the way the rest do (see helpers.ts / D-150): in the state it
  // documents, no data is coming. `networkidle` is the equivalent gate here —
  // every fetch has settled, the aborted one included — so the PNG shows the
  // page's decision rather than a race with it.
  test('screenshot epic list unavailable', async ({ page }) => {
    await setTheme(page, 'light');
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.route('**/api/overview*', (route) => route.abort('failed'));
    await page.goto('/kanban');
    await expect(page.locator('h1')).toHaveText('Kanban');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(150);
    await shoot(page, 'kanban-epics-unavailable-desktop-light');
  });

  // Same shape as the Timeline's: a 15s poll whose `loadBoard()` cleared
  // `error` first, so every attempt during an outage swapped the banner for
  // "No tasks match these filters." -- a board claiming the epic is empty on
  // the strength of a request that never returned.
  test('a failing refresh never replaces the error with an empty board', async ({ page }) => {
    let served = 0;
    await page.route('**/api/kanban*', async (route) => {
      served += 1;
      if (served === 1) {
        await route.abort('failed');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      await route.abort('failed').catch(() => {});
    });
    await page.goto('/kanban');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    // Resolves the moment the refetch is issued -- i.e. the moment `load()`
    // has done whatever it does to `error` -- so the assertions below land
    // inside the in-flight window rather than racing it.
    const refetch = page.waitForRequest('**/api/kanban*');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await refetch;

    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.getByText('No tasks match these filters.')).toHaveCount(0);
  });

  // Flow's D-228, on the page that shares the picker. `loadBoard()` fetches
  // only /api/kanban, so the project watcher left the epic list behind; the
  // 15s poll healed it eventually, which is why it read as a glitch rather
  // than a bug. Playwright's 5s expect timeout is deliberately shorter than
  // that poll, so this asserts the switch itself, not the poll.
  test('re-reads the epic list when the project switches under it', async ({ page }) => {
    const epicOptions = () =>
      page.getByLabel('Epic', { exact: true }).locator('option').allTextContents();
    const projectSwitcher = page.getByLabel('Project', { exact: true });

    await page.goto('/kanban');
    await expect(page.locator('.kanban-card').first()).toBeVisible();
    // Proof the population is not empty before anything is claimed absent.
    expect(await epicOptions()).toEqual(expect.arrayContaining(['epic-1', 'epic-9']));

    await projectSwitcher.selectOption('black-smith');
    await expect(page).toHaveURL(/[?&]project=black-smith/);
    await expect.poll(epicOptions).not.toContain('epic-9');
    expect(await epicOptions()).toContain('epic-1');
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/kanban');
        await expect(page.locator('h1')).toHaveText('Kanban');
        await settleForShot(page, page.locator('.kanban-card').first());
        await shoot(page, `kanban-${vpName}-${theme}`);
      });
    }
  }
});
