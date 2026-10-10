// Kanban follow-up group: the Now / Next tag on a group's summary and on its
// fix rows. The tag text is never clipped mid-word, the time or the status tag
// drops to the next line first, and the role label ellipsizes only when the
// tag alone is wider than the row. Nothing in a row paints outside the group
// card or the row's focus ring. The board, the live sessions and the active
// scope are stubbed, so the tags do not depend on what the fixture db holds.
import type { Locator, Page } from '@playwright/test';
import type { KanbanTask } from '../src/lib/api.js';
import { stubActiveScope } from './activeScopeStub.js';
import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

const PHONE = { width: 375, height: 812 };
const NARROW = { width: 320, height: 812 };
const HOME = { id: 'home', label: 'home' };
const PARENT = 'Reconcile migration ledger with store snapshots';
const TWO_ROLES = ['coder', 'tester'];
const LONG_ROLES = ['security-reviewer', 'spec-reviewer'];
const TWO_ROLES_TEXT = 'Now · Builder + Tester · stalled';
const LONG_ROLES_TEXT = 'Now · Security reviewer + Plan reviewer · stalled';

function task(
  epic: string,
  slug: string,
  taskStatus: string,
  project: string,
  over: Partial<KanbanTask> = {},
): KanbanTask {
  return {
    taskId: `${epic}/${slug}`,
    taskStatus,
    title: `Task ${slug} of ${epic}`,
    agentRole: taskStatus === 'in-progress' ? 'coder' : null,
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
    ...over,
    taskTitle: over.taskTitle ?? over.title ?? `Task ${slug} of ${epic}`,
    parentTaskTitle: over.parentTaskTitle ?? over.parentTitle ?? null,
  };
}

// epic-9 has a plain Now card; epic-1 stacks three fixes of task-2 into one
// group, and the first fix is the one a session works on (stalled).
function board(): KanbanTask[] {
  const fix = (slug: string, day: number, over: Partial<KanbanTask> = {}) =>
    task('epic-1', slug, 'in-progress', 'blacksmith', {
      title: `Fix ${slug}`,
      parentTaskId: 'epic-1/task-2',
      parentTitle: PARENT,
      updatedAt: `2026-01-0${day}T00:00:00.000Z`,
      ...over,
    });
  return [
    task('epic-9', 'task-1', 'completed', 'demo-hub'),
    task('epic-9', 'task-2', 'todo', 'demo-hub'),
    task('epic-9', 'task-3', 'in-progress', 'demo-hub'),
    task('epic-9', 'task-4', 'todo', 'demo-hub'),
    task('epic-1', 'task-1', 'completed', 'blacksmith'),
    task('epic-1', 'task-2', 'in-progress', 'blacksmith'),
    task('epic-1', 'task-6', 'todo', 'blacksmith'),
    fix('fb-1', 1, { title: 'Fix fb-1 stalled', agentActivity: 'stalled' }),
    fix('fb-2', 2),
    fix('fb-3', 3),
  ];
}

function session(id: string, project: string, epic: string, now: [string, string][], next: string) {
  const nextTask = { taskId: `${epic}/${next}`, taskTitle: `Task ${next}` };
  const agents = now.map(([role, slug]) => ({ role, taskId: `${epic}/${slug}` }));
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
      now: agents.map((a) => ({ ...a, taskTitle: a.taskId, since: FIXTURE_NOW_ISO })),
      next: { kind: 'task', ...nextTask },
    },
    linked: {
      epics: [
        {
          store: HOME,
          epicId: epic,
          closed: false,
          workingAgents: agents.map((a) => ({ ...a, since: FIXTURE_NOW_ISO })),
          focusParts: { nextTask },
        },
      ],
    },
  };
}

async function openBoard(page: Page, roles: string[]): Promise<void> {
  const tasks = board();
  await page.route('**/api/kanban*', (route) =>
    route.fulfill({
      json: ['todo', 'in-progress', 'completed'].map((taskStatus) => ({
        taskStatus,
        tasks: tasks.filter((t) => t.taskStatus === taskStatus),
      })),
    }),
  );
  const sessions = [
    session('cli-1', 'demo-hub', 'epic-9', [['coder', 'task-3']], 'task-4'),
    session(
      'cli-2',
      'blacksmith',
      'epic-1',
      roles.map((role) => [role, 'fb-1']),
      'task-6',
    ),
  ];
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
  await stubActiveScope(page, ['epic-9', 'epic-1']);
  await page.goto('/work/kanban');
}

/** The board's one follow-up group, with its tag in place; on a phone, its column's tab first. */
async function group(page: Page, roles: string[] = TWO_ROLES): Promise<Locator> {
  await openBoard(page, roles);
  const width = page.viewportSize()?.width ?? 0;
  if (width <= 640) {
    await page
      .getByRole('tablist', { name: 'Kanban columns' })
      .getByRole('tab', { name: /epic-1/ })
      .click();
  }
  const found = page.locator('.bs-kanban-group:visible');
  await expect(found).toHaveCount(1);
  await expect(found.locator('.bs-kanban-group__summary .bs-kanban-card__mark')).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return found;
}

