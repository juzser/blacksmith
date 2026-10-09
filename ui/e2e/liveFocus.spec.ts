// Kanban Now / Next marks: what live CLI sessions work on and do next, laid
// on the cards. /api/cli-sessions and /api/active-scope are stubbed, as are the
// board's tasks, so the marks do not depend on what the fixture db holds.
import type { Page } from '@playwright/test';
import type { KanbanTask } from '../src/lib/api.js';
import { stubActiveScope } from './activeScopeStub.js';
import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

const PHONE = { width: 375, height: 812 };
const HOME = { id: 'home', label: 'home' };

function task(epic: string, slug: string, taskStatus: string, project: string): KanbanTask {
  return {
    taskId: `${epic}/${slug}`,
    taskStatus,
    title: `Task ${slug} of ${epic}`,
    agentRole: null,
    agentModelTier: null,
    agentActivity: taskStatus === 'in-progress' ? 'working' : null,
    milestoneId: null,
    tags: { case: null, origin: null, severity: null },
    updatedAt: '2026-01-01T00:00:00.000Z',
    project,
    attemptCount: 0,
    judgeRound: null,
    commentCount: 0,
    prUrl: null,
    dependencies: [],
    epicLabel: `${project}: ${epic}`,
    hasRequest: false,
    requestFirstLine: null,
    parentTaskId: null,
    parentTitle: null,
  };
}

// Each epic: one finished task, one todo, the one a session works on, the one it picks up next.
function epicTasks(epic: string, project: string): KanbanTask[] {
  return [
    task(epic, 'task-1', 'completed', project),
    task(epic, 'task-2', 'todo', project),
    task(epic, 'task-3', 'in-progress', project),
    task(epic, 'task-4', 'todo', project),
  ];
}

async function stubBoard(page: Page): Promise<void> {
  const tasks = [...epicTasks('epic-9', 'demo-hub'), ...epicTasks('epic-1', 'blacksmith')];
  const byStatus = (s: string) => tasks.filter((t) => t.taskStatus === s);
  await page.route('**/api/kanban*', (route) =>
    route.fulfill({
      json: ['todo', 'in-progress', 'completed'].map((taskStatus) => ({
        taskStatus,
        tasks: byStatus(taskStatus),
      })),
    }),
  );
}

function session(id: string, project: string, epic: string, role: string, next: string | null) {
  const nextTask = next ? { taskId: `${epic}/${next}`, taskTitle: `Task ${next}` } : null;
  return {
    cliSessionId: id,
    name: null,
    cwdLabel: 'workspace-a',
    status: 'working',
    statusSince: FIXTURE_NOW_ISO,
    focus: {
      store: HOME,
      project,
      epicId: epic,
      epicTitle: null,
      wave: 1,
      now: [{ role, taskId: `${epic}/task-3`, taskTitle: 'Task task-3', since: FIXTURE_NOW_ISO }],
      next: nextTask ? { kind: 'task', ...nextTask } : { kind: 'waiting_on_you' },
    },
    linked: {
      epics: [
        {
          store: HOME,
          epicId: epic,
          closed: false,
          workingAgents: [{ role, taskId: `${epic}/task-3`, since: FIXTURE_NOW_ISO }],
          focusParts: { nextTask },
        },
      ],
    },
  };
}

async function stubSessions(page: Page, sessions: unknown[]): Promise<void> {
  await page.route('**/api/cli-sessions*', (route) =>
    route.fulfill({
      json: {
        state: 'ok',
        configSource: 'default',
        readAt: FIXTURE_NOW_ISO,
        formatWarning: null,
        hidden: { outOfScope: 0, dead: 0, unparsed: 0, nonInteractive: 0 },
        sessions,
      },
    }),
  );
}

const TWO_LIVE = [
  session('cli-1', 'demo-hub', 'epic-9', 'coder', 'task-4'),
  session('cli-2', 'blacksmith', 'epic-1', 'tester', 'task-4'),
];

async function openBoard(page: Page): Promise<void> {
  await stubBoard(page);
  await stubSessions(page, TWO_LIVE);
  await stubActiveScope(page, ['epic-9', 'epic-1']);
  await page.goto('/work/kanban');
}

