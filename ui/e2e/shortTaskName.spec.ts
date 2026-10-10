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
async function mockDetail(
  page: Page,
  taskId: string,
  title: string | null,
  extra: { taskStatus?: string; parentTaskId?: string; parentTaskTitle?: string } = {},
) {
  const detailPath = `/api/tasks/${encodeURIComponent(taskId)}`;
  await page.route(
    (url) => url.pathname === detailPath,
    async (route) => {
      // A task the fixture store does not hold borrows the shape of one it does.
      const known = 'epic-9/task-3';
      const url = route
        .request()
        .url()
        .replace(encodeURIComponent(taskId), encodeURIComponent(known));
      const response = await route.fetch({ url });
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          parentTaskId: extra.parentTaskId ?? null,
          parentTaskTitle: extra.parentTaskTitle ?? null,
          task: {
            ...body.task,
            taskId,
            title,
            objective: OBJECTIVE,
            ...(extra.taskStatus ? { taskStatus: extra.taskStatus } : {}),
          },
        },
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

  test('the peek and the task page name a minted follow-up after its parent, as the card does', async ({
    page,
  }) => {
    const parent = { parentTaskId: 'epic-9/task-3', parentTaskTitle: 'Settings layout page' };
    await mockBoard(page);
    await mockDetail(page, MINTED.taskId, null, { ...parent, taskStatus: 'in-progress' });
    await page.goto('/work/kanban');
    await page
      .locator('.bs-kanban-card')
      .filter({ hasText: 'Follow-up fix · Settings layout page' })
      .locator('.bs-kanban-card__open')
      .click();
    const peek = page.getByRole('dialog');
    await expect(peek.locator('.bs-dialog__title')).toHaveText(
      'Follow-up fix · Settings layout page',
    );
    // The status reads as on the task page: "In Progress", not the raw slug.
    await expect(peek.locator('.bs-task-peek__meta .bs-tag').first()).toHaveText('In Progress');
    await page.goto(`/tasks/${encodeURIComponent(MINTED.taskId)}`);
    await expect(page.locator('h1')).toHaveText('Follow-up fix · Settings layout page');
  });

  test('a follow-up with no known parent stays "Follow-up fix" in the peek', async ({ page }) => {
    await mockBoard(page);
    await mockDetail(page, ORPHAN.taskId, null);
    await page.goto('/work/kanban');
    await page
      .locator('.bs-kanban-card')
      .filter({ hasText: /^Follow-up fix(?! ·)/ })
      .locator('.bs-kanban-card__open')
      .click();
    await expect(page.getByRole('dialog').locator('.bs-dialog__title')).toHaveText('Follow-up fix');
  });

  test('320px: a follow-up of a long-named parent stays on its card and the page does not scroll sideways', async ({
    page,
  }) => {
    const long = 'Reconcile the migration ledger with every store snapshot';
    const parentA = card('epic-a/task-5', { taskTitle: long });
    const parentB = card('epic-b/task-1', { taskTitle: long });
    const fixes = [
      card('epic-a/followup-0a1b2c3d', {
        title: FIX_OBJECTIVE,
        parentTaskId: parentA.taskId,
        parentTaskTitle: long,
      }),
      card('epic-b/followup-1b2c3d4e', {
        title: FIX_OBJECTIVE,
        parentTaskId: parentB.taskId,
        parentTaskTitle: long,
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
      card('epic-b/followup-2c3d4e5f', {
        title: FIX_OBJECTIVE,
        parentTaskId: parentB.taskId,
        parentTaskTitle: long,
      }),
    ];
    await page.route('**/api/kanban*', (route) =>
      route.fulfill({
        json: [{ taskStatus: 'todo', tasks: [parentA, parentB, ...fixes] }],
      }),
    );
    await page.setViewportSize({ width: 320, height: 812 });
    await page.goto('/work/kanban');
    // The board cuts a title longer than two lines with an ellipsis, so the
    // card is found by the start of its name.
    const single = page.locator('.bs-kanban-card').filter({ hasText: 'Follow-up fix · Reconcile' });
    await expect(single).toHaveCount(1);
    const name = single.locator('.bs-kanban-card__title');
    const { height, lineHeight } = await name.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight),
    }));
    expect(height).toBeLessThanOrEqual(2 * lineHeight + 1);
    const group = page.locator('.bs-kanban-group').first();
    await expect(group).toBeVisible();
    for (const box of [single, group]) {
      const fits = await box.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          view: window.innerWidth,
          scroll: el.scrollWidth,
          client: el.clientWidth,
        };
      });
      expect(fits.left).toBeGreaterThanOrEqual(0);
      expect(fits.right).toBeLessThanOrEqual(fits.view);
      // scrollWidth and clientWidth are rounded separately, so allow 1px.
      expect(fits.scroll).toBeLessThanOrEqual(fits.client + 1);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
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
