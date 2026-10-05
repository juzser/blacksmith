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
  // Quote trigger, `justify-content` replaced by the chip's own `flex: 1 1
  // auto` and the Quote trigger's `margin-left: auto`. Re-pointed from the
  // old "does the id wrap" question (there is no id text left to wrap) to
  // the same underlying risk: a long chip label must still keep row 1 a
  // single line tall, not grow the card.
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
    const titleTextDesktop = page.locator('.bs-kanban-card__title-text').first();
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

  // S2 review fix, 2026-10-05: a title long enough to fill both clamped
  // lines used to push the copy icon down onto its own, third line — which
  // also clipped it clean off the card once the title itself filled both
  // lines on its own. The icon must stay beside the text and inside the
  // card's bounds no matter how long the title is.
  test('desktop: the title-line copy button stays beside a 2-line-wrapped title, never clipped or on its own line', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockBoard(
      page,
      fourColumnBoard({
        ...task('epic-1/task-4', 'todo'),
        // <=60 chars (SHORT_TASK_LABEL_MAX, ui/src/lib/format.ts) so
        // taskLabel() renders it verbatim instead of falling back to the
        // task id slug.
        title: 'Write the full directory search and indexing docs for ops',
      }),
    );
    await page.goto('/work/kanban');

    const card = page.locator('.bs-kanban-card').first();
    const titleText = card.locator('.bs-kanban-card__title-text');
    const copyButton = card.locator('.bs-kanban-card__title-copy').first();
    await expect(copyButton).toBeVisible();

    const cardBox = await card.boundingBox();
    const titleBox = await titleText.boundingBox();
    const copyBox = await copyButton.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(copyBox).not.toBeNull();

    const card_ = cardBox ?? { x: 0, y: 0, width: 0, height: 0 };
    const title_ = titleBox ?? { x: 0, y: 0, width: 0, height: 0 };
    const copy_ = copyBox ?? { x: 0, y: 0, width: 0, height: 0 };

    // The title text actually wraps to 2 lines (taller than one line).
    expect(title_.height).toBeGreaterThan(copy_.height * 1.5);
    // The copy button sits on the title's first line, not below it.
    expect(copy_.y).toBeLessThanOrEqual(title_.y + copy_.height);
    // Fully inside the card's bounding box — never clipped off.
    expect(copy_.x).toBeGreaterThanOrEqual(card_.x);
    expect(copy_.x + copy_.width).toBeLessThanOrEqual(card_.x + card_.width);
    expect(copy_.y).toBeGreaterThanOrEqual(card_.y);
    expect(copy_.y + copy_.height).toBeLessThanOrEqual(card_.y + card_.height);
  });

  // S3 review fix (visual pass, 2026-10-05): below 640px .bs-iconbtn grows
  // to the 44px --bs-touch floor (bs-primitives.css ~133-138) while the
  // title keeps align-items: flex-start, so the icon — centred in that
  // taller box — sat visibly below the title's first text line
  // (work-kanban-mobile-dark.png: title glyph centre y~223, icon centre
  // y~234). The icon must come back level with the title without losing
  // the 44px hit area or spilling into the row above.
  test("phone: the title-line copy button's icon aligns with the title's first line and keeps its 44px hit area", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await mockBoard(page, fourColumnBoard(task('epic-1/task-4', 'todo')));
    await page.goto('/work/kanban');

    const card = page.locator('.bs-kanban-card').first();
    const titleText = card.locator('.bs-kanban-card__title-text');
    const copyButton = card.locator('.bs-kanban-card__title-copy').first();
    const icon = copyButton.locator('svg');
    await expect(copyButton).toBeVisible();

    const cardBox = await card.boundingBox();
    const titleBox = await titleText.boundingBox();
    const copyBox = await copyButton.boundingBox();
    const iconBox = await icon.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(copyBox).not.toBeNull();
    expect(iconBox).not.toBeNull();

    const card_ = cardBox ?? { x: 0, y: 0, width: 0, height: 0 };
    const title_ = titleBox ?? { x: 0, y: 0, width: 0, height: 0 };
    const copy_ = copyBox ?? { x: 0, y: 0, width: 0, height: 0 };
    const icon_ = iconBox ?? { x: 0, y: 0, width: 0, height: 0 };

    // The title text is one line here, so its own box is the first line.
    const titleLineCenter = title_.y + title_.height / 2;
    const iconCenter = icon_.y + icon_.height / 2;
    expect(Math.abs(iconCenter - titleLineCenter)).toBeLessThanOrEqual(3);

    // The 44px --bs-touch hit area is still intact.
    expect(copy_.width).toBeGreaterThanOrEqual(44);
    expect(copy_.height).toBeGreaterThanOrEqual(44);

    // The grown hit box stays inside the card...
    expect(copy_.y).toBeGreaterThanOrEqual(card_.y);
    expect(copy_.y + copy_.height).toBeLessThanOrEqual(card_.y + card_.height);
    // ...and never overlaps the AgentChip row above it (bs-kanban-card__row--1,
    // the only row that renders above the title — the other `.bs-kanban-card__row`
    // matches, chips and the footer meta row, sit below the title and would give
    // a false "below itself" reading if picked up by a bare first-row selector).
    // This task fixture may render without that row (v-if="!compact"), so count()
    // first rather than boundingBox(), which would otherwise wait out the full
    // timeout for a locator that never resolves.
    const rowAbove = card.locator('.bs-kanban-card__row--1').first();
    if ((await rowAbove.count()) > 0) {
      const rowAboveBox = await rowAbove.boundingBox();
      if (rowAboveBox) {
        expect(copy_.y).toBeGreaterThanOrEqual(rowAboveBox.y + rowAboveBox.height);
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