async function openGroup(found: Locator): Promise<void> {
  await found.locator('.bs-kanban-group__summary').click();
  await expect(found).toHaveAttribute('open', '');
  await expect(found.locator('.bs-kanban-group__row').first()).toBeVisible();
}

/** The tag's text and whether the tag box or its label is cut. */
function tagFit(tag: Locator) {
  return tag.evaluate((el) => {
    const label = el.querySelector('.bs-agent-chip__text') as HTMLElement;
    return {
      text: label.textContent?.trim() ?? '',
      tagCut: el.scrollWidth > el.clientWidth,
      labelCut: label.scrollWidth > label.clientWidth,
    };
  });
}

/** Meta items (summary and rows) that end past the group card's content box. */
function pastTheCard(found: Locator) {
  return found.evaluate((g) => {
    const cs = getComputedStyle(g);
    const right =
      g.getBoundingClientRect().right -
      Number.parseFloat(cs.borderRightWidth) -
      Number.parseFloat(cs.paddingRight);
    const out: string[] = [];
    const items = g.querySelectorAll('.bs-kanban-group__meta > *, .bs-kanban-group__row-meta > *');
    for (const el of items) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > right + 0.5) {
        out.push(`"${el.textContent?.trim()}" ends at ${r.right.toFixed(1)} > ${right.toFixed(1)}`);
      }
    }
    return out;
  });
}

/**
 * Keyboard-focuses the open group's marked row, then lists the row's meta
 * items that reach past the inner edge of its focus ring (the open button's
 * box grown by the outline offset).
 */
async function pastTheRing(page: Page, found: Locator): Promise<{ ring: string; out: string[] }> {
  await found.locator('.bs-kanban-group__summary').focus();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    const marked = await page.evaluate(() => {
      const el = document.activeElement;
      return (
        !!el?.classList.contains('bs-kanban-group__row-open') &&
        / now /.test(el.getAttribute('aria-label') ?? '')
      );
    });
    if (marked) break;
  }
  return page.evaluate(() => {
    const open = document.activeElement as HTMLElement;
    const cs = getComputedStyle(open);
    const grow = Number.parseFloat(cs.outlineOffset);
    const box = open.getBoundingClientRect();
    const row = open.closest('.bs-kanban-group__row') as HTMLElement;
    const out: string[] = [];
    for (const el of row.querySelectorAll('.bs-kanban-group__row-meta > *')) {
      const r = el.getBoundingClientRect();
      if (
        r.right > box.right + grow + 0.5 ||
        r.left < box.left - grow - 0.5 ||
        r.bottom > box.bottom + grow + 0.5 ||
        r.top < box.top - grow - 0.5
      ) {
        out.push(`"${el.textContent?.trim()}" ${r.left.toFixed(1)}..${r.right.toFixed(1)}`);
      }
    }
    return {
      ring: `${open.className} ${cs.outlineStyle} ${cs.outlineWidth}`,
      out,
    };
  });
}

/** Where a tap on the button lands on it: the widest run across its centre and the tallest down it. */
function tapArea(button: Locator) {
  return button.evaluate((btn) => {
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hits = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      return !!el && btn.contains(el);
    };
    let across = 0;
    for (let x = Math.floor(r.left) - 8; x < r.right + 8; x++) if (hits(x + 0.5, cy)) across++;
    let down = 0;
    for (let y = Math.floor(r.top) - 8; y < r.bottom + 8; y++) if (hits(cx, y + 0.5)) down++;
    return { box: { w: r.width, h: r.height }, across, down };
  });
}

