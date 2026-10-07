import type { ActiveScopeResult, KanbanTask } from '../src/lib/api.js';
import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

// Two epics from two different projects. A bare /work/kanban carries no project
// scope, so both are on the same board — which is what makes "every epic"
// something a card can be counted for rather than only a heading to read.
const SCOPED_EPIC = 'epic-9'; // multiProjectFixture.ts, project demo-hub

// 375px is the brief's own mobile breakpoint for the no-horizontal-scroll
// check — distinct from helpers.ts's shared VIEWPORTS.mobile (390px), which
// every existing screenshot baseline is already pinned to. A second, local
// viewport here avoids forcing a full baseline regeneration for an assertion
// that only needs one extra, narrower width.
const NARROW_VIEWPORT = { width: 375, height: 812 };

/** Full `KanbanTask` shape (ui/src/lib/api.ts) for a `page.route` stub board. */
function task(taskId: string, taskStatus: string): KanbanTask {
  return {
    taskId,
    taskStatus,
    title: taskId,
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
  };
}

/** A follow-up card as the server projects it: the finding summary as title, plus its parent. */
function fix(
  name: string,
  summary: string,
  parent: { id: string; title: string | null },
  updatedAt: string,
  taskStatus = 'todo',
): KanbanTask {
  return {
    ...task(`epic-a/followup-${name}`, taskStatus),
    title: `Fix: ${summary}`,
    updatedAt,
    parentTaskId: parent.id,
    parentTitle: parent.title,
  };
}

const SETTINGS = { id: 'epic-a/task-1-settings-layout', title: 'Settings layout' };
const BILLING = { id: 'epic-a/task-2-billing-page', title: 'Billing page' };

/** A board with one parent holding three follow-ups, another holding exactly one. */
function followupBoard() {
  return [
    {
      taskStatus: 'todo',
      tasks: [
        fix(
          '0a1b2c3d',
          'The settings form loses its unsaved changes when the tab is switched',
          SETTINGS,
          '2026-01-03T00:00:00.000Z',
        ),
        fix(
          '1b2c3d4e',
          'Wrap long labels in the settings sidebar',
          SETTINGS,
          '2026-01-02T00:00:00.000Z',
        ),
        fix(
          '2c3d4e5f',
          'Keep the save button visible while scrolling',
          SETTINGS,
          '2026-01-01T00:00:00.000Z',
        ),
        fix(
          '3d4e5f6a',
          'Show the invoice total with the currency symbol',
          BILLING,
          '2026-01-04T00:00:00.000Z',
        ),
      ],
    },
    { taskStatus: 'in-progress', tasks: [task('epic-a/task-3', 'in-progress')] },
    { taskStatus: 'failed', tasks: [task('epic-a/task-4', 'failed')] },
    { taskStatus: 'completed', tasks: [task('epic-a/task-5', 'completed')] },
  ];
}

/**
 * The board the group screenshots use: a three-fix group that stays collapsed
 * (newest, so it sits first) and a seven-fix group, two of them live, that is
 * opened — so the shot shows a collapsed group, an expanded one, the live chip
 * and "+1" on the summary, and the "Show 2 more" row past the five-row cap.
 */
function richFollowupBoard() {
  const live = (t: KanbanTask): KanbanTask => ({
    ...t,
    agentRole: 'coder',
    agentModelTier: 'mid',
    agentActivity: 'working',
  });
  const reports = [
    'The invoice total drops its currency symbol',
    'Keep the pagination footer pinned on long tables',
    'Retry the export when the connection resets',
    'Show the due date in the viewer time zone',
    'Round tax lines the same way on every page',
    'Stop the receipt preview from flickering',
    'Link each invoice row to its customer',
  ];
  const billing = reports.map((summary, i) => {
    const t = fix(`b${i}`, summary, BILLING, `2026-01-0${7 - i}T00:00:00.000Z`);
    return i < 2 ? live(t) : t;
  });
  const settings = [
    ['s0', 'The settings form loses its unsaved changes when the tab is switched'],
    ['s1', 'Wrap long labels in the settings sidebar'],
    ['s2', 'Keep the save button visible while scrolling'],
  ].map(([name = '', summary = ''], i) =>
    fix(name, summary, SETTINGS, `2026-01-1${3 - i}T00:00:00.000Z`),
  );
  return [
    { taskStatus: 'todo', tasks: [...settings, ...billing] },
    { taskStatus: 'in-progress', tasks: [task('epic-a/task-3', 'in-progress')] },
    { taskStatus: 'failed', tasks: [task('epic-a/task-4', 'failed')] },
    { taskStatus: 'completed', tasks: [task('epic-a/task-5', 'completed')] },
  ];
}

async function mockBoard(
  page: import('@playwright/test').Page,
  columns: Array<{ taskStatus: string; tasks: ReturnType<typeof task>[] }>,
) {
  await page.route('**/api/kanban*', (route) => route.fulfill({ json: columns }));
}

// A board shaped like the real one: four status columns, so each column keeps
// its 280px desktop width. A board of one column stretches to the free width
// (~650px at 1440), which hides any card-width overflow.
function fourColumnBoard(card: ReturnType<typeof task>) {
  return [
    { taskStatus: 'todo', tasks: [card] },
    { taskStatus: 'in-progress', tasks: [task('epic-1/task-2', 'in-progress')] },
    { taskStatus: 'failed', tasks: [task('epic-1/task-3', 'failed')] },
    { taskStatus: 'completed', tasks: [task('epic-1/task-4', 'completed')] },
  ];
}

// The picker follows the Active/All scope (`?scope=`). `/api/active-scope` is
// stubbed per test: which epics a live CLI session drives is not something the
// fixture db can say.
async function stubActiveScope(
  page: import('@playwright/test').Page,
  activeEpics: string[],
  over: Partial<ActiveScopeResult> = {},
) {
  const body: ActiveScopeResult = {
    measured: true,
    readAt: FIXTURE_NOW_ISO,
    liveSessions: activeEpics.length,
    unlinkedSessions: 0,
    projects: [],
    epics: activeEpics.map((epicId) => ({ storeId: 'home', epicId, project: null })),
    factorySessions: [],
    ...over,
  };
  await page.route('**/api/active-scope*', (route) => route.fulfill({ json: body }));
}

