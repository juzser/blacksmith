import type { KanbanTask } from '../src/lib/api.js';
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
  };
}

async function mockBoard(
  page: import('@playwright/test').Page,
  columns: Array<{ taskStatus: string; tasks: ReturnType<typeof task>[] }>,
) {
  await page.route('**/api/kanban*', (route) => route.fulfill({ json: columns }));
}

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
    // `.bs-kanban-card__id` is the shortId (taskId.split('/').pop()) — enough
    // to confirm the URL names the clicked card's task without needing the
    // full `<epic>/<id>` taskId, which the card never actually renders.
    const shortId = await firstCard.locator('.bs-kanban-card__id').innerText();
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
    // `.bs-kanban-card__id` renders only the shortId (taskId.split('/').pop()),
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

  // Operator report 2026-10-05: row 1 is a flex row with `justify-content:
  // space-between` and the id had no truncation, so a long AgentChip label
  // (e.g. the "waiting - a nudge may help" suffix) squeezed the id into a
  // column one hyphen segment per line, growing the card tall and ugly on a
  // 1440px desktop board.
  test('desktop: a long AgentChip label does not wrap the task id onto multiple lines', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockBoard(page, [
      {
        taskStatus: 'todo',
        tasks: [
          {
            ...task('epic-1/task-with-a-very-long-skill-install-cli-command-id', 'todo'),
            agentRole: 'coder',
            agentActivity: 'stalled',
            // Well past agentWaitingThresholdMs (4h) so the chip reads
            // "Builder · waiting - a nudge may help" — the longest chip text
            // the fixture can produce.
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ]);
    await page.goto('/work/kanban');

    const idEl = page.locator('.bs-kanban-card__id').first();
    await expect(idEl).toBeVisible();
    const idBox = await idEl.boundingBox();
    const lineHeight = await idEl.evaluate((el) =>
      parseFloat(getComputedStyle(el).lineHeight || '0'),
    );
    expect(idBox).not.toBeNull();
    expect(lineHeight).toBeGreaterThan(0);
    expect(idBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(lineHeight * 1.5);

    const row1 = page.locator('.bs-kanban-card__row--1').first();
    const chip = page.locator('.bs-agent-chip').first();
    const row1Box = await row1.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(row1Box).not.toBeNull();
    expect(chipBox).not.toBeNull();
    // Small tolerance for border/line-height rounding, not a second line.
    expect(row1Box?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      (chipBox?.height ?? 0) + 4,
    );
  });

  // Review follow-up (S2), narrowed after the first attempt (operator report
  // 2026-10-05): the label itself is truncated with an ellipsis, not just
  // boxed to one line's height, and the raw role is still reachable through
  // the chip's title.
  //
  // .bs-kanban-col is a fixed `flex: 0 0 280px` (bs-primitives.css) on every
  // viewport wider than the 640px phone breakpoint (useViewport.ts's
  // isPhoneWidth, same threshold KanbanBoard.vue switches layouts on), so the
  // row's available width — and therefore the chip's `max-width: 60%` cap —
  // does not change between 768px and 1440px; a narrower *desktop* viewport
  // gives this no more room to fail in than 1440px already had. "Builder ·
  // waiting - a nudge may help" (36 chars) rendered at exactly 207px with
  // zero spare room (scrollWidth === clientWidth) at 1440px, which means that
  // cap is already saturated at 207px of text — the chip was sized to its
  // full natural content, not clamped below it. A label with meaningfully
  // more characters pushes the *same* fixed cap into clamping: "security-
  // reviewer" maps to "Security reviewer" (roleLabels.ts) vs "Builder",
  // producing "Security reviewer · waiting - a nudge may help" (46 chars,
  // ~28% more than the 36 that already left no slack) — at roughly the same
  // ~5.75px/char this measures near 264px against an ~207px slot, so it must
  // overflow regardless of the exact cap value. Viewport stays 1440px: it is
  // the label, not the width, that is now constrained.
  test('desktop: a long AgentChip label is ellipsised, not just boxed to one line', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockBoard(page, [
      {
        taskStatus: 'todo',
        tasks: [
          {
            ...task('epic-1/task-with-a-very-long-skill-install-cli-command-id', 'todo'),
            agentRole: 'security-reviewer',
            agentActivity: 'stalled',
            // Well past agentWaitingThresholdMs (4h) so the chip reads
            // "Security reviewer · waiting - a nudge may help".
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ]);
    await page.goto('/work/kanban');

    const chip = page.locator('.bs-agent-chip').first();
    const chipText = chip.locator('.bs-agent-chip__text');
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