test.describe('Kanban: Now and Next marks', () => {
  test('desktop: each epic column leads with its Now card, then its Next card', async ({
    page,
  }) => {
    await setTheme(page, 'light');
    await page.setViewportSize(VIEWPORTS.desktop);
    await openBoard(page);
    const columns = page.locator('.bs-kanban-col');
    await expect(columns).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const cards = columns.nth(i).locator('.bs-kanban-card');
      await expect(cards.nth(0)).toContainText(/Now · (Builder|Tester)/);
      await expect(cards.nth(1)).toContainText('Next');
      await expect(cards.nth(2)).not.toContainText(/Now ·|Next/);
    }
    await expect(
      page.getByRole('button', { name: /Task task-3 of epic-9, now Builder, opens task detail/ }),
    ).toBeVisible();
    await settleForShot(page, page.locator('.bs-kanban-card__mark').first());
    await shoot(page, 'work-kanban-now-next-desktop-light');
  });

  test('dark: the Now and Next tags are readable', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.setViewportSize(VIEWPORTS.desktop);
    await openBoard(page);
    const marks = page.locator('.bs-kanban-card__mark');
    await expect(marks).toHaveCount(4);
    for (const mark of await marks.all()) {
      const { fg, bg } = await mark.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { fg: cs.color, bg: cs.backgroundColor };
      });
      expect(fg).not.toBe(bg);
    }
    await settleForShot(page, marks.first());
    await shoot(page, 'work-kanban-now-next-desktop-dark');
  });

  test('phone: one tag slot, 44px targets, two-line titles, no sideways scroll', async ({
    page,
  }) => {
    await setTheme(page, 'light');
    await page.setViewportSize(PHONE);
    await openBoard(page);
    const cards = page.locator('.bs-kanban-col:visible .bs-kanban-card');
    await expect(cards.first()).toBeVisible();
    await expect(cards.first().locator('.bs-kanban-card__mark')).toHaveCount(1);
    await expect(cards.first().locator('.bs-tag')).toHaveCount(1);
    for (const card of await cards.all()) {
      const open = await card.locator('.bs-kanban-card__open').boundingBox();
      expect(open?.height).toBeGreaterThanOrEqual(44);
      const lines = await card.locator('.bs-kanban-card__title').evaluate((el) => {
        const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
        return el.getBoundingClientRect().height / lineHeight;
      });
      expect(lines).toBeLessThanOrEqual(2.01);
    }
    const overflow = await page.evaluate(() => {
      const board = document.querySelector('.bs-kanban-board');
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        board: board ? board.scrollWidth - board.clientWidth : 0,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.board).toBeLessThanOrEqual(0);
    await settleForShot(page, cards.first());
    await shoot(page, 'work-kanban-now-next-phone375-light');
  });

  test('desktop: a Next fix stacked in a follow-up group lifts the group and tags it', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    const fix = (slug: string, updatedAt: string): KanbanTask => ({
      ...task('epic-9', slug, 'todo', 'demo-hub'),
      title: `Fix ${slug}`,
      parentTaskId: 'epic-9/task-2',
      parentTitle: 'Task task-2',
      updatedAt,
    });
    const tasks = [
      ...epicTasks('epic-9', 'demo-hub'),
      ...epicTasks('epic-1', 'blacksmith'),
      fix('task-5', '2026-01-03T00:00:00.000Z'),
      fix('task-6', '2026-01-02T00:00:00.000Z'),
      fix('task-4', '2026-01-01T00:00:00.000Z'),
    ].filter((t) => t.taskId !== 'epic-9/task-4' || t.parentTaskId !== null);
    await page.route('**/api/kanban*', (route) =>
      route.fulfill({
        json: ['todo', 'in-progress', 'completed'].map((taskStatus) => ({
          taskStatus,
          tasks: tasks.filter((t) => t.taskStatus === taskStatus),
        })),
      }),
    );
    await stubSessions(page, TWO_LIVE);
    await stubActiveScope(page, ['epic-9', 'epic-1']);
    await page.goto('/work/kanban');
    const items = page
      .locator('.bs-kanban-col', { hasText: 'Task task-3 of epic-9' })
      .locator('.bs-kanban-col__list > li');
    await expect(items.nth(0)).toContainText(/Now · Builder/);
    const group = items.nth(1).locator('.bs-kanban-group');
    await expect(group.locator('.bs-kanban-group__summary')).toContainText('Next');
    await expect(group.locator('.bs-kanban-group__summary')).not.toContainText('Now');
    await expect(group).not.toHaveAttribute('open', '');
    await group.locator('.bs-kanban-group__summary').click();
    const rows = group.locator('.bs-kanban-group__row');
    await expect(rows.first()).toContainText('Fix task-4');
    await expect(rows.first()).toContainText('Next');
    await expect(rows.nth(1)).not.toContainText('Next');
  });

  test('an epic waiting on you gets one muted line', async ({ page }) => {
    await stubBoard(page);
    await stubSessions(page, [session('cli-1', 'demo-hub', 'epic-9', 'coder', null)]);
    await stubActiveScope(page, ['epic-9']);
    await page.goto('/work/kanban');
    await expect(page.getByText('demo-hub · epic-9: Waiting on you')).toBeVisible();
  });

  test('nothing live: the existing line, and no tags', async ({ page }) => {
    await stubBoard(page);
    await stubSessions(page, []);
    await stubActiveScope(page, [], { liveSessions: 0 });
    await page.goto('/work/kanban');
    await expect(page.getByText('Nothing is active right now. ·')).toBeVisible();
    await expect(page.locator('.bs-kanban-card__mark')).toHaveCount(0);
  });

  test('unmeasured: the note, and no tags even with sessions on offer', async ({ page }) => {
    await stubBoard(page);
    await stubSessions(page, TWO_LIVE);
    await stubActiveScope(page, [], { measured: false, liveSessions: 0 });
    await page.goto('/work/kanban');
    await expect(page.getByText("Live sessions can't be read here")).toBeVisible();
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();
    await expect(page.locator('.bs-kanban-card__mark')).toHaveCount(0);
  });
});