test.describe('Kanban: the Active/All scope', () => {
  const picker = (page: import('@playwright/test').Page) =>
    page.getByLabel('Epic', { exact: true });
  const optionValues = (page: import('@playwright/test').Page) =>
    picker(page)
      .locator('option')
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  const toggle = (page: import('@playwright/test').Page) =>
    page.getByRole('navigation', { name: 'Activity scope' });

  test('Active offers only the active epic, no "All epics", and boards its tasks', async ({
    page,
  }) => {
    await stubActiveScope(page, ['epic-9']);
    await page.goto('/work/kanban');
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();
    expect(await optionValues(page)).toEqual(['epic-9']);
    await expect(picker(page)).toHaveValue('epic-9');
    await expect(page.getByRole('option', { name: 'All epics' })).toHaveCount(0);
    await expect(toggle(page).locator('[aria-current="page"]')).toHaveText('Active');
  });

  test('All restores the full list with "All epics" first; Active drops scope from the URL', async ({
    page,
  }) => {
    await stubActiveScope(page, ['epic-9']);
    await page.goto('/work/kanban');
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();
    await toggle(page).getByRole('link', { name: 'All' }).click();
    await expect(page).toHaveURL(/[?&]scope=all\b/);
    await expect
      .poll(() => optionValues(page))
      .toEqual(expect.arrayContaining(['', 'epic-1', 'epic-9']));
    expect((await optionValues(page))[0]).toBe('');
    await toggle(page).getByRole('link', { name: 'Active' }).click();
    await expect(page).not.toHaveURL(/scope=/);
    await expect.poll(() => optionValues(page)).toEqual(['epic-9']);
  });

  test('a pinned ?epic= that is not active stays listed, selected and rendered', async ({
    page,
  }) => {
    await stubActiveScope(page, ['epic-9']);
    await page.goto('/work/kanban?epic=epic-1');
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();
    expect((await optionValues(page)).sort()).toEqual(['epic-1', 'epic-9']);
    await expect(picker(page)).toHaveValue('epic-1');
  });

  test('no live session: the empty line, and Show all works', async ({ page }) => {
    await stubActiveScope(page, [], { liveSessions: 0 });
    await page.goto('/work/kanban');
    await expect(page.getByText('Nothing is active right now. ·')).toBeVisible();
    await expect(page.locator('.bs-kanban-card')).toHaveCount(0);
    await expect(page.getByText(/^\d+ tasks$/)).toHaveCount(0);
    await page.getByRole('link', { name: 'Show all' }).click();
    await expect(page).toHaveURL(/[?&]scope=all\b/);
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();
  });

  test('live sessions but none on an epic: says so, with Show all', async ({ page }) => {
    await stubActiveScope(page, [], { liveSessions: 2, unlinkedSessions: 2 });
    await page.goto('/work/kanban');
    await expect(page.getByText('2 live sessions, none on an epic · Show all')).toBeVisible();
    await expect(page.locator('.bs-kanban-card')).toHaveCount(0);
  });

  test('unmeasured: the full picker and board, plus a note', async ({ page }) => {
    await stubActiveScope(page, [], { measured: false, liveSessions: 0 });
    await page.goto('/work/kanban');
    await expect(page.getByText("Live sessions can't be read here")).toBeVisible();
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();
    expect((await optionValues(page))[0]).toBe('');
    await expect(page.getByText('Nothing is active right now.')).toHaveCount(0);
    await expect(toggle(page)).toBeVisible();
  });

  test('phone: no horizontal scroll, and the toggle and Show all are 44px tall', async ({
    page,
  }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await stubActiveScope(page, ['epic-9']);
    await page.goto('/work/kanban');
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();
    for (const name of ['Active', 'All']) {
      const box = await toggle(page).getByRole('link', { name }).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    const noScroll = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noScroll()).toBe(true);

    await page.unroute('**/api/active-scope*');
    await stubActiveScope(page, [], { liveSessions: 0 });
    await page.goto('/work/kanban');
    const show = page.getByRole('link', { name: 'Show all' });
    await expect(show).toBeVisible();
    expect((await show.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await noScroll()).toBe(true);
  });
});

test.describe('Kanban', () => {
  test('renders the board grouped by status and a11y basics', async ({ page }) => {
    await page.goto('/work/kanban');
    await expect(page.locator('h1')).toHaveText('Work');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.getByRole('region', { name: 'Todo column' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Completed column' })).toBeVisible();
  });

  // Clicking a card now opens the peek panel (pattern 4) rather than
  // navigating directly — only the peek's own "Open full page" link does
  // that, bubbling through KanbanBoard's `open-full` to the page's goToTask.
  test('clicking a task card opens the peek panel, whose "Open full page" link navigates', async ({
    page,
  }) => {
    await page.goto('/work/kanban');
    const firstCard = page.locator('.bs-kanban-card').first();
    await expect(firstCard).toBeVisible();
    // Row 1 no longer renders the id at all (operator fix 2026-10-05); the
    // title-line copy-id IconButton's accessible name is
    // `<full taskId> (click to copy)` — enough to recover the shortId
    // (taskId.split('/').pop()) to confirm the URL names the clicked card's
    // task without needing the full `<epic>/<id>` taskId, which the card
    // never actually renders as plain text.
    const titleCopyLabel = await firstCard
      .locator('.bs-kanban-card__title-copy button')
      .getAttribute('aria-label');
    const fullId = titleCopyLabel?.replace(/ \(click to copy\)$/, '') ?? '';
    const shortId = fullId.split('/').pop();
    await firstCard.click();

    const peek = page.getByRole('dialog');
    await expect(peek).toBeVisible();

    await peek.getByRole('link', { name: 'Open full page' }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/.*${shortId}$`));
    await expect(page.getByRole('tablist', { name: 'Task detail sections' })).toBeVisible();
  });

  // Entered on `?epic=`, not on a bare /work/kanban, because `selectedEpic` starts
  // at ALL_EPICS. Deep-linking to one epic first is what makes the switch a
  // switch, and the epic-9 card the proof that widening the picker widened
  // the board's task list rather than only its heading.
  test('"All epics" option boards tasks across every epic', async ({ page }) => {
    // The card renders no id text at all (row 1 lost it on 2026-10-05; the
    // full id lives only in the title-line copy button's accessible name),
    // so the proof a wider scope boarded more tasks is the toolbar's own task
    // count growing, not a per-card epic prefix the card never renders.
    const taskCountText = () => page.getByText(/^\d+ tasks$/).innerText();
    const taskCount = async () => Number((await taskCountText()).split(' ')[0]);

    await page.goto(`/work/kanban?epic=${SCOPED_EPIC}`);
    await expect.poll(taskCountText).not.toBe('0 tasks');
    const scopedCount = await taskCount();

    await page.getByLabel('Epic', { exact: true }).selectOption('');

    await expect.poll(taskCount).toBeGreaterThan(scopedCount);
    // The widened board still contains a task from the other project's epic.
    await expect(page.getByText(/^\d+ tasks$/)).toBeVisible();
    await expect(page.getByLabel('Epic', { exact: true })).toHaveValue('');
  });

  test('never sits on the skeleton when the epic list is what failed', async ({ page }) => {
    // The epic picker is fed by /api/overview; the board comes from
    // /api/kanban. The picker's fetch ran first and unguarded, so its failure
    // took the whole page down: `loading` never cleared and `error` was never
    // set, leaving the operator on the skeleton row forever — a state
    // indistinguishable from "still loading" (D-222).
    await page.route('**/api/overview*', (route) => route.abort('failed'));
    await page.goto('/work/kanban');
    await expect(page.locator('h1')).toHaveText('Work');
    await expect(page.locator('.bs-skeleton')).toHaveCount(0);
    await expect(page.locator('.bs-banner')).toBeVisible();
    // The board's own endpoint is healthy, so the tasks still arrive.
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();
  });

  // Two rules read the same payload: the server groups by raw task_status and
  // hides nothing, KanbanBoard re-folds those rows and drops `failed` and
  // `superseded` from the default board. The Toolbar summed the first and
  // labelled the second, so it counted cards that were never drawn (D-242).
  test('the toolbar counts the cards the board actually draws', async ({ page }) => {
    await mockBoard(page, [
      { taskStatus: 'todo', tasks: [task('epic-1/task-1', 'todo')] },
      { taskStatus: 'failed', tasks: [task('epic-1/task-2', 'failed')] },
      { taskStatus: 'superseded', tasks: [task('epic-1/task-3', 'superseded')] },
    ]);
    await page.goto('/work/kanban');

    await expect(page.getByText(/^\d+ tasks$/)).toHaveText('1 tasks');
    await expect(page.locator('.bs-kanban-card')).toHaveCount(1);
  });

  // The other half of the same number: a board of nothing but terminal tasks
  // draws no cards, and the empty state is gated on that count.
  test('a board of only hidden statuses says so', async ({ page }) => {
    await mockBoard(page, [
      { taskStatus: 'superseded', tasks: [task('epic-1/task-9', 'superseded')] },
    ]);
    await page.goto('/work/kanban');
    await expect(page.getByText(/^\d+ tasks$/)).toHaveText('0 tasks');
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
    await page.goto('/work/kanban');
    const skeleton = page.locator('.bs-skeleton').first();
    await expect(skeleton).toBeVisible();
    const box = await skeleton.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(100);
  });

  // Operator fix 2026-10-05 removed the id (and its row-1 "Copy task id"
  // button) from row 1 entirely — row 1 is now just the AgentChip and the
  // Quote trigger, `justify-content` replaced by the chip's own
  // `flex: 0 1 auto` (2026-10-06: no longer `1 1 auto` — the chip no longer
  // stretches, see the content-width test below) and the Quote trigger's
  // `margin-left: auto`. Re-pointed from the old "does the id wrap" question
  // (there is no id text left to wrap) to the same underlying risk: a long
  // chip label must still keep row 1 a single line tall, not grow the card.
  test('desktop: row 1 stays one line tall even with a long AgentChip label', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockBoard(
      page,
      fourColumnBoard({
        ...task('epic-1/task-with-a-very-long-skill-install-cli-command-id', 'todo'),
        agentRole: 'coder',
        agentActivity: 'stalled',
        // Well past agentWaitingThresholdMs (4h) so the chip reads
        // "Builder · waiting - a nudge may help" — the longest chip text
        // the fixture can produce.
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await page.goto('/work/kanban');

    const row1 = page.locator('.bs-kanban-card__row--1').first();
    const chip = page.locator('.bs-agent-chip').first();
    await expect(chip).toBeVisible();
    const row1Box = await row1.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(row1Box).not.toBeNull();
    expect(chipBox).not.toBeNull();
    // Small tolerance for border/line-height rounding, not a second line.
    expect(row1Box?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      (chipBox?.height ?? 0) + 4,
    );
  });

  // Operator fix 2026-10-06: the chip no longer stretches across row 1
  // (`flex: 1 1 auto` -> `flex: 0 1 auto`) — on a short label it must stop
  // at its own content width, well short of the room row 1 has left after
  // the Quote trigger.
  test('desktop: a short AgentChip label sits at its own content width, not stretched', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockBoard(
      page,
      fourColumnBoard({
        ...task('epic-1/task-1', 'todo'),
        agentRole: 'coder',
        hasRequest: true,
        requestFirstLine: 'Linked request',
      }),
    );
    await page.goto('/work/kanban');

    const card = page.locator('.bs-kanban-card').first();
    const chip = page.locator('.bs-agent-chip').first();
    await expect(chip).toBeVisible();
    const cardBox = await card.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    // Measured against the card's content box (border 1px + --bs-space-3
    // 12px padding each side), now that nothing else shares row 1. A
    // stretched chip (`flex: 1 1 auto`) would fill it to the right edge; a
    // short label leaves far more than three gaps' worth free.
    const contentRight = (cardBox?.x ?? 0) + (cardBox?.width ?? 0) - 13;
    const chipRight = (chipBox?.x ?? 0) + (chipBox?.width ?? 0);
    expect(contentRight - chipRight).toBeGreaterThan(24);
  });

  // Operator fix 2026-10-06: the "Has a linked request" Quote icon is gone
  // from every card (the request's first line still feeds the summary row).
  test('desktop: no Quote icon on a card, even one with a linked request', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockBoard(
      page,
      fourColumnBoard({
        ...task('epic-1/task-1', 'todo'),
        agentRole: 'coder',
        hasRequest: true,
        requestFirstLine: 'Linked request',
      }),
    );
    await page.goto('/work/kanban');
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();
    await expect(page.locator('.bs-kanban-card__quote')).toHaveCount(0);
    await expect(page.getByLabel('Has a linked request', { exact: true })).toHaveCount(0);
  });

  // A chip-less task renders no row 1 at all: no empty band above the title.
  test('desktop: a card with no AgentChip has no empty row 1 band', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockBoard(page, fourColumnBoard(task('epic-1/task-4', 'todo')));
    await page.goto('/work/kanban');
    const card = page.locator('.bs-kanban-card').first();
    await expect(card).toBeVisible();
    await expect(card.locator('.bs-kanban-card__row--1')).toHaveCount(0);
  });

  // Operator fix 2026-10-06: the copy control is inline, right after the
  // title's last word, on the title's last line; short and wrapped titles.
  for (const [name, title, viewport] of [
    ['short title', 'Fix login', { width: 1440, height: 900 }],
    [
      'wrapped 2-line title',
      'Write the full directory search and indexing docs for ops',
      { width: 1440, height: 900 },
    ],
    ['phone short title', 'Fix login', VIEWPORTS.mobile],
    [
      'phone wrapped title',
      'Write the full directory search and indexing docs for ops',
      VIEWPORTS.mobile,
    ],
  ] as const) {
    test(`${name}: the copy icon sits inline right after the last word`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockBoard(page, fourColumnBoard({ ...task('epic-1/task-4', 'todo'), title }));
      await page.goto('/work/kanban');
      const card = page.locator('.bs-kanban-card').first();
      const icon = card.locator('.bs-kanban-card__title-copy svg');
      await expect(icon).toBeVisible();
      // Geometry of the title's last word (the text node glued to the icon in
      // `.bs-kanban-card__title-tail`), via a Range over it.
      const text = await card.locator('.bs-kanban-card__title-tail').evaluate((tail) => {
        const range = document.createRange();
        const node = tail.firstChild;
        if (!node) throw new Error('title tail has no text node');
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        return { right: r.right, top: r.top, bottom: r.bottom };
      });
      const iconBox = await icon.boundingBox();
      expect(iconBox).not.toBeNull();
      const iconY = (iconBox?.y ?? 0) + (iconBox?.height ?? 0) / 2;
      // Same line as the last word, to its right, within a small gap.
      expect(iconY).toBeGreaterThan(text.top - 1);
      expect(iconY).toBeLessThan(text.bottom + 1);
      expect((iconBox?.x ?? 0) - text.right).toBeGreaterThanOrEqual(0);
      expect((iconBox?.x ?? 0) - text.right).toBeLessThan(12);
      // Small: the glyph is 12px.
      expect(iconBox?.width ?? 99).toBeLessThanOrEqual(13);
    });
  }

  // Deleted: "desktop: a short task id is never truncated at a 280px
  // column". Its whole intent — the id text winning space inside row 1 so a
  // short id ("task-3") stays unclipped at a 280px column — no longer
  // applies: 86285af removed the id text from row 1 outright (it now lives
  // only in the title-line copy button's accessible name, which has no
  // column-width-driven truncation to test).

  // Deleted: "desktop: the copy-id button sits right after the id on a card
  // with no AgentChip". Its whole intent — row 1's `justify-content:
  // space-between` floating the copy-id button to the row's middle when the
  // id was its only sibling — no longer applies: the copy button moved out
  // of row 1 onto the title line (`.bs-kanban-card__title-copy`), where it
  // always sits immediately after the title text regardless of whether
  // row 1's AgentChip renders anything.

  // Same intent as both deleted tests above, retargeted to where the id
  // actually lives now: reachable (an accessible name naming the full id)
  // and copyable (click writes it to the clipboard), on a card with no
  // AgentChip — the layout context the deleted "sits right after" test used
  // — so an empty row 1 is also covered here.
  test('desktop: the title-line copy button makes the full task id reachable and copyable', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockBoard(page, fourColumnBoard(task('epic-1/task-4', 'todo')));
    await page.goto('/work/kanban');

    // `.bs-kanban-card__title-copy` lands on Tooltip's own wrapper span
    // (IconButton.vue: two root nodes, so Vue's attr fallthrough has
    // nowhere single to land) — the accessible name is on the inner
    // `<button>`.
    const copyButton = page.locator('.bs-kanban-card__title-copy button').first();
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toHaveAttribute('aria-label', 'epic-1/task-4 (click to copy)');

    // S3 review fix companion check (desktop never grows the hit box past
    // its glyph, so the icon is already level with the title here): the
    // same centre check the phone test below enforces after the fix.
    const titleTextDesktop = page.locator('.bs-kanban-card__title').first();
    const iconDesktop = copyButton.locator('svg');
    const titleBoxDesktop = await titleTextDesktop.boundingBox();
    const iconBoxDesktop = await iconDesktop.boundingBox();
    expect(titleBoxDesktop).not.toBeNull();
    expect(iconBoxDesktop).not.toBeNull();
    const titleCenterDesktop = (titleBoxDesktop?.y ?? 0) + (titleBoxDesktop?.height ?? 0) / 2;
    const iconCenterDesktop = (iconBoxDesktop?.y ?? 0) + (iconBoxDesktop?.height ?? 0) / 2;
    expect(Math.abs(iconCenterDesktop - titleCenterDesktop)).toBeLessThanOrEqual(3);

    await copyButton.click();
    await expect(copyButton).toHaveAttribute('aria-label', 'Copied');
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('epic-1/task-4');
    // stopPropagation (S3 review fix): the click must not also bubble to the
    // card's own @click and open the peek panel.
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  // S4 review fix, 2026-10-05: onCopyTaskId (KanbanTaskCard.vue) only calls
  // the clipboard lib's single path (clipboard.ts: navigator.clipboard.writeText,
  // no execCommand fallback), so failing that one call is enough to exercise
  // copyToClipboard's `false` return. The handler must stay silent on it:
  // no thrown page error, no "Copied" flash, no peek/detail dialog.
  test('desktop: a failed clipboard write leaves the copy button silent', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('denied')) },
        configurable: true,
      });
    });
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.setViewportSize({ width: 1440, height: 900 });
    await mockBoard(page, fourColumnBoard(task('epic-1/task-4', 'todo')));
    await page.goto('/work/kanban');

    const copyButton = page.locator('.bs-kanban-card__title-copy button').first();
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toHaveAttribute('aria-label', 'epic-1/task-4 (click to copy)');

    await copyButton.click();

    expect(pageErrors).toEqual([]);
    // Still the plain tooltip, never the "Copied" flash a success path would show.
    await expect(copyButton).toHaveAttribute('aria-label', 'epic-1/task-4 (click to copy)');
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  // Operator override 2026-10-06 (ds-spec.md §2.2 TaskCard): the title is
  // clamped to 2 lines AND the inline copy icon stays visible after the last
  // shown word, after an ellipsis when the text was cut. Lines are counted
  // from the text's own line boxes (a Range over the text nodes), never the
  // <p> rect, which the phone 44px hit area could inflate.
  const SLUG_ID =
    'epic-1/task-9-write-the-full-directory-search-and-indexing-docs-for-ops-and-then-keep-going-until-it-is-far-too-long-to-read-on-a-card';
  for (const [name, title, viewport] of [
    [
      'desktop 60-char title',
      'Implement comprehensive middleware migration for MWM modules',
      { width: 1440, height: 900 },
    ],
    ['desktop 120+ char slug fallback', null, { width: 1440, height: 900 }],
    [
      'phone 60-char title',
      'Implement comprehensive middleware migration for MWM modules',
      VIEWPORTS.mobile,
    ],
    ['phone 120+ char slug fallback', null, VIEWPORTS.mobile],
  ] as const) {
    test(`${name}: the title is clamped to 2 lines and the copy icon follows the ellipsis`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await mockBoard(
        page,
        fourColumnBoard({
          ...task(title === null ? SLUG_ID : 'epic-1/task-4', 'todo'),
          title,
        }),
      );
      await page.goto('/work/kanban');
      const card = page.locator('.bs-kanban-card').first();
      const icon = card.locator('.bs-kanban-card__title-copy svg');
      await expect(icon).toBeVisible();
      const para = card.locator('.bs-kanban-card__title');
      // A title that cannot fit 2 lines at this width must end in an ellipsis
      // (the phone column is wide enough for a 60-char title, so it may not).
      const mustCut = title === null || viewport.width > 640;
      if (mustCut) await expect(para).toHaveText(/…$/);
      const text = await para.evaluate((p) => {
        // Only text rects: the button/svg boxes are not text lines.
        const textRects: DOMRect[] = [];
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const r = document.createRange();
          r.selectNodeContents(n);
          for (const rect of r.getClientRects()) if (rect.width > 0) textRects.push(rect);
        }
        const tops = [...new Set(textRects.map((r) => Math.round(r.top)))];
        const lastTop = Math.max(...textRects.map((r) => r.top));
        const last = textRects.filter((r) => r.top >= lastTop - 1);
        return {
          lines: tops.length,
          right: Math.max(...last.map((r) => r.right)),
          top: Math.min(...last.map((r) => r.top)),
          bottom: Math.max(...last.map((r) => r.bottom)),
          text: p.textContent ?? '',
          titleAttr: p.getAttribute('title'),
        };
      });
      expect(text.lines).toBeLessThanOrEqual(2);
      // Ellipsis iff cut, and the full title is on the tooltip only when cut.
      expect(text.text.endsWith('…')).toBe(text.titleAttr !== null);
      if (mustCut) expect(text.titleAttr).toBeTruthy();
      const cardBox = await card.boundingBox();
      const iconBox = await icon.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(iconBox).not.toBeNull();
      const c = cardBox ?? { x: 0, y: 0, width: 0, height: 0 };
      const i = iconBox ?? { x: 0, y: 0, width: 0, height: 0 };
      // Inside the card.
      expect(i.x).toBeGreaterThanOrEqual(c.x);
      expect(i.x + i.width).toBeLessThanOrEqual(c.x + c.width);
      expect(i.y).toBeGreaterThanOrEqual(c.y);
      expect(i.y + i.height).toBeLessThanOrEqual(c.y + c.height);
      // On the last text line, right of the text end.
      const iconY = i.y + i.height / 2;
      expect(iconY).toBeGreaterThan(text.top - 1);
      expect(iconY).toBeLessThan(text.bottom + 1);
      expect(i.x - text.right).toBeGreaterThanOrEqual(0);
      expect(i.x - text.right).toBeLessThan(12);
    });
  }

  // Below 640px .bs-iconbtn grows to the 44px --bs-touch floor
  // (bs-primitives.css ~133-138). The copy button is inline in the title text,
  // so negative margins must keep that hit box out of the line layout: the
  // icon stays level with the title's first line, the title stays one line
  // tall, and the 44px hit area stays inside the card.
  test('phone: the title copy button keeps its 44px hit area without growing the title line', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await mockBoard(page, fourColumnBoard(task('epic-1/task-4', 'todo')));
    await page.goto('/work/kanban');

    const card = page.locator('.bs-kanban-card').first();
    const titleRow = card.locator('.bs-kanban-card__title');
    // The real hit box (what touchTargets.spec.ts's selector measures) is
    // the <button> itself, not Tooltip's non-interactive trigger span
    // (.bs-kanban-card__title-copy) wrapping it: the button keeps its full
    // 44px border box while negative margins keep it out of the line height.
    const copyButton = card.locator('.bs-kanban-card__title-copy button').first();
    const icon = copyButton.locator('svg');
    await expect(copyButton).toBeVisible();

    const cardBox = await card.boundingBox();
    const titleRowBox = await titleRow.boundingBox();
    const copyBox = await copyButton.boundingBox();
    const iconBox = await icon.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(titleRowBox).not.toBeNull();
    expect(copyBox).not.toBeNull();
    expect(iconBox).not.toBeNull();

    const card_ = cardBox ?? { x: 0, y: 0, width: 0, height: 0 };
    const titleRow_ = titleRowBox ?? { x: 0, y: 0, width: 0, height: 0 };
    const copy_ = copyBox ?? { x: 0, y: 0, width: 0, height: 0 };
    const icon_ = iconBox ?? { x: 0, y: 0, width: 0, height: 0 };

    // The title text is one line here, so its own box is the first line.
    const titleLineCenter = titleRow_.y + titleRow_.height / 2;
    const iconCenter = icon_.y + icon_.height / 2;
    expect(Math.abs(iconCenter - titleLineCenter)).toBeLessThanOrEqual(3);

    // The 44px --bs-touch hit area is still intact.
    expect(copy_.width).toBeGreaterThanOrEqual(44);
    expect(copy_.height).toBeGreaterThanOrEqual(44);

    // The title is one text line tall (the title's line-height, ~24px), not
    // 44px: the negative margins keep the hit box out of the layout, so no
    // empty band opens before the next row.
    expect(titleRow_.height).toBeLessThan(32);

    // The grown hit box stays inside the card...
    expect(copy_.y).toBeGreaterThanOrEqual(card_.y);
    expect(copy_.y + copy_.height).toBeLessThanOrEqual(card_.y + card_.height);
    // At phone width `.bs-kanban-card__row--1` (the AgentChip row) never
    // renders (`v-if="!compact"`, and KanbanBoard.vue binds `:compact` to
    // phone width), so the title is the card's own first row. The "inside
    // the card" check above already bounds the hit box from above.
    expect(await card.locator('.bs-kanban-card__row--1').count()).toBe(0);

    // The row below (chips, `.bs-kanban-card__chips`) sits right after the
    // title with only the card's own flex gap (--bs-space-2, 8px) between
    // them — no extra band from the button's hit box. Tag.vue renders a
    // plain <span>, never interactive, so the 44px hit box is free to
    // overlap into that gap/row the same way it overlaps the title line.
    const chipsRow = card.locator('.bs-kanban-card__chips').first();
    if ((await chipsRow.count()) > 0) {
      const hasInteractive = (await chipsRow.locator('button, a, input, [tabindex]').count()) > 0;
      expect(hasInteractive).toBe(false);
      const chipsBox = await chipsRow.boundingBox();
      if (chipsBox) {
        const gap = chipsBox.y - (titleRow_.y + titleRow_.height);
        expect(gap).toBeLessThanOrEqual(10); // --bs-space-2 (8px) + 2px tolerance
      }
    }
  });

  // Review follow-up (S2), narrowed after the first attempt (operator report
  // 2026-10-05): the label itself is truncated with an ellipsis, not just
  // boxed to one line's height, and the raw role is still reachable through
  // the chip's title.
  //
  // Every column is `flex: 0 0 280px` above the 640px phone breakpoint, so
  // the chip's available width (row 1 minus the Quote icon — the id and its
  // copy button both moved off row 1 on 2026-10-05) is the same at 768px
  // and 1440px. "Security reviewer · waiting - a nudge may help"
  // (roleLabels.ts) is wider than that, so it must clip. The board has four
  // columns, as the real one does: a single column stretches to the free
  // width and leaves room for the label.
  test('desktop: a long AgentChip label is ellipsised, not just boxed to one line', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockBoard(
      page,
      fourColumnBoard({
        ...task('epic-1/task-with-a-very-long-skill-install-cli-command-id', 'todo'),
        agentRole: 'security-reviewer',
        agentActivity: 'stalled',
        // Well past agentWaitingThresholdMs (4h) so the chip reads
        // "Security reviewer · waiting - a nudge may help".
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await page.goto('/work/kanban');

    const chip = page.locator('.bs-agent-chip').first();
    const chipText = chip.locator('.bs-agent-chip__text');
    // A column's automatic min-width is its min-content width, so before
    // `.bs-kanban-col { min-width: 0 }` this one card stretched the Todo
    // column to ~650px and the label fitted without clipping.
    const colWidth = await chip.evaluate(
      (el) => el.closest('.bs-kanban-col')?.getBoundingClientRect().width ?? 0,
    );
    expect(Math.round(colWidth)).toBe(280);
    const overflowMetrics = await chipText.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      textOverflow: getComputedStyle(el).textOverflow,
    }));
    expect(overflowMetrics.scrollWidth).toBeGreaterThan(overflowMetrics.clientWidth);
    expect(overflowMetrics.textOverflow).toBe('ellipsis');
    // AgentChip.vue binds the Tag's native `title` to `chip.title`
    // (kanban.ts's agentChip()) — the raw `agentRole`(+tier) taxonomy
    // string, not the rendered "<role> · <state>" label. No
    // `agentModelTier` is set on this fixture, so that raw string is exactly
    // the role.
    await expect(chip).toHaveAttribute('title', 'security-reviewer');
  });

  // UI audit finding (S3): the desktop toolbar used to read as two
  // single-control rows — the page toolbar (Epic, count, Refresh) and
  // KanbanBoard's own row holding only the display-options trigger. The
  // trigger now teleports into the page toolbar, so there is exactly one
  // row, and it shares a top with the Epic select.
  test('desktop: the display-options trigger shares one toolbar row with the Epic select', async ({
    page,
  }) => {
    await page.goto('/work/kanban');
    await expect(page.getByRole('region', { name: 'Todo column' })).toBeVisible();

    await expect(page.locator('.bs-kanban-board__toolbar')).toHaveCount(0);

    const epicBox = await page.getByLabel('Epic', { exact: true }).boundingBox();
    const trigger = page.getByRole('button', { name: 'Display options' });
    await expect(trigger).toBeVisible();
    const triggerBox = await trigger.boundingBox();
    expect(epicBox).not.toBeNull();
    expect(triggerBox).not.toBeNull();
    expect(Math.abs((epicBox?.y ?? 0) - (triggerBox?.y ?? 0))).toBeLessThanOrEqual(8);
  });

  // Pattern 7 — the display-options Popover's Group by Select re-folds the
  // board into a different set of columns, without a reload.
  test('switching group-by changes how the board is grouped', async ({ page }) => {
    await page.goto('/work/kanban');
    await expect(page.getByRole('region', { name: 'Todo column' })).toBeVisible();

    await page.getByRole('button', { name: 'Display options' }).click();
    await page.getByLabel('Group by', { exact: true }).selectOption('project');

    await expect(page.getByRole('region', { name: 'Todo column' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'demo-hub column' })).toBeVisible();
    // db/fixtures.ts's tasks predate Phase 6b's project stamp (D-233: only a
    // writer holding the plan stamps `project`), so they carry no project of
    // their own and fold into the "None" bucket, not a "black-smith" one.
    await expect(page.getByRole('region', { name: 'None column' })).toBeVisible();
  });

  // Pattern 8 — display options (group-by, summary, hidden columns) persist
  // via a guarded localStorage accessor, so a reload keeps the operator's
  // chosen view instead of resetting to the status board every time.
  test('display options persist across a reload', async ({ page }) => {
    await page.goto('/work/kanban');
    await page.getByRole('button', { name: 'Display options' }).click();
    await page.getByLabel('Group by', { exact: true }).selectOption('project');
    await expect(page.getByRole('region', { name: 'demo-hub column' })).toBeVisible();

    await page.reload();

    await expect(page.getByRole('region', { name: 'demo-hub column' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Todo column' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Display options' }).click();
    await expect(page.getByLabel('Group by', { exact: true })).toHaveValue('project');
  });

  // Pattern 9 — arrow keys move focus card-to-card (no drag-and-drop), Enter
  // opens the peek panel on the focused card, and Escape closes it and
  // restores focus to the card that opened it.
  test('arrow-key navigation moves focus between cards; Enter opens the peek, Escape closes it', async ({
    page,
  }) => {
    await mockBoard(page, [
      { taskStatus: 'todo', tasks: [task('epic-1/task-1', 'todo'), task('epic-1/task-2', 'todo')] },
    ]);
    await page.goto('/work/kanban');

    const firstCard = page.locator('.bs-kanban-card').nth(0);
    const secondCard = page.locator('.bs-kanban-card').nth(1);
    await firstCard.focus();
    await expect(firstCard).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(secondCard).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect(firstCard).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(firstCard).toBeFocused();
  });

  // S2 review fix — Enter on the card's own "Open PR" link used to be
  // swallowed by the card's keydown handler and open the peek panel instead
  // of letting the link's native activation run. Focusing the link directly
  // and pressing Enter must leave the peek panel closed.
  test('Enter on the "Open PR" link does not open the peek panel', async ({ page }) => {
    await mockBoard(page, [
      {
        taskStatus: 'todo',
        tasks: [{ ...task('epic-1/task-1', 'todo'), prUrl: 'https://example.com/pr/1' }],
      },
    ]);
    await page.goto('/work/kanban');

    const link = page.getByRole('link', { name: 'Open PR' });
    await link.focus();
    await expect(link).toBeFocused();

    await page.keyboard.press('Enter');

    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  // S3 review fix — the "Show summary" toggle used to do nothing because no
  // summary field was ever rendered. It now shows the linked request's first
  // line, hidden again once the toggle is switched off.
  test('the summary toggle shows and hides the request first line on a card', async ({ page }) => {
    await mockBoard(page, [
      {
        taskStatus: 'todo',
        tasks: [
          {
            ...task('epic-1/task-1', 'todo'),
            hasRequest: true,
            requestFirstLine: 'Fix the login button alignment',
          },
        ],
      },
    ]);
    await page.goto('/work/kanban');

    await expect(page.getByText('Fix the login button alignment')).toBeVisible();

    await page.getByRole('button', { name: 'Display options' }).click();
    await page.getByLabel('Show summary', { exact: true }).uncheck();

    await expect(page.getByText('Fix the login button alignment')).toHaveCount(0);
  });

  // Operator fix 2026-10-05: dependencyChainText() still returns the
  // literal string "Waits for: nothing" for a dependency-free task
  // (kanban.ts), but KanbanTaskCard.vue now gates the footer-dep span on
  // `task.dependencies.length > 0`, so that string never reaches the DOM —
  // a no-deps card shows no "Waits for" line at all (the footer itself only
  // appears at all when comments or a PR link still warrant it).
  test('a card with no dependencies never shows a "Waits for" line', async ({ page }) => {
    await mockBoard(page, [
      {
        taskStatus: 'todo',
        tasks: [{ ...task('epic-1/task-1', 'todo'), commentCount: 2 }],
      },
    ]);
    await page.goto('/work/kanban');

    const card = page.locator('.bs-kanban-card').first();
    await expect(card).toBeVisible();
    await expect(card.locator('.bs-kanban-card__footer')).toBeVisible();
    await expect(card.locator('.bs-kanban-card__footer-dep')).toHaveCount(0);
    await expect(page.getByText(/Waits for/)).toHaveCount(0);
  });

  // The 375px board must not widen the page itself — the toolbar/columns
  // scroll internally if they need to, the document never does.
  test('the 375px board never scrolls the page sideways', async ({ page }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.goto('/work/kanban');
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });

  // The one capture whose subject is a failure, so it cannot wait on a data
  // marker the way the rest do (see helpers.ts / D-150): in the state it
  // documents, no data is coming. The gate is therefore the aborted request
  // itself — armed before goto(), awaited after — so the PNG shows the page's
  // decision rather than a race with it.
  //
  // This used to be `waitForLoadState('networkidle')`, and the change stream
  // (design-spec.md's 2026-09-15 addendum to §8) ended that: `/api/stream` is
  // a response that never completes, so the network is never idle and the
  // wait could only ever time out. Waiting on the specific request whose
  // failure this screenshot is about is strictly more precise than waiting
  // for every request on the page to settle — it was always the one that
  // mattered, and networkidle was the loose approximation of it.
  test('screenshot epic list unavailable', async ({ page }) => {
    await setTheme(page, 'light');
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.route('**/api/overview*', (route) => route.abort('failed'));
    const aborted = page.waitForEvent('requestfailed', (req) =>
      req.url().includes('/api/overview'),
    );
    await page.goto('/work/kanban');
    await expect(page.locator('h1')).toHaveText('Work');
    await aborted;
    await page.waitForTimeout(150);
    await shoot(page, 'work-kanban-epics-unavailable-desktop-light');
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
    await page.goto('/work/kanban');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    // Resolves the moment the refetch is issued -- i.e. the moment `load()`
    // has done whatever it does to `error` -- so the assertions below land
    // inside the in-flight window rather than racing it.
    const refetch = page.waitForRequest('**/api/kanban*');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
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

    await page.goto('/work/kanban');
    await expect(page.locator('.bs-kanban-card').first()).toBeVisible();
    // Proof the population is not empty before anything is claimed absent.
    expect(await epicOptions()).toEqual(expect.arrayContaining(['epic-1', 'epic-9']));

    await projectSwitcher.selectOption('blacksmith');
    await expect(page).toHaveURL(/[?&]project=blacksmith/);
    await expect.poll(epicOptions).not.toContain('epic-9');
    expect(await epicOptions()).toContain('epic-1');
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/work/kanban');
        await expect(page.locator('h1')).toHaveText('Work');
        await settleForShot(page, page.locator('.bs-kanban-card').first());
        await shoot(page, `work-kanban-${vpName}-${theme}`);
      });
    }
  }

  // S2 (ds-spec.md §3.1 Work/Kanban row): the phone tab row shows one column
  // at a time, and clicking a second tab switches which one is on screen.
  test('mobile: switching tabs switches the visible column', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/work/kanban');
    const tablist = page.getByRole('tablist', { name: 'Kanban columns' });
    await expect(tablist).toBeVisible();
    // Every column stays mounted (v-show, not v-if) so a tab click only
    // flips which one is visible — never tears down and rebuilds its cards.
    const visibleCol = page.locator('.bs-kanban-col:visible');
    await expect(visibleCol).toHaveCount(1);

    // Default lands on the first non-empty column (defaultMobileColumnKey) —
    // not necessarily the first tab, so find whichever one starts selected.
    const activeTab = tablist.locator('[aria-selected="true"]');
    await expect(activeTab).toHaveCount(1);
    const firstColLabel = await visibleCol.getAttribute('aria-label');

    // Resolve a concrete id before clicking — the "not selected" locator is
    // dynamic and would re-match a different tab once the click lands. An
    // attribute selector, not a `#id` selector: tab ids embed a column
    // label that can contain a space (e.g. "In progress"), which `#id`
    // parses as a descendant combinator.
    const otherTabId = await tablist
      .locator('[role="tab"]:not([aria-selected="true"])')
      .first()
      .getAttribute('id');
    const otherTab = page.locator(`[id="${otherTabId}"]`);
    await otherTab.click();
    await expect(otherTab).toHaveAttribute('aria-selected', 'true');
    await expect(tablist.locator('[aria-selected="true"]')).toHaveCount(1);
    await expect(visibleCol).toHaveCount(1);
    const secondColLabel = await visibleCol.getAttribute('aria-label');
    expect(secondColLabel).not.toBe(firstColLabel);
  });

  // Follow-ups of one parent stack into one card per column; a parent with a
  // single follow-up stays a plain card. Titles are readable text, never ids.
  test('follow-ups stack into one group per parent; a lone follow-up stays a card', async ({
    page,
  }) => {
    await mockBoard(page, followupBoard());
    await page.goto('/work/kanban');
    const todo = page.getByRole('region', { name: 'Todo column' });
    const group = todo.locator('.bs-kanban-group');
    await expect(group).toHaveCount(1);
    await expect(group.locator('.bs-kanban-group__title')).toHaveText('3 fixes · Settings layout');
    // The billing follow-up is alone, so it is an ordinary card with its own summary.
    await expect(todo.locator('.bs-kanban-card')).toHaveCount(1);
    await expect(todo.locator('.bs-kanban-card')).toContainText(
      'Fix: Show the invoice total with the currency symbol',
    );
    // No id text on any card or group.
    for (const el of await todo.locator('.bs-kanban-card, .bs-kanban-group').all()) {
      expect(await el.innerText()).not.toMatch(/[0-9a-f]{8}/);
    }
  });

  test('a group opens and closes by click and by keyboard, and its fix rows read as text', async ({
    page,
  }) => {
    await mockBoard(page, followupBoard());
    await page.goto('/work/kanban');
    const group = page.locator('.bs-kanban-group');
    const summary = group.locator('summary');
    await expect(summary).toHaveAccessibleName('3 fixes for Settings layout, expand/collapse');
    await expect(group).not.toHaveAttribute('open', /.*/);

    await summary.click();
    await expect(group).toHaveAttribute('open', '');
    const rows = group.locator('.bs-kanban-group__row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText(
      'Fix: The settings form loses its unsaved changes when the tab is switched',
    );
    for (const row of await rows.all()) {
      expect(await row.innerText()).not.toMatch(/[0-9a-f]{8}/);
    }

    await summary.click();
    await expect(group).not.toHaveAttribute('open', /.*/);

    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(group).toHaveAttribute('open', '');
    await page.keyboard.press('Space');
    await expect(group).not.toHaveAttribute('open', /.*/);
  });

  test('an open group stays open across a reload within the tab', async ({ page }) => {
    await mockBoard(page, followupBoard());
    await page.goto('/work/kanban');
    await page.locator('.bs-kanban-group summary').click();
    await expect(page.locator('.bs-kanban-group')).toHaveAttribute('open', '');
    // The native toggle event is queued after the click: wait until the board stored it.
    await page.waitForFunction(() =>
      Object.keys(sessionStorage).some(
        (k) => k.includes('kanban-groups') && sessionStorage[k]?.includes('Todo'),
      ),
    );
    await page.reload();
    await expect(page.locator('.bs-kanban-group')).toHaveAttribute('open', '');
  });

  test('a fix row opens the peek panel and arrows step into an open group', async ({ page }) => {
    await mockBoard(page, followupBoard());
    await page.goto('/work/kanban');
    const group = page.locator('.bs-kanban-group');
    await group.locator('summary').click();
    await group.locator('summary').focus();
    await page.keyboard.press('ArrowDown');
    await expect(group.locator('.bs-kanban-group__row').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('arrow keys move between fix rows; the copy button keeps its own keys', async ({ page }) => {
    await mockBoard(page, followupBoard());
    await page.goto('/work/kanban');
    const group = page.locator('.bs-kanban-group');
    await group.locator('summary').click();
    const rows = group.locator('.bs-kanban-group__row');
    await rows.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(rows.first()).toBeFocused();
    const copy = rows.first().getByRole('button');
    await copy.focus();
    await page.keyboard.press('ArrowDown');
    await expect(copy).toBeFocused();
  });

  test('a toggled group keeps its state across a polling refresh', async ({ page }) => {
    let requests = 0;
    await page.route('**/api/kanban*', (route) => {
      requests += 1;
      return route.fulfill({ json: followupBoard() });
    });
    await page.goto('/work/kanban');
    const group = page.locator('.bs-kanban-group');
    await group.locator('summary').click();
    await expect(group).toHaveAttribute('open', '');
    const before = requests;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => requests).toBeGreaterThan(before);
    await expect(group).toHaveAttribute('open', '');
    await group.locator('summary').click();
    await expect(group).not.toHaveAttribute('open', /.*/);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => requests).toBeGreaterThan(before + 1);
    await expect(group).not.toHaveAttribute('open', /.*/);
  });

  test('fix row keyboard: Tab reaches row then copy; Enter opens; copy does not open', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockBoard(page, followupBoard());
    await page.goto('/work/kanban');
    const group = page.locator('.bs-kanban-group');
    const summary = group.locator('summary');
    await summary.click();
    await summary.focus();
    // The summary is one stop: arrows step into the open rows, Tab goes row then its copy button.
    await page.keyboard.press('ArrowDown');
    const row = group.locator('.bs-kanban-group__row').first();
    await expect(row).toBeFocused();
    await page.keyboard.press('Tab');
    const copy = row.getByRole('button', { name: 'Copy task id' });
    await expect(copy).toBeFocused();
    // Enter on the copy button copies and does not open the task.
    await page.keyboard.press('Enter');
    await expect(row.getByRole('button', { name: 'Copied' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Space on the copy button behaves the same.
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Enter on the row itself opens the task (the quick-look panel on desktop).
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('arrows treat a collapsed group as one stop and skip its rows', async ({ page }) => {
    await mockBoard(page, followupBoard());
    await page.goto('/work/kanban');
    const todo = page.getByRole('region', { name: 'Todo column' });
    const summary = todo.locator('.bs-kanban-group summary');
    await summary.focus();
    await page.keyboard.press('ArrowDown');
    // Next stop is the lone follow-up card, not a hidden row of the closed group.
    await expect(todo.locator('.bs-kanban-card')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(summary).toBeFocused();
  });

  test('phone: the group summary and every fix row are at least 44px tall', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await mockBoard(page, followupBoard());
    await page.goto('/work/kanban');
    const group = page.locator('.bs-kanban-group');
    const summary = group.locator('summary');
    await summary.click();
    const summaryBox = await summary.boundingBox();
    expect(summaryBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    for (const row of await group.locator('.bs-kanban-group__row').all()) {
      expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const [vpName, viewport] of [
      ['desktop', VIEWPORTS.desktop],
      ['mobile', VIEWPORTS.mobile],
    ] as const) {
      test(`screenshot group/${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await mockBoard(page, richFollowupBoard());
        await page.goto('/work/kanban');
        // The first (three-fix) group stays collapsed; the seven-fix one opens.
        const groups = page.locator('.bs-kanban-group');
        await expect(groups).toHaveCount(2);
        await groups.nth(1).locator('summary').click();
        await expect(groups.nth(1)).toHaveAttribute('open', '');
        await expect(groups.nth(0)).not.toHaveAttribute('open', /.*/);
        await expect(groups.nth(1).locator('.bs-kanban-group__more')).toHaveText('Show 2 more');
        await settleForShot(page, groups.nth(1));
        await shoot(page, `work-kanban-group-${vpName}-${theme}`);
      });
    }
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`screenshot mobile/tab2/${theme}`, async ({ page }) => {
      await setTheme(page, theme);
      await page.setViewportSize(VIEWPORTS.mobile);
      await page.goto('/work/kanban');
      const tablist = page.getByRole('tablist', { name: 'Kanban columns' });
      await expect(tablist).toBeVisible();
      // Pick a tab that is not already the default-selected one, so the
      // shot genuinely shows a second column, not a same-column no-op.
      const otherTabId = await tablist
        .locator('[role="tab"]:not([aria-selected="true"])')
        .first()
        .getAttribute('id');
      await page.locator(`[id="${otherTabId}"]`).click();
      await settleForShot(page, page.locator('.bs-kanban-col:visible'));
      await shoot(page, `work-kanban-mobile-tab2-${theme}`);
    });
  }
});