test.describe('Kanban follow-up group: Now / Next tags', () => {
  for (const [name, viewport] of [
    ['desktop', VIEWPORTS.desktop],
    ['phone', PHONE],
  ] as const) {
    test(`${name}: the summary tag reads in full, closed and open`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const found = await group(page);
      const tag = found.locator('.bs-kanban-group__summary .bs-kanban-card__mark');
      expect(await tagFit(tag)).toEqual({ text: TWO_ROLES_TEXT, tagCut: false, labelCut: false });
      await openGroup(found);
      expect(await tagFit(tag)).toEqual({ text: TWO_ROLES_TEXT, tagCut: false, labelCut: false });
    });
  }

  test('desktop: an open group keeps every row inside the card and its focus ring', async ({
    page,
  }) => {
    await setTheme(page, 'light');
    await page.setViewportSize(VIEWPORTS.desktop);
    const found = await group(page);
    await openGroup(found);
    const rowTag = found.locator('.bs-kanban-group__row .bs-kanban-card__mark');
    expect(await tagFit(rowTag)).toEqual({ text: TWO_ROLES_TEXT, tagCut: false, labelCut: false });
    expect(await pastTheCard(found)).toEqual([]);
    const ring = await pastTheRing(page, found);
    expect(ring.ring).toContain('bs-kanban-group__row-open solid');
    expect(ring.out).toEqual([]);
    await page.mouse.move(0, 0);
    await settleForShot(page, rowTag);
    await shoot(page, 'work-kanban-group-now-desktop-light');
  });

  test('phone: an open group keeps every row inside the card and its focus ring', async ({
    page,
  }) => {
    await setTheme(page, 'dark');
    await page.setViewportSize(PHONE);
    const found = await group(page);
    await openGroup(found);
    const rowTag = found.locator('.bs-kanban-group__row .bs-kanban-card__mark');
    expect(await tagFit(rowTag)).toEqual({ text: TWO_ROLES_TEXT, tagCut: false, labelCut: false });
    expect(await pastTheCard(found)).toEqual([]);
    const ring = await pastTheRing(page, found);
    expect(ring.ring).toContain('bs-kanban-group__row-open solid');
    expect(ring.out).toEqual([]);
    await settleForShot(page, rowTag);
    await shoot(page, 'work-kanban-group-now-phone375-dark');
  });

  test('320: a tag wider than the row ellipsizes inside it and keeps its full name', async ({
    page,
  }) => {
    await setTheme(page, 'light');
    await page.setViewportSize(NARROW);
    const found = await group(page, LONG_ROLES);
    const summary = found.locator('.bs-kanban-group__summary');
    await expect(summary).toHaveAttribute(
      'aria-label',
      `3 fixes for ${PARENT}, now Security reviewer and Plan reviewer, expand/collapse`,
    );
    const summaryTag = summary.locator('.bs-kanban-card__mark');
    expect(await tagFit(summaryTag)).toEqual({
      text: LONG_ROLES_TEXT,
      tagCut: false,
      labelCut: true,
    });
    await openGroup(found);
    const rowOpen = found.locator('.bs-kanban-group__row-open').first();
    await expect(rowOpen).toHaveAttribute(
      'aria-label',
      'Fix fb-1 stalled, now Security reviewer and Plan reviewer, opens task detail',
    );
    const rowTag = found.locator('.bs-kanban-group__row .bs-kanban-card__mark');
    expect(await tagFit(rowTag)).toEqual({ text: LONG_ROLES_TEXT, tagCut: false, labelCut: true });
    expect(await pastTheCard(found)).toEqual([]);
    const ring = await pastTheRing(page, found);
    expect(ring.out).toEqual([]);
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(0);
    await settleForShot(page, rowTag);
    await shoot(page, 'work-kanban-group-now-phone320-light');
  });

  test('desktop: the tag box is the same on a card and in a group', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    const found = await group(page);
    await openGroup(found);
    const box = (tag: Locator) =>
      tag.evaluate((el) => {
        const cs = getComputedStyle(el);
        const icon = el.querySelector('svg')?.getBoundingClientRect();
        return {
          height: el.getBoundingClientRect().height,
          padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
          font: `${cs.fontSize} ${cs.fontWeight}`,
          icon: icon ? `${icon.width}x${icon.height}` : null,
        };
      });
    const card = await box(
      page
        .locator('.bs-kanban-card', { hasText: 'Task task-3 of epic-9' })
        .locator('.bs-kanban-card__mark'),
    );
    expect(card).toEqual({
      height: 20,
      padding: '0px 8px 0px 8px',
      font: '12px 500',
      icon: '14x14',
    });
    expect(await box(found.locator('.bs-kanban-group__summary .bs-kanban-card__mark'))).toEqual(
      card,
    );
    expect(await box(found.locator('.bs-kanban-group__row .bs-kanban-card__mark'))).toEqual(card);
  });

  test('phone: the copy-id icon in a fix row and on a card takes a 44px tap', async ({ page }) => {
    await page.setViewportSize(PHONE);
    const found = await group(page);
    await openGroup(found);
    const rowCopy = found.locator('.bs-kanban-group__row .bs-kanban-card__title-copy .bs-iconbtn');
    const cardCopy = page
      .locator('.bs-kanban-col:visible .bs-kanban-card .bs-kanban-card__title-copy .bs-iconbtn')
      .first();
    for (const [where, button] of [
      ['fix row', rowCopy.first()],
      ['card', cardCopy],
    ] as const) {
      const area = await tapArea(button);
      console.log(`copy-id ${where} at 375: ${JSON.stringify(area)}`);
      expect(area.box.w).toBeGreaterThanOrEqual(44);
      expect(area.box.h).toBeGreaterThanOrEqual(44);
      expect(area.across).toBeGreaterThanOrEqual(44);
      expect(area.down).toBeGreaterThanOrEqual(44);
    }
  });
});
