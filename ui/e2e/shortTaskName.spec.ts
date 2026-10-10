import type { Page } from '@playwright/test';
import type { KanbanTask } from '../src/lib/api.js';
import { expect, test } from './harness.js';
import { dropRoutes, setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

// A task is named the same short way on every surface: its title, else its
// slug, else "Follow-up fix · <parent>". The objective (a paragraph) is hover
// text on the board, the description in the peek and on the task page.
test.afterEach(async ({ page }) => dropRoutes(page));

const OBJECTIVE =
  'Rebuild the settings screen so every panel reads from one shared form model, keeps unsaved edits when the tab changes, and reports validation errors next to the field that caused them.';
const FIX_OBJECTIVE = 'Fix: the label is clipped when the sidebar is narrow';

function card(
  taskId: string,
  over: Partial<KanbanTask> & { taskStatus?: string } = {},
): KanbanTask {
  return {
    taskId,
    taskStatus: 'todo',
    title: null,
    taskTitle: null,
    agentRole: null,
    agentModelTier: null,
    agentActivity: null,
    milestoneId: null,
    tags: { case: null, origin: null, severity: null },
    updatedAt: '2026-01-01T00:00:00.000Z',
    project: null,
    attemptCount: 0,
    judgeRound: null,
    commentCount: 0,
    prUrl: null,
    dependencies: [],
    epicLabel: null,
    hasRequest: false,
    requestFirstLine: null,
    parentTaskId: null,
    parentTitle: null,
    parentTaskTitle: null,
    ...over,
  };
}

const TITLED = card('epic-9/task-3', {
  title: OBJECTIVE,
  taskTitle: 'Settings layout page',
});
const SLUG = card('epic-a/task-2-billing-page', { title: OBJECTIVE });
const MINTED = card('epic-a/followup-0a1b2c3d', {
  title: FIX_OBJECTIVE,
  parentTaskId: 'epic-9/task-3',
  parentTitle: OBJECTIVE,
  parentTaskTitle: 'Settings layout page',
});
const ORPHAN = card('epic-a/followup-1b2c3d4e', { title: FIX_OBJECTIVE });

async function mockBoard(page: Page) {
  await page.route('**/api/kanban*', (route) =>
    route.fulfill({
      json: [
        { taskStatus: 'todo', tasks: [TITLED, SLUG, MINTED, ORPHAN] },
        { taskStatus: 'completed', tasks: [] },
      ],
    }),
  );
}

// Serve the real detail with a chosen title and objective.
async function mockDetail(page: Page, taskId: string, title: string | null) {
  const detailPath = `/api/tasks/${encodeURIComponent(taskId)}`;
  await page.route(
    (url) => url.pathname === detailPath,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, task: { ...body.task, title, objective: OBJECTIVE } },
      });
    },
  );
}

test.describe('Short task names', () => {
  test('a Kanban card is named by title, slug or follow-up parent, with the objective on hover', async ({
    page,
  }) => {
    await mockBoard(page);
    await page.goto('/work/kanban');
    const cards = page.locator('.bs-kanban-card');
    await expect(cards).toHaveCount(4);

    const titled = cards.filter({ hasText: 'Settings layout page' }).first();
    await expect(titled.locator('.bs-kanban-card__title')).toHaveText(/^Settings layout page/);
    await expect(titled.locator('.bs-kanban-card__title')).toHaveAttribute('title', OBJECTIVE);
    await expect(titled.locator('.bs-kanban-card__open')).toHaveAttribute('title', OBJECTIVE);

    const slug = cards.filter({ hasText: 'Billing page' });
    await expect(slug.locator('.bs-kanban-card__title')).toHaveText(/^Billing page/);

    const minted = cards.filter({ hasText: 'Follow-up fix · Settings layout page' });
    await expect(minted).toHaveCount(1);
    await expect(minted.locator('.bs-kanban-card__title')).toHaveAttribute('title', FIX_OBJECTIVE);

    const orphan = cards.filter({ hasText: /^Follow-up fix(?! ·)/ });
    await expect(orphan).toHaveCount(1);

    // The objective is never the visible name and a hex id never is.
    for (const el of await cards.all()) {
      const text = await el.locator('.bs-kanban-card__title').innerText();
      expect(text).not.toContain('Rebuild the settings screen');
      expect(text).not.toMatch(/[0-9a-f]{8}/);
    }
  });

  test('the peek names the task by its short name and shows the objective as its description', async ({
    page,
  }) => {
    await mockBoard(page);
    await mockDetail(page, TITLED.taskId, 'Settings layout page');
    await page.goto('/work/kanban');
    await page
      .locator('.bs-kanban-card')
      .filter({ hasText: 'Settings layout page' })
      .first()
      .locator('.bs-kanban-card__open')
      .click();
    const peek = page.getByRole('dialog');
    await expect(peek).toBeVisible();
    await expect(peek.locator('.bs-dialog__title')).toHaveText('Settings layout page');
    await expect(peek.getByText(OBJECTIVE)).toBeVisible();
  });

  test('the task page heading is the short name and the objective is its description', async ({
    page,
  }) => {
    await mockDetail(page, 'epic-9/task-3', 'Settings layout page');
    await page.goto(`/tasks/${encodeURIComponent('epic-9/task-3')}`);
    await expect(page.locator('h1')).toHaveText('Settings layout page');
    await expect(page.getByText(OBJECTIVE)).toBeVisible();
  });

  test('a task with no title is headed by its slug, never its objective', async ({ page }) => {
    await mockDetail(page, 'epic-9/task-3', null);
    await page.goto(`/tasks/${encodeURIComponent('epic-9/task-3')}`);
    const heading = await page.locator('h1').innerText();
    expect(heading).not.toContain('Rebuild the settings screen');
    expect(heading).not.toMatch(/[0-9a-f]{8}/);
    await expect(page.getByText(OBJECTIVE)).toBeVisible();
  });

  for (const [name, vp] of [
    ['desktop', VIEWPORTS.desktop],
    ['mobile', { width: 375, height: 812 }],
  ] as const) {
    test(`screenshot: the board at ${name}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await setTheme(page, 'light');
      await mockBoard(page);
      await page.goto('/work/kanban');
      await settleForShot(page, page.locator('.bs-kanban-card').first());
      await shoot(page, `short-task-name-kanban-${name}-light`);
    });
  }

  test('screenshot: the peek and the task page at desktop', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await setTheme(page, 'light');
    await mockBoard(page);
    await mockDetail(page, TITLED.taskId, 'Settings layout page');
    await page.goto('/work/kanban');
    await page
      .locator('.bs-kanban-card')
      .filter({ hasText: 'Settings layout page' })
      .first()
      .locator('.bs-kanban-card__open')
      .click();
    await settleForShot(page, page.getByRole('dialog'));
    await shoot(page, 'short-task-name-peek-desktop-light');
    await mockDetail(page, 'epic-9/task-3', 'Settings layout page');
    await page.goto(`/tasks/${encodeURIComponent('epic-9/task-3')}`);
    await settleForShot(page, page.locator('h1'));
    await shoot(page, 'short-task-name-task-page-desktop-light');
  });
});
