import { activeScopeBody, stubActiveScope } from './activeScopeStub.js';
import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { expect, type Page, test } from './harness.js';
import { dropRoutes, setTheme, settleForShot, shoot, shootElement, VIEWPORTS } from './helpers.js';

// Route proxies that call route.fetch() must not outlive their test.
test.afterEach(async ({ page }) => dropRoutes(page));

// Home (ds-spec.md §4.1): Overview and Projects merged into one page. The
// numbers and sentences are unit-tested in ui/test/homeView.test.ts and the
// grouping in ui/test/inbox.test.ts; this suite is the only layer that runs
// the templates, so it asserts what reaches the screen.

const minutesAgo = (minutes: number): string =>
  new Date(Date.parse(FIXTURE_NOW_ISO) - minutes * 60_000).toISOString();

// One row of each kind, across two projects plus the project-less group, so
// the grouping, the per-kind tag and the per-kind action are all on screen.
const FACTS = {
  taskTitle: null,
  role: null,
  reason: null,
  findingCount: 0,
  findingSummaries: [],
  statement: null,
};
const INBOX_ROWS = [
  {
    ...FACTS,
    id: 'esc-1',
    kind: 'escalation',
    taskTitle: 'Checkout flow',
    role: 'tester',
    project: 'black-smith',
    taskId: 'epic-1/task-3-checkout',
    createdAt: minutesAgo(5),
  },
  {
    ...FACTS,
    id: 'waiver-1',
    kind: 'waiver',
    taskTitle: 'Show fee',
    findingCount: 2,
    findingSummaries: ['Fee shown before tax.', 'Rounding drifts.'],
    project: 'demo-hub',
    taskId: 'epic-9/task-2-show-fee',
    store: { id: 'ab12cd34', label: 'demo-hub' },
    createdAt: minutesAgo(30),
  },
  {
    ...FACTS,
    id: 'lesson-1',
    kind: 'lesson_candidate',
    statement: 'Run the full suite before a gate check.',
    project: null,
    taskId: null,
    createdAt: minutesAgo(90),
  },
];

async function serveInbox(page: Page, rows: unknown[]): Promise<void> {
  await page.route('**/api/inbox*', (route) => route.fulfill({ json: { rows } }));
}

const PHONE = { width: 375, height: 812 };

// Running now follows the Active/All scope, and which projects a live CLI
// session drives is not something the fixture db can say. So every test here
// starts from a measured scope where every fixture project is active (the
// cards, and so the baselines, are what they were before the scope); a test
// about the scope stubs its own, which wins as the later route.
const activeProject = (project: string, agentsWorking = 1) => ({
  storeId: 'home',
  project,
  liveSessions: 1,
  agentsWorking,
});
test.beforeEach(async ({ page }) => {
  await stubActiveScope(page, [], {
    liveSessions: 2,
    projects: [activeProject('blacksmith', 2), activeProject('demo-hub')],
  });
});

test.describe('Home', () => {
  test('/ lands on Home, with a11y basics', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.locator('h1')).toHaveText('Home');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
  });

  test('the retired /projects link keeps its project scope on Home', async ({ page }) => {
    await page.goto('/projects?project=demo-hub');
    await expect(page).toHaveURL(/\/p\/demo-hub\/overview$/);
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'demo-hub · Home',
    );
  });

  test('lays out the sections in order, what needs you first', async ({ page }) => {
    await page.goto('/overview');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText([
      'Needs you',
      'Live sessions',
      'Recent activity',
      'Running now',
      'What the factory decided recently',
      'Budget',
    ]);
  });

  test('Running now has one card per project with work in flight, linked to Work', async ({
    page,
  }) => {
    await page.goto('/overview');
    const view = page.getByRole('link', { name: 'View blacksmith in Work' });
    await expect(view).toHaveAttribute('href', '/work/kanban?project=blacksmith');
    await expect(page.getByText('2 epics in flight')).toBeVisible();
    await expect(page.getByText('epic in flights')).toHaveCount(0);
    // envkit is declared but has nothing running: no card for it.
    await expect(page.getByRole('link', { name: 'View envkit in Work' })).toHaveCount(0);
  });

  test('a project declared before its first task is still selectable from the topbar', async ({
    page,
  }) => {
    // The fixture roadmap's third phase declares `envkit` and nothing else.
    await page.goto('/overview');
    await expect(
      page.getByLabel('Project', { exact: true }).locator('option', { hasText: 'envkit' }),
    ).toHaveCount(1);
  });

  test('an epic seen in flight and then closed shows under Just finished', async ({ page }) => {
    let served = 0;
    await page.route('**/api/overview*', async (route) => {
      served += 1;
      const response = await route.fetch();
      const body = await response.json();
      if (served === 1) {
        body.epicsInFlight = [...body.epicsInFlight, 'epic-just-done'];
      } else {
        body.closedEpics = [
          {
            epicId: 'epic-just-done',
            closedBy: 'operator',
            machineVerdict: null,
            machineReason: null,
            overrideRationale: null,
            blockers: [],
            closedAt: minutesAgo(2),
          },
          ...body.closedEpics,
        ];
      }
      await route.fulfill({ response, json: body });
    });
    await page.goto('/overview');
    await expect(page.getByText('Just finished')).toHaveCount(0);

    await page.getByRole('button', { name: 'Pause updates' }).click();
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect(page.getByText('Just finished')).toBeVisible();
    await expect(page.getByRole('link', { name: 'epic-just-done' })).toHaveAttribute(
      'href',
      '/work/kanban?epic=epic-just-done',
    );
  });

  test('a failed overview fetch never renders as an idle factory', async ({ page }) => {
    await page.route('**/api/overview*', (route) => route.abort('failed'));
    await page.goto('/overview');
    await expect(page.getByText('Could not load Home.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    await expect(page.getByText('Nothing is running right now.')).toHaveCount(0);
    await expect(page.getByText('No decisions yet.')).toHaveCount(0);
  });

  // D-226: the error clears on success, not on attempt, so a refresh still in
  // flight against a dead server never makes the page look healthy.
  test('a failing refresh never takes the error banner off the screen', async ({ page }) => {
    let served = 0;
    await page.route('**/api/overview*', async (route) => {
      served += 1;
      if (served === 1) {
        await route.abort('failed');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      await route.abort('failed').catch(() => {});
    });
    await page.goto('/overview');
    await expect(page.getByText('Could not load Home.')).toBeVisible();

    const refetch = page.waitForRequest('**/api/overview*');
    await page.getByRole('button', { name: 'Pause updates' }).click();
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await refetch;

    await expect(page.getByText('Could not load Home.')).toBeVisible();
  });

  test('a failed inbox fetch never claims nothing needs you', async ({ page }) => {
    await page.route('**/api/inbox*', (route) => route.abort('failed'));
    await page.goto('/overview');
    await expect(page.getByText('Could not load what needs you.')).toBeVisible();
    await expect(page.getByText('Nothing needs you right now.')).toHaveCount(0);
  });

  test('the sidebar brand mark is the project logo, decoded and not a broken image', async ({
    page,
  }) => {
    await page.goto('/overview');
    const mark = page.locator('.bs-side__mark img');
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute('alt', 'Blacksmith');
    // toBeVisible() passes on a broken <img> too; naturalWidth proves it decoded.
    const naturalWidth = await mark.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);
  });

  test('theme toggle switches to dark and persists the class on <html>', async ({ page }) => {
    await page.goto('/overview');
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/overview');
        await expect(page.locator('h1')).toHaveText('Home');
        await settleForShot(page, page.getByRole('link', { name: 'View blacksmith in Work' }));
        await shoot(page, `home-${vpName}-${theme}`);
      });
    }
  }

  // Fix round 2 item 3: the home-desktop-*/home-mobile-* baselines above are
  // viewport-sized and cut off at the "Running now" heading, so the card
  // itself -- now linking into Sessions too -- was never actually shown.
  // An element screenshot proves it in full regardless of page height.
  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    test(`screenshot running-now card ${vpName}/light`, async ({ page }) => {
      await setTheme(page, 'light');
      await page.setViewportSize(viewport);
      await page.goto('/overview');
      const card = page.locator('.bs-card').filter({ hasText: 'blacksmith' }).first();
      await settleForShot(page, card);
      await shootElement(card, `home-running-now-${vpName}-light`);
    });
  }

  // Blast radius: MobileTopBar renders on every page, so its vertical
  // overflow menu (DS4 S1 round 4) needs its own proof on Home too, not
  // just Work (work.spec.ts).
  for (const theme of ['light', 'dark'] as const) {
    test(`screenshot mobile overflow/${theme}`, async ({ page }) => {
      await setTheme(page, theme);
      await page.setViewportSize(VIEWPORTS.mobile);
      await page.goto('/overview');
      await page.getByRole('button', { name: 'More actions' }).click();
      const menu = page.getByRole('menu', { name: 'More actions' });
      await settleForShot(page, menu);
      await shoot(page, `home-mobile-overflow-${theme}`);
    });
  }

  // Home has no page-specific extra teleported into the overflow menu, so
  // the Separator before the (empty) extra slot must not render — a visible
  // separator with nothing stacked under it is a dangling rule (DS4 S1
  // round 5, S3 finding 1).
  test('phone: no separator follows the last menuitem when the overflow has no page extra', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/overview');
    await page.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu', { name: 'More actions' });
    await expect(menu).toBeVisible();

    const menuitemsLocator = menu.getByRole('menuitem');
    await expect.poll(() => menuitemsLocator.count()).toBeGreaterThan(0);

    const separators = await menu.getByRole('separator').all();
    for (const separator of separators) {
      await expect(separator).not.toBeVisible();
    }
  });

  // Home has no page-specific teleported extra, so this is the three
  // built-in items only (Pause, Switch theme, Settings) — the walk still
  // needs to wrap with just those three (DS4 S1 round 6).
  test('phone: ArrowDown walks the three built-in menu items and wraps', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/overview');
    await page.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu', { name: 'More actions' });
    await expect(menu).toBeVisible();

    const items = menu.getByRole('menuitem');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(2)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(0)).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect(items.nth(2)).toBeFocused();
  });
});

test.describe('Home: Needs you inbox', () => {
  test('desktop: groups by project, project-less rows last, one action per row', async ({
    page,
  }) => {
    await serveInbox(page, INBOX_ROWS);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/overview');

    const inbox = page.locator('section.bs-inbox');
    await expect(inbox.locator('.bs-inbox__group-head')).toHaveText([
      'black-smith · 1',
      'demo-hub · 1',
      'All projects · 1',
    ]);
    // The mock's wording: what to decide, then the task and why.
    await expect(inbox.getByText('Decide on an escalated task')).toBeVisible();
    await expect(
      inbox.getByText('Tester stopped on Checkout flow; the task stays blocked until you choose'),
    ).toBeVisible();
    await expect(inbox.getByText('Approve waiver for 2 minor findings')).toBeVisible();
    await expect(
      inbox.getByText('Show fee · review found 2 issues; merge is waiting on you'),
    ).toBeVisible();
    await expect(inbox.getByText('Review a new lesson candidate')).toBeVisible();
    await expect(
      inbox.getByText(
        'Run the full suite before a gate check; approving applies it to future runs',
      ),
    ).toBeVisible();
    await expect(inbox.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/tasks/epic-1%2Ftask-3-checkout',
    );
    const reviews = inbox.getByRole('link', { name: /^Review/ });
    await expect(reviews).toHaveCount(2);
    // A foreign store's row opens its task in that store.
    await expect(reviews.first()).toHaveAttribute(
      'href',
      '/tasks/epic-9%2Ftask-2-show-fee?store=ab12cd34',
    );
    await expect(reviews.last()).toHaveAttribute('href', '/lessons');

    // The filter chips narrow the list and say which one is pressed.
    const waivers = inbox.getByRole('button', { name: 'Waivers' });
    await waivers.click();
    await expect(waivers).toHaveAttribute('aria-pressed', 'true');
    await expect(inbox.locator('.bs-inbox__group-head')).toHaveText(['demo-hub · 1']);
  });

  test('desktop: a scoped Home shows only that project', async ({ page }) => {
    await serveInbox(page, INBOX_ROWS);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/p/demo-hub/overview');
    await expect(page.locator('.bs-inbox__group-head')).toHaveText(['demo-hub · 1']);
  });

  test('375px: no filter chips, groups fold with the first open, one primary action', async ({
    page,
  }) => {
    await serveInbox(page, INBOX_ROWS);
    await page.setViewportSize(PHONE);
    await page.goto('/overview');

    const inbox = page.locator('section.bs-inbox');
    await expect(inbox.locator('details.bs-inbox__group')).toHaveCount(3);
    await expect(inbox.getByRole('group', { name: 'Filter what needs you' })).toHaveCount(0);
    await expect(inbox.locator('details.bs-inbox__group').first()).toHaveAttribute('open', '');
    await expect(inbox.locator('details.bs-inbox__group').nth(1)).not.toHaveAttribute('open', '');

    // §3.1 + ds-review.html: the single most urgent row (the escalation,
    // first group/row) gets one full-width 44px "Decide" action; every other
    // row is one whole-row link. Nothing shows a description.
    await expect(inbox.locator('.bs-btn--primary')).toHaveCount(1);
    const decide = inbox.getByRole('link', { name: 'Decide: Decide on an escalated task' });
    await expect(decide).toHaveClass(/bs-btn--primary/);
    await expect(decide).toHaveClass(/bs-btn--touch/);
    await expect(decide).toHaveClass(/bs-btn--block/);
    expect((await decide.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(inbox.locator('.bs-inbox__desc')).toHaveCount(0);
    await expect(inbox.getByText(/the task stays blocked|merge is waiting/)).toHaveCount(0);

    // The escalation's time line starts with its short task name.
    const escRow = inbox.locator('.bs-inbox__row[data-kind="escalation"]');
    await expect(escRow.locator('.bs-inbox__pmeta')).toHaveText(/^Checkout flow · .*ago$/);

    // A folded group opens from its summary; its row is one link.
    await inbox.locator('summary', { hasText: 'demo-hub · 1' }).click();
    const waiverLink = inbox.getByRole('link', { name: /Approve waiver for 2 minor findings/ });
    await expect(waiverLink).toBeVisible();
    await expect(waiverLink).toHaveAttribute('href', /\/tasks\/epic-9%2Ftask-2-show-fee/);
    await inbox.locator('summary', { hasText: 'All projects · 1' }).click();
    await expect(inbox.getByRole('link', { name: /Review a new lesson candidate/ })).toBeVisible();

    // Every visible row: a 44px+ target, a title of at most two lines, a time
    // line, and no button or link nested in a link row.
    for (const row of await inbox.locator('.bs-inbox__row').all()) {
      const box = await row.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      const title = row.locator('.bs-inbox__ptitle');
      const lineHeight = await title.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
      expect((await title.boundingBox())?.height ?? 99).toBeLessThanOrEqual(2 * lineHeight + 1);
      await expect(row.locator('.bs-inbox__pmeta')).toContainText(/ago|now/);
    }
    await expect(inbox.locator('a.bs-inbox__rowlink a, a.bs-inbox__rowlink button')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test('320px: row titles wrap to at most two lines and nothing scrolls sideways', async ({
    page,
  }) => {
    // The waiver title is the longest phone copy; a two-digit count is the
    // worst case for the wrap rule.
    await serveInbox(
      page,
      INBOX_ROWS.map((r) => (r.kind === 'waiver' ? { ...r, findingCount: 12 } : r)),
    );
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/overview');
    const inbox = page.locator('section.bs-inbox');
    await expect(inbox.locator('.bs-inbox__ptitle').first()).toBeVisible();
    // Open every folded group so each title is laid out.
    for (const g of await inbox.locator('details.bs-inbox__group').all()) {
      await g.evaluate((el) => ((el as HTMLDetailsElement).open = true));
    }
    const lineHeight = await inbox
      .locator('.bs-inbox__ptitle')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect(lineHeight).toBeGreaterThan(0);
    const waiverTitle = 'Approve waiver for 12 minor findings';
    const titles = inbox.locator('.bs-inbox__ptitle');
    await expect(titles).toHaveCount(3);
    await expect(titles.filter({ hasText: waiverTitle })).toHaveCount(1);
    for (const t of await titles.all()) {
      const h = (await t.boundingBox())?.height ?? 99;
      expect(h).toBeLessThanOrEqual(2 * lineHeight + 1);
      if ((await t.textContent()) === waiverTitle) {
        // Wraps (taller than one line) and stops at two.
        expect(h).toBeGreaterThan(lineHeight + 1);
      }
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test('375px: each group is a card with a 44px chevron summary and a total in the heading', async ({
    page,
  }) => {
    await serveInbox(page, INBOX_ROWS);
    await page.setViewportSize(PHONE);
    await page.goto('/overview');
    const inbox = page.locator('section.bs-inbox');
    await expect(inbox.locator('#inbox-heading')).toHaveText(/^\s*Needs you\s*3\s*$/);
    await expect(page.getByRole('heading', { name: 'Needs you 3', exact: true })).toBeVisible();
    // Mock .ph-h: the words stay left, the count sits on the cards' right edge.
    const firstCard = (await inbox.locator('details.bs-inbox__group').first().boundingBox()) as {
      x: number;
      width: number;
    };
    const count = (await inbox.locator('.bs-inbox__count').boundingBox()) as {
      x: number;
      width: number;
    };
    expect(Math.abs(count.x + count.width - (firstCard.x + firstCard.width))).toBeLessThanOrEqual(
      1,
    );
    const textLeft = await inbox.locator('#inbox-heading').evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild as Node, 0);
      range.setEnd(el.firstChild as Node, 1);
      return range.getBoundingClientRect().left;
    });
    expect(Math.abs(textLeft - firstCard.x)).toBeLessThanOrEqual(1);

    const group = inbox.locator('details.bs-inbox__group').nth(1);
    const summary = group.locator('summary');
    expect((await summary.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await summary.evaluate((el) => getComputedStyle(el).listStyleType)).toBe('none');
    await expect(group.locator('.bs-inbox__list')).toBeAttached();
    const chev = summary.locator('.bs-inbox__chev');
    const turn = () => chev.evaluate((el) => getComputedStyle(el).transform);
    const closed = await turn();
    await summary.click();
    await expect.poll(turn).not.toBe(closed);
  });

  test('375px: no count while loading, on error or when empty', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.route('**/api/inbox*', () => {}); // never answers: stays loading
    await page.goto('/overview');
    await expect(page.locator('.bs-inbox__loading')).toBeVisible();
    await expect(page.locator('.bs-inbox__count')).toHaveCount(0);
    await page.unroute('**/api/inbox*');

    await page.route('**/api/inbox*', (route) => route.abort('failed'));
    await page.reload();
    await expect(page.getByText('Could not load what needs you.')).toBeVisible();
    await expect(page.locator('.bs-inbox__count')).toHaveCount(0);
    await page.unroute('**/api/inbox*');

    await serveInbox(page, []);
    await page.reload();
    await expect(page.getByText('Nothing needs you right now.')).toBeVisible();
    await expect(page.locator('.bs-inbox__count')).toHaveCount(0);
  });

  test('desktop: no count in the heading', async ({ page }) => {
    await serveInbox(page, INBOX_ROWS);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/overview');
    await expect(page.locator('#inbox-heading')).toHaveText('Needs you');
    await expect(page.locator('.bs-inbox__count')).toHaveCount(0);
    expect(
      await page.locator('#inbox-heading').evaluate((el) => getComputedStyle(el).display),
    ).toBe('block');
  });

  test('desktop: rows start unread; opening one reads it, the others stay unread', async ({
    page,
  }) => {
    await serveInbox(page, INBOX_ROWS);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/overview');
    const inbox = page.locator('section.bs-inbox');
    const rows = inbox.locator('.bs-inbox__row');
    const weight = (i: number) =>
      rows
        .nth(i)
        .locator('.bs-inbox__title')
        .evaluate((el) => getComputedStyle(el).fontWeight);
    await expect(rows).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      expect(await weight(i)).toBe('600');
      await expect(rows.nth(i).getByRole('img', { name: 'Unread' })).toBeVisible();
    }
    await rows
      .nth(1)
      .getByRole('link', { name: /^Review/ })
      .click();
    await page.goto('/overview');
    await expect(rows).toHaveCount(3);
    expect(await weight(1)).toBe('500');
    await expect(rows.nth(1).getByRole('img', { name: 'Unread' })).toHaveCount(0);
    await expect(rows.nth(1).locator('.bs-inbox__udot')).toHaveAttribute('aria-hidden', 'true');
    expect(await weight(0)).toBe('600');
    expect(await weight(2)).toBe('600');
    await expect(rows.nth(0).getByRole('img', { name: 'Unread' })).toBeVisible();
  });

  test('375px: a row opened and returned to by history still reads as read, without a reload', async ({
    page,
  }) => {
    await serveInbox(page, INBOX_ROWS);
    await page.setViewportSize(PHONE);
    await page.goto('/overview');
    const inbox = page.locator('section.bs-inbox');
    const title = (kind: string) =>
      inbox.locator(`.bs-inbox__row[data-kind="${kind}"] .bs-inbox__ptitle`);
    const weight = (kind: string) => title(kind).evaluate((el) => getComputedStyle(el).fontWeight);
    expect(await weight('escalation')).toBe('600');
    await expect(inbox.locator('.bs-inbox__udot')).toHaveCount(0);
    await inbox.getByRole('link', { name: 'Decide: Decide on an escalated task' }).click();
    await expect(page).not.toHaveURL(/\/overview$/);
    // Back by the history stack: the SPA stays mounted, nothing reloads.
    await page.evaluate(() => {
      (window as unknown as { __kept: boolean }).__kept = true;
    });
    await page.goBack();
    await expect(inbox).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(
      true,
    );
    expect(await weight('escalation')).toBe('500');
    await inbox.locator('summary', { hasText: 'demo-hub · 1' }).click();
    expect(await weight('waiver')).toBe('600');
    // The state outlives a reload too.
    await page.reload();
    expect(await weight('escalation')).toBe('500');
  });

  test('375px: a middle-click reads the row too', async ({ page }) => {
    await serveInbox(page, INBOX_ROWS);
    await page.setViewportSize(PHONE);
    await page.goto('/overview');
    const inbox = page.locator('section.bs-inbox');
    const weight = (kind: string) =>
      inbox
        .locator(`.bs-inbox__row[data-kind="${kind}"] .bs-inbox__ptitle`)
        .evaluate((el) => getComputedStyle(el).fontWeight);
    await inbox.locator('summary', { hasText: 'demo-hub · 1' }).click();
    expect(await weight('waiver')).toBe('600');
    await inbox
      .getByRole('link', { name: /Approve waiver for 2 minor findings/ })
      .click({ button: 'middle' });
    expect(await weight('waiver')).toBe('500');
  });

  test('a row seen before reads as unread again once a newer decision reuses its id', async ({
    page,
  }) => {
    await serveInbox(page, INBOX_ROWS);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/overview');
    const inbox = page.locator('section.bs-inbox');
    const row = inbox.locator('.bs-inbox__row[data-kind="escalation"]');
    await row.getByRole('link', { name: /^Open/ }).click();
    await page.goto('/overview');
    await expect(row.getByRole('img', { name: 'Unread' })).toHaveCount(0);
    // The same task escalates again: same row id, a later createdAt.
    await page.unroute('**/api/inbox*');
    await serveInbox(
      page,
      INBOX_ROWS.map((r) => (r.kind === 'escalation' ? { ...r, createdAt: minutesAgo(1) } : r)),
    );
    await page.goto('/overview');
    await expect(row.getByRole('img', { name: 'Unread' })).toBeVisible();
  });

  test('a localStorage that throws leaves every row unread and the page quiet', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Only the inbox's key throws: a localStorage that throws on every access
    // takes the whole app's startup down, which is not this box's concern.
    await page.addInitScript(() => {
      const proto = Storage.prototype;
      const realGet = proto.getItem;
      const realSet = proto.setItem;
      const guard = (key: string) => {
        if (key.startsWith('bs.inbox.')) throw new Error('denied');
      };
      proto.getItem = function (this: Storage, key: string) {
        guard(key);
        return realGet.call(this, key);
      };
      proto.setItem = function (this: Storage, key: string, value: string) {
        guard(key);
        realSet.call(this, key, value);
      };
    });
    await serveInbox(page, INBOX_ROWS);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/overview');
    const rows = page.locator('section.bs-inbox .bs-inbox__row');
    await expect(rows).toHaveCount(3);
    await expect(page.getByRole('img', { name: 'Unread' })).toHaveCount(3);
    await rows.nth(0).getByRole('link', { name: 'Open' }).click();
    expect(errors).toEqual([]);
  });

  for (const [vpName, viewport] of [
    ['desktop', VIEWPORTS.desktop],
    ['375px', PHONE],
  ] as const) {
    test(`${vpName}: empty inbox says nothing needs you`, async ({ page }) => {
      await serveInbox(page, []);
      await page.setViewportSize(viewport);
      await page.goto('/overview');
      await expect(page.getByText('Nothing needs you right now.')).toBeVisible();
      await expect(page.locator('.bs-inbox__group')).toHaveCount(0);
    });
  }
});

// Recent activity (ds-spec.md §4.1 point 1b): the 8 newest compact
// TimelineRows, directly under the inbox, "View all activity" to /activity,
// 4 rows on phone (the rest stay in the DOM, hidden by CSS per §4.1: "the
// meta line ends with the time" is unpaged kit behaviour, not re-tested
// here — ui/test/kitTimelineRowCompact.test.ts owns that).
test.describe('Home: Recent activity', () => {
  function syntheticEntries(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      eventId: `synth-${i}`,
      ts: minutesAgo(i),
      eventType: 'user_prompt',
      kind: 'prompt',
      taskId: null as string | null,
      agentId: null,
      planVersion: 1,
      causalParent: null,
      payload: { prompt: `Synthetic activity row ${i}` },
      project: 'black-smith',
      actor: 'operator',
      nearestPromptId: null,
    }));
  }

  async function serveTimeline(page: Page, entries: { eventId: string }[]): Promise<void> {
    await page.route('**/api/timeline?*', (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('limit') !== '8') {
        route.continue();
        return;
      }
      route.fulfill({
        json: { entries, nextBefore: null, newestId: entries[0]?.eventId ?? null },
      });
    });
  }

  test('desktop: requests limit=8 and renders what the server returns, link to Activity', async ({
    page,
  }) => {
    const entries = syntheticEntries(8);
    await serveTimeline(page, entries);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/overview');

    const section = page.locator('section', { has: page.locator('#recent-activity-heading') });
    await expect(section.locator('.bs-home__recent-activity > li')).toHaveCount(8);
    await expect(section.getByText('Synthetic activity row 0')).toBeVisible();
    await expect(section.getByRole('link', { name: 'View all activity' })).toHaveAttribute(
      'href',
      '/activity',
    );
  });

  test('375px: only the first 4 rows are visible, the rest stay collapsed off-screen', async ({
    page,
  }) => {
    const entries = syntheticEntries(8);
    await serveTimeline(page, entries);
    await page.setViewportSize(PHONE);
    await page.goto('/overview');

    const rows = page.locator('.bs-home__recent-activity > li');
    await expect(rows).toHaveCount(8);
    for (let i = 0; i < 4; i++) {
      await expect(rows.nth(i)).toBeVisible();
    }
    for (let i = 4; i < 8; i++) {
      await expect(rows.nth(i)).not.toBeVisible();
    }
  });

  // The prompt link ends a dispatch's meta line; a long meta must ellipsize
  // its own text, never cut the link off.
  for (const [label, viewport] of [
    ['1280px', VIEWPORTS.desktop],
    ['1280px with a 340px column', { width: 1280, height: 900 }],
    ['375px', PHONE],
  ] as const) {
    test(`${label}: a caused dispatch with a long meta keeps its prompt link whole`, async ({
      page,
    }) => {
      const entries = syntheticEntries(8).map((entry, i) =>
        i === 1
          ? {
              ...entry,
              eventType: 'dispatch_decision',
              kind: 'Dispatched',
              nearestPromptId: 'synth-2',
              payload: { agent_role: 'coder', round: 12 },
              run: {
                tokensIn: 1_234_567,
                tokensOut: 2_345_678,
                durationMs: 5_025_000,
                runStatus: 'done',
                dispatchedAt: entry.ts,
                round: 12,
              },
            }
          : entry,
      );
      await serveTimeline(page, entries);
      await page.setViewportSize(viewport);
      await page.goto('/overview');
      // A narrow column is what makes a real meta line overflow.
      if (label.includes('column')) {
        await page.addStyleTag({ content: '.bs-home__recent-activity { max-width: 340px; }' });
      }
      // Phone moves the link into the expanded detail (the meta copy is hidden).
      if (viewport.width <= 640) {
        await page
          .locator('.bs-home__recent-activity')
          .getByRole('button', { name: 'Show details' })
          .first()
          .click();
      }
      const link = page.locator('.bs-home__recent-activity .bs-timeline-row__because-of:visible');
      await expect(link).toHaveCount(1);
      const m = await link.evaluate((el) => {
        const meta = (el.closest('.bs-timeline-row__meta') ??
          el.closest('.bs-timeline-row')) as HTMLElement;
        const b = el.getBoundingClientRect();
        // A clipped part of the link is not hit-testable: probe its last pixel.
        const hit = document.elementFromPoint(b.right - 2, b.top + b.height / 2);
        return {
          right: b.right,
          metaRight: meta.getBoundingClientRect().right,
          whole: hit === el,
        };
      });
      expect(m.right).toBeLessThanOrEqual(m.metaRight + 0.5);
      expect(m.whole).toBe(true);
    });
  }

  // Fix round item 4 (ds-review.html, bs-primitives.css ~455): below 640px
  // the title link becomes `inline-flex`, so text-overflow needs an inner
  // span to target instead of the button itself — a long task-linked title
  // must still end in an ellipsis, not spill out of the row.
  test('375px: a long task-linked title still ellipsizes instead of spilling', async ({ page }) => {
    const entries = syntheticEntries(8).map((entry, i) =>
      i === 0
        ? {
            ...entry,
            taskId: 'epic-1/task-12-rewrite-onboarding-wizard-copy',
            payload: {
              prompt: 'Rewrite the onboarding wizard copy and every validation message end to end',
            },
          }
        : entry,
    );
    await serveTimeline(page, entries);
    await page.setViewportSize(PHONE);
    await page.goto('/overview');

    const link = page.getByRole('button', { name: /Rewrite the onboarding wizard copy/ });
    await expect(link).toBeVisible();
    const label = link.locator('.bs-timeline-row__title-label');
    const overflowing = await label.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflowing).toBe(true);
    await expect(label).toHaveCSS('text-overflow', 'ellipsis');
  });

  // ds-review.html:650-651: the compact feed's head does not wrap and its
  // title is `flex: 1` with ellipsis, so on desktop a long title stays on the
  // kind tag's line as one ellipsized line (it must not drop under the tag).
  test('1280px: a long compact title stays on the tag line, one line with ellipsis', async ({
    page,
  }) => {
    const entries = syntheticEntries(8).map((entry, i) =>
      i === 0
        ? { ...entry, payload: { prompt: 'A long synthetic compact title '.repeat(20) } }
        : entry,
    );
    await serveTimeline(page, entries);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/overview');

    const row = page.locator('.bs-timeline-row--compact').first();
    await expect(row).toBeVisible();
    const tag = row.locator('.bs-event-kind-tag');
    const title = row.locator('.bs-timeline-row__title');
    const tagBox = await tag.boundingBox();
    const titleBox = await title.boundingBox();
    expect(titleBox?.y ?? 0).toBeLessThan((tagBox?.y ?? 0) + (tagBox?.height ?? 0));
    expect(titleBox?.height ?? 0).toBeLessThan(
      (await title.evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight))) * 2,
    );
    await expect(title).toHaveCSS('text-overflow', 'ellipsis');
    expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  });

  // Fix round 2 item 1 (ds-review.html `.mrow.tlrow .mm`): a row with no
  // meta text (session-started has none) used to render no meta line at
  // all on phone, so it showed no time. Every visible row must show one.
  test('375px: every visible row shows its time exactly once, even with no details', async ({
    page,
  }) => {
    const entries = syntheticEntries(4).map((entry, i) =>
      i === 0
        ? { ...entry, eventType: 'session-started', kind: 'system', payload: { prompt: '' } }
        : entry,
    );
    await serveTimeline(page, entries);
    await page.setViewportSize(PHONE);
    await page.goto('/overview');

    const rows = page.locator('.bs-home__recent-activity .bs-timeline-row');
    for (let i = 0; i < 4; i++) {
      const row = rows.nth(i);
      await expect(row).toBeVisible();
      await expect(row.locator('.bs-timeline-row__ts:visible')).toHaveCount(1);
    }
  });

  for (const [vpName, viewport] of [
    ['desktop', VIEWPORTS.desktop],
    ['375px', PHONE],
  ] as const) {
    test(`${vpName}: empty recent activity says nothing has happened yet`, async ({ page }) => {
      await serveTimeline(page, []);
      await page.setViewportSize(viewport);
      await page.goto('/overview');
      const section = page.locator('section', { has: page.locator('#recent-activity-heading') });
      await expect(section.getByText('Nothing has happened yet.')).toBeVisible();
      await expect(section.locator('.bs-home__recent-activity')).toHaveCount(0);
    });
  }
});

// Live sessions (ds-spec.md §4.1 item 1a): the e2e server runs with an empty
// CLI registry, so the card data is served from a fixture instead. The
// wording and link targets are unit-tested in ui/test/liveSessions.test.ts;
// this layer proves the template renders them and that the section fits.
const FOREIGN = { id: 'abcd1234', label: 'project-b' };
const HOME_STORE = { id: 'home', label: 'home' };

function liveCard(over: Record<string, unknown>): Record<string, unknown> {
  return {
    cliSessionId: 'cli-x',
    name: null,
    cwdLabel: 'workspace-c',
    status: 'working',
    statusSince: minutesAgo(12),
    focus: null,
    ...over,
  };
}

const LIVE_CARDS = [
  liveCard({
    cliSessionId: 'cli-1',
    focus: {
      store: HOME_STORE,
      project: 'project-a',
      epicId: 'epic-a',
      epicTitle: 'Checkout redesign',
      wave: 6,
      now: [
        {
          role: 'coder',
          taskId: 'task-a1',
          taskTitle: 'Show shipping fee before payment',
          since: minutesAgo(9),
        },
        {
          role: 'tester',
          taskId: 'task-a2',
          taskTitle: 'Drop the extra confirm step',
          since: minutesAgo(8),
        },
        {
          role: 'reviewer',
          taskId: 'task-a3',
          taskTitle: 'Check the cart total',
          since: minutesAgo(7),
        },
      ],
      next: { kind: 'task', taskId: 'task-a4', taskTitle: 'Cart summary' },
    },
  }),
  liveCard({
    cliSessionId: 'cli-2',
    status: 'waiting_operator',
    statusSince: minutesAgo(5),
    focus: {
      store: FOREIGN,
      project: 'project-b',
      epicId: 'epic-b',
      epicTitle: 'Billing retries',
      wave: 2,
      now: [
        {
          role: 'reviewer',
          taskId: 'task-b1',
          taskTitle: 'Retry failed invoices',
          since: minutesAgo(6),
        },
      ],
      next: { kind: 'waiting_on_you' },
    },
  }),
  liveCard({ cliSessionId: 'cli-3', status: 'idle', statusSince: null, name: 'session-c' }),
];

function liveResponse(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'ok',
    configSource: 'default',
    readAt: FIXTURE_NOW_ISO,
    formatWarning: null,
    hidden: { outOfScope: 0, dead: 0, unparsed: 0, nonInteractive: 0 },
    sessions: LIVE_CARDS,
    ...over,
  };
}

async function serveLive(page: Page, body: Record<string, unknown>): Promise<void> {
  await page.route('**/api/cli-sessions*', (route) => route.fulfill({ json: body }));
}

async function expectCardsAligned(page: Page, indicators: number): Promise<void> {
  const items = page.getByRole('list', { name: 'Live sessions' }).getByRole('listitem');
  const n = await items.count();
  const lefts: number[] = [];
  for (let i = 0; i < n; i++) {
    const card = await items.nth(i).boundingBox();
    const title = await items.nth(i).locator('[class*="__title"]').first().boundingBox();
    expect(card).not.toBeNull();
    expect(title).not.toBeNull();
    expect((title?.x ?? 0) - (card?.x ?? 0)).toBeLessThan(24);
    lefts.push(title?.x ?? 0);
  }
  const firstLeft = lefts[0];
  if (firstLeft === undefined) throw new Error('no title left edge was measured');
  for (const x of lefts) expect(Math.abs(x - firstLeft)).toBeLessThanOrEqual(1);
  // Only the shell's LiveIndicator may wear .bs-live; the phone shell has none.
  await expect(page.locator('.bs-live')).toHaveCount(indicators);
}

const LONG_TITLE =
  'Reconcile the ledger exports across every regional storefront before the quarterly close so finance can sign off without manual spreadsheet patches';
const LONG_CARD = liveCard({
  cliSessionId: 'cli-4',
  focus: {
    store: HOME_STORE,
    project: 'project-d',
    epicId: 'epic-d',
    epicTitle: 'Ledger close',
    wave: 1,
    now: [{ role: 'coder', taskId: 'task-d1', taskTitle: LONG_TITLE, since: minutesAgo(3) }],
    next: { kind: 'task', taskId: 'task-d2', taskTitle: 'Short next task' },
  },
});

// Phone rhythm and hit boxes (visual pass): rows stay one text line tall, the
// title-to-status gap is the same linked or not, every target measures
// --bs-touch the way touchTargets.spec.ts does (getBoundingClientRect), no
// clamped ancestor clips that hit box, and a long linked title wraps inline
// after its role text inside the 2-line clamp.
async function measureLiveCards(page: Page): Promise<{
  rows: {
    text: string;
    oneLine: boolean;
    rowH: number;
    lineH: number;
    kTop: number;
    vTop: number;
  }[];
  titles: { linked: boolean; h: number; lines: number }[];
  targets: { name: string; h: number; clipped: string | null; inline: boolean }[];
  long: { firstTop: number; vTop: number; lineTops: number[]; clipBottom: number; lineH: number };
}> {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.bs-live-card'));
    const rows: {
      text: string;
      oneLine: boolean;
      rowH: number;
      lineH: number;
      kTop: number;
      vTop: number;
    }[] = [];
    const titles: { linked: boolean; h: number; lines: number }[] = [];
    const targets: { name: string; h: number; clipped: string | null; inline: boolean }[] = [];
    // Same definition as touchTargets.spec.ts: an <a> left display:inline whose
    // parent has real text beside it is an inline link inside prose.
    const isInlineProseLink = (el: Element): boolean => {
      if (el.tagName.toLowerCase() !== 'a') return false;
      if (getComputedStyle(el).display !== 'inline') return false;
      const parent = el.parentElement;
      if (!parent) return false;
      return Array.from(parent.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
      );
    };
    for (const card of cards) {
      const t = card.querySelector('.bs-live-card__title') as HTMLElement;
      const lh = parseFloat(getComputedStyle(t).lineHeight);
      const tcs = getComputedStyle(t);
      const th = t.getBoundingClientRect().height;
      const content = th - parseFloat(tcs.paddingTop) - parseFloat(tcs.paddingBottom);
      titles.push({ linked: !!t.querySelector('a'), h: th, lines: Math.round(content / lh) });
      for (const row of Array.from(card.querySelectorAll('.bs-live-card__line'))) {
        const k = row.querySelector('.bs-live-card__k') as HTMLElement;
        const v = row.querySelector('.bs-live-card__v, .bs-live-card__more') as HTMLElement;
        const vlh = parseFloat(getComputedStyle(v).lineHeight) || 0;
        const textRange = document.createRange();
        textRange.selectNodeContents(v);
        const tops = new Set(Array.from(textRange.getClientRects()).map((r) => Math.round(r.top)));
        rows.push({
          text: (v.textContent ?? '').trim().slice(0, 30),
          oneLine: tops.size <= 1,
          rowH: row.getBoundingClientRect().height,
          lineH: vlh,
          kTop: k.getBoundingClientRect().top,
          vTop: v.classList.contains('bs-live-card__more')
            ? v.getBoundingClientRect().top +
              parseFloat(getComputedStyle(v).borderTopWidth) +
              parseFloat(getComputedStyle(v).paddingTop)
            : v.getBoundingClientRect().top + parseFloat(getComputedStyle(v).paddingTop),
        });
      }
      const els = Array.from(card.querySelectorAll('a[href], button'));
      for (const el of els) {
        // A wrapped link has one hit box per line box; a line the clamp hides
        // (its glyphs start past the clamped box's content edge) is not a target.
        const pad = parseFloat(getComputedStyle(el).paddingTop);
        const rects = Array.from(el.getClientRects());
        let clipped: string | null = null;
        let h = Number.POSITIVE_INFINITY;
        for (const r of rects) {
          let hidden = false;
          let why: string | null = null;
          for (let p = el.parentElement; p && p !== card.parentElement; p = p.parentElement) {
            const cs = getComputedStyle(p);
            if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
            const pr = p.getBoundingClientRect();
            const top = pr.top + parseFloat(cs.borderTopWidth);
            const bottom = pr.bottom - parseFloat(cs.borderBottomWidth);
            if (r.top + pad >= bottom - parseFloat(cs.paddingBottom) - 0.5) {
              hidden = true;
              break;
            }
            if (!why && (r.top < top - 0.5 || r.bottom > bottom + 0.5)) {
              why = `${p.className} [${top.toFixed(1)}, ${bottom.toFixed(1)}] vs hit [${r.top.toFixed(1)}, ${r.bottom.toFixed(1)}]`;
            }
          }
          if (hidden) continue;
          h = Math.min(h, r.height);
          if (why && !clipped) clipped = why;
        }
        targets.push({
          name: (el.textContent ?? '').trim().slice(0, 30),
          h,
          clipped,
          inline: isInlineProseLink(el),
        });
      }
    }
    const longCard = cards[cards.length - 1];
    if (!longCard) throw new Error('no live-session card rendered');
    const v = longCard.querySelector('.bs-live-card__v') as HTMLElement;
    const a = v.querySelector('a') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(a);
    const rects = Array.from(range.getClientRects());
    const vr = v.getBoundingClientRect();
    const lineH = parseFloat(getComputedStyle(v).lineHeight);
    const cs = getComputedStyle(v);
    return {
      rows,
      titles,
      targets,
      long: {
        firstTop: (
          rects[0] ??
          (() => {
            throw new Error('long link has no client rects');
          })()
        ).top,
        vTop: vr.top + parseFloat(cs.paddingTop),
        lineTops: rects.map((r) => r.top),
        clipBottom: vr.bottom - parseFloat(cs.borderBottomWidth),
        lineH,
      },
    };
  });
}

// Hit-box soundness (kanban.spec.ts precedent: a grown hit box may overlap
// plain text and gaps, never another interactive element, and stays inside its
// card). A hit box is the element's client rects, each clipped to the padding
// box of every ancestor whose overflow is not visible.
async function expectHitBoxesSound(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    type Box = { l: number; t: number; r: number; b: number };
    const out = {
      overlaps: [] as string[],
      misses: [] as string[],
      outside: [] as string[],
      count: 0,
    };
    const boxesOf = (el: Element): Box[] => {
      const res: Box[] = [];
      for (const rc of Array.from(el.getClientRects())) {
        let box: Box = { l: rc.left, t: rc.top, r: rc.right, b: rc.bottom };
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
          const pr = p.getBoundingClientRect();
          box = {
            l: Math.max(box.l, pr.left + parseFloat(cs.borderLeftWidth)),
            t: Math.max(box.t, pr.top + parseFloat(cs.borderTopWidth)),
            r: Math.min(box.r, pr.right - parseFloat(cs.borderRightWidth)),
            b: Math.min(box.b, pr.bottom - parseFloat(cs.borderBottomWidth)),
          };
        }
        if (box.r > box.l && box.b > box.t) res.push(box);
      }
      return res;
    };
    const cards = Array.from(document.querySelectorAll('.bs-live-card'));
    const all: { el: Element; label: string; boxes: Box[] }[] = [];
    for (const card of cards) {
      const cr = card.getBoundingClientRect();
      for (const el of Array.from(
        card.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])'),
      )) {
        const label = (el.textContent ?? '').trim().slice(0, 30);
        const boxes = boxesOf(el);
        all.push({ el, label, boxes });
        for (const b of boxes) {
          if (
            b.l < cr.left - 0.5 ||
            b.r > cr.right + 0.5 ||
            b.t < cr.top - 0.5 ||
            b.b > cr.bottom + 0.5
          ) {
            out.outside.push(
              `"${label}" [${b.t.toFixed(1)}, ${b.b.toFixed(1)}] vs card [${cr.top.toFixed(1)}, ${cr.bottom.toFixed(1)}]`,
            );
          }
        }
        // g. the centre of each visible text line hits this element
        const range = document.createRange();
        range.selectNodeContents(el);
        for (const lr of Array.from(range.getClientRects())) {
          if (lr.width === 0 || lr.height === 0) continue;
          const x = lr.left + lr.width / 2;
          const y = lr.top + lr.height / 2;
          if (!boxes.some((b) => x >= b.l && x <= b.r && y >= b.t && y <= b.b)) continue;
          const hit = document.elementFromPoint(x, y);
          if (!hit || !(hit === el || el.contains(hit))) {
            out.misses.push(
              `"${label}" line at y=${y.toFixed(1)} lands on ${hit?.className || hit?.tagName}`,
            );
          }
        }
      }
    }
    out.count = all.length;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const ai = all[i];
        const aj = all[j];
        if (!ai || !aj) throw new Error('overlap index out of range');
        for (const a of ai.boxes) {
          for (const b of aj.boxes) {
            const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
            const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
            if (w > 0.5 && h > 0.5) {
              out.overlaps.push(
                `"${ai.label}" x "${aj.label}" overlap ${w.toFixed(1)}x${h.toFixed(1)}`,
              );
            }
          }
        }
      }
    }
    return out;
  });
  expect(r.count).toBeGreaterThanOrEqual(8);
  expect.soft(r.overlaps, 'f. hit boxes overlapping each other').toEqual([]);
  expect.soft(r.misses, 'g. taps on the text land elsewhere').toEqual([]);
  expect.soft(r.outside, 'h. hit box outside its card').toEqual([]);
}

const FONT_VARIANTS: { label: string; css: string | null }[] = [
  { label: '', css: null },
  { label: ' (Arial metrics)', css: ':root { --bs-font-sans: Arial, sans-serif; }' },
];

test.describe('Home: Live sessions', () => {
  test('desktop: one labelled card per session with title, status, Now and Next', async ({
    page,
  }) => {
    await serveLive(page, liveResponse());
    await page.goto('/overview');
    const list = page.getByRole('list', { name: 'Live sessions' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    const first = list.getByRole('listitem').nth(0);
    await expectCardsAligned(page, 1);
    await expect(first).toContainText('project-a · epic-a · wave 6');
    await expect(first).toContainText('Working');
    await expect(first).toContainText('Builder on Show shipping fee before payment');
    await expect(first).toContainText('Tester on Drop the extra confirm step');
    await expect(first.getByRole('button', { name: '+ 1 more' })).toBeVisible();
    await expect(first.getByRole('link', { name: 'Open epic Checkout redesign' })).toHaveAttribute(
      'href',
      '/work/kanban?epic=epic-a',
    );
    await expect(first.getByRole('link', { name: 'Open task Cart summary' })).toHaveAttribute(
      'href',
      '/tasks/task-a4',
    );
    await first.getByRole('button', { name: '+ 1 more' }).click();
    await expect(first).toContainText('Code reviewer on Check the cart total');
    await expect(first.getByRole('button', { name: /more/ })).toHaveCount(0);
  });

  test('the status time reads "for N min", not "N min ago", on desktop and at 375px', async ({
    page,
  }) => {
    await serveLive(page, liveResponse());
    for (const size of [null, PHONE]) {
      if (size) await page.setViewportSize(size);
      await page.goto('/overview');
      const items = page.getByRole('list', { name: 'Live sessions' }).getByRole('listitem');
      const t = items.nth(0).locator('.bs-live-card__status time');
      await expect(t).toHaveText('for 12 min');
      await expect(t).toHaveAttribute('datetime', minutesAgo(12));
      await expect(items.nth(1).locator('.bs-live-card__status time')).toHaveText('for 5 min');
      await expect(items.nth(0)).not.toContainText(' ago');
    }
  });

  test('a foreign store task links with ?store=, and waiting on you reads in words', async ({
    page,
  }) => {
    await serveLive(page, liveResponse());
    await page.goto('/overview');
    const second = page.getByRole('list', { name: 'Live sessions' }).getByRole('listitem').nth(1);
    await expect(second).toContainText('Waiting for you');
    await expect(second).toContainText('Waiting on you');
    await expect(
      second.getByRole('link', { name: 'Open task Retry failed invoices' }),
    ).toHaveAttribute('href', '/tasks/task-b1?store=abcd1234');
  });

  test('an unlinked session shows its folder, name and no Now or Next', async ({ page }) => {
    await serveLive(page, liveResponse());
    await page.goto('/overview');
    const third = page.getByRole('list', { name: 'Live sessions' }).getByRole('listitem').nth(2);
    await expect(third).toContainText('workspace-c · session-c');
    await expect(third).toContainText('Idle');
    await expect(third).toContainText('Not linked to a Blacksmith epic');
    await expect(third).not.toContainText('Now');
    await expect(third).not.toContainText('Next');
    await expect(third.getByRole('link')).toHaveCount(0);
  });

  test('375px: one Now line, the rest behind "+ N more", and no sideways scroll', async ({
    page,
  }) => {
    await serveLive(page, liveResponse());
    await page.setViewportSize(PHONE);
    await page.goto('/overview');
    const first = page.getByRole('list', { name: 'Live sessions' }).getByRole('listitem').nth(0);
    await expect(first).toContainText('Builder on Show shipping fee before payment');
    await expect(first).not.toContainText('Tester on');
    await expect(first.getByRole('button', { name: '+ 2 more' })).toBeVisible();
    await expectCardsAligned(page, 0);
    const box = await first.getByRole('button', { name: '+ 2 more' }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });

  // The 44px floor must hold for any font, not just the macOS system one: the
  // CI runner resolves the stack to an Arial-metric font, whose inline content
  // area is shorter than the line height.
  for (const font of FONT_VARIANTS) {
    test(`375px: tight rows, one title rhythm, 44px unclipped targets, long title clamps inline${font.label}`, async ({
      page,
    }) => {
      await serveLive(page, liveResponse({ sessions: [...LIVE_CARDS, LONG_CARD] }));
      await page.setViewportSize(PHONE);
      await page.goto('/overview');
      if (font.css) await page.addStyleTag({ content: font.css });
      await expect(page.locator('.bs-live-card')).toHaveCount(4);
      const m = await measureLiveCards(page);
      // a. one text line per row, key top-aligned with the value
      expect(m.rows.some((r) => r.oneLine)).toBe(true);
      for (const r of m.rows) {
        if (!r.oneLine) continue;
        // The "+ N more" row is the one row that carries added gap (20px, so its
        // 44px box and the Next link's box below never overlap), so it is exempt.
        if (!r.text.startsWith('+')) {
          expect(r.rowH, `row "${r.text}" height`).toBeLessThanOrEqual(r.lineH + 2);
        }
        expect(Math.abs(r.kTop - r.vTop), `row "${r.text}" key/value tops`).toBeLessThanOrEqual(2);
      }
      // b. linked and unlinked one-line titles share one height
      const one = m.titles.filter((t) => t.lines === 1);
      const linked = one.find((t) => t.linked);
      const unlinked = one.find((t) => !t.linked);
      expect(linked && unlinked).toBeTruthy();
      expect(Math.abs((linked?.h ?? 0) - (unlinked?.h ?? 0))).toBeLessThanOrEqual(1);
      // c + d. every target the inline-link-in-prose exemption (WCAG 2.2 SC
      // 2.5.8) does not cover measures >= 44, and no clamped ancestor clips any
      // target. The Now task links read "Builder on <link>", so they are exempt.
      expect(m.targets.length).toBeGreaterThanOrEqual(8);
      expect(m.targets.some((t) => t.inline)).toBe(true);
      expect(m.targets.some((t) => !t.inline)).toBe(true);
      for (const t of m.targets) {
        if (!t.inline) expect(t.h, `target "${t.name}" height`).toBeGreaterThanOrEqual(44 - 1 / 64);
        expect(t.clipped, `target "${t.name}" clipped`).toBeNull();
      }
      // f + g + h. hit boxes never overlap, taps land on the text, cards contain them
      await expectHitBoxesSound(page);
      // e. long title: first line shares the role text's line, at most 2 lines show
      expect(Math.abs(m.long.firstTop - m.long.vTop)).toBeLessThanOrEqual(2);
      // The link wraps to 3+ lines; the 2-line clamp hides the rest. Line tops
      // are measured from the value's content top; any line from the 3rd on that
      // starts above the clip edge (the box's padding edge) would show through.
      expect(m.long.lineTops.length).toBeGreaterThanOrEqual(3);
      const below = m.long.lineTops.filter(
        (top) => top >= m.long.vTop + m.long.lineH * 1.5 && top < m.long.clipBottom,
      );
      expect(below).toEqual([]);
    });
  }

  test('card body padding is space-3 at 375px and space-4 on desktop, on all four sides', async ({
    page,
  }) => {
    await serveLive(page, liveResponse());
    for (const [size, token] of [
      [null, '--bs-space-4'],
      [PHONE, '--bs-space-3'],
    ] as const) {
      if (size) await page.setViewportSize(size);
      await page.goto('/overview');
      await expect(page.locator('.bs-live-card')).toHaveCount(3);
      const r = await page.evaluate((t) => {
        const probe = document.createElement('div');
        probe.style.padding = `var(${t})`;
        document.body.appendChild(probe);
        const want = getComputedStyle(probe).paddingTop;
        probe.remove();
        const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
        return {
          want,
          got: [...document.querySelectorAll('.bs-live-card .bs-card__body')].map((b) =>
            sides.map((s) => getComputedStyle(b)[`padding${s}`]),
          ),
        };
      }, token);
      expect(r.got.length).toBe(3);
      for (const g of r.got) expect(g, `${token} on every side`).toEqual(Array(4).fill(r.want));
    }
  });

  for (const font of FONT_VARIANTS) {
    test(`375px expanded: two Now links above the next task link still never overlap${font.label}`, async ({
      page,
    }) => {
      await serveLive(page, liveResponse({ sessions: [...LIVE_CARDS, LONG_CARD] }));
      await page.setViewportSize(PHONE);
      await page.goto('/overview');
      const first = page.getByRole('list', { name: 'Live sessions' }).getByRole('listitem').nth(0);
      if (font.css) await page.addStyleTag({ content: font.css });
      await first.getByRole('button', { name: '+ 2 more' }).click();
      await expect(first).toContainText('Code reviewer on Check the cart total');
      await expectHitBoxesSound(page);
    });
  }

  test('empty: says so, with how many sessions were hidden', async ({ page }) => {
    await serveLive(
      page,
      liveResponse({
        sessions: [],
        hidden: { outOfScope: 2, dead: 1, unparsed: 0, nonInteractive: 0 },
      }),
    );
    await page.goto('/overview');
    await expect(page.getByText('No live Blacksmith sessions')).toBeVisible();
    await expect(page.getByText('3 other sessions hidden')).toBeVisible();
  });

  test('absent: says tracking is not set up, with no count', async ({ page }) => {
    await serveLive(page, liveResponse({ state: 'absent', sessions: [] }));
    await page.goto('/overview');
    await expect(page.getByText('Session tracking is not set up on this machine.')).toBeVisible();
    await expect(page.getByText(/hidden/)).toHaveCount(0);
  });

  test('unreadable and a failed fetch each show their own banner, never an empty list', async ({
    page,
  }) => {
    await serveLive(
      page,
      liveResponse({ state: 'unreadable', sessions: [], formatWarning: 'unknown format' }),
    );
    await page.goto('/overview');
    await expect(page.getByText('Could not read the live sessions: unknown format')).toBeVisible();
    await expect(page.getByText('No live Blacksmith sessions')).toHaveCount(0);
    await page.unroute('**/api/cli-sessions*');
    await page.route('**/api/cli-sessions*', (route) => route.fulfill({ status: 500, json: {} }));
    await page.reload();
    await expect(page.getByText('Could not load live sessions')).toBeVisible();
    await expect(page.getByText('No live Blacksmith sessions')).toHaveCount(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      test(`screenshot live sessions ${vpName}/${theme}`, async ({ page }) => {
        await serveLive(page, liveResponse());
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/overview');
        const section = page.locator('section[aria-labelledby="live-sessions-heading"]');
        await settleForShot(page, section.getByRole('listitem').first());
        await shootElement(section, `home-live-sessions-${vpName}-${theme}`);
      });
    }
  }
});

test.describe('Home: Running now follows Active/All (S8)', () => {
  const toggle = (page: Page) => page.getByRole('navigation', { name: 'Activity scope' });
  const running = (page: Page) => page.locator('section[aria-labelledby="running-heading"]');
  const oneOfTwo = (page: Page) =>
    stubActiveScope(page, [], { liveSessions: 1, projects: [activeProject('blacksmith')] });
  const budget = (page: Page) => page.locator('section[aria-labelledby="budget-heading"]');
  // Pins the overview's one-hour budget change to a known figure, whatever the fixture holds.
  const withDelta = (page: Page, delta: number) =>
    page.route('**/api/overview*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.budgetUsedPctPointDelta1h = delta;
      await route.fulfill({ response, json: body });
    });

  test('Active hides the quiet project and offers it back; All shows it muted', async ({
    page,
  }) => {
    await oneOfTwo(page);
    await page.goto('/overview');
    await expect(page.getByRole('link', { name: 'View blacksmith in Work' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'View demo-hub in Work' })).toHaveCount(0);
    await expect(running(page).getByText('demo-hub is quiet ·')).toBeVisible();
    await running(page).getByRole('link', { name: 'Show it' }).click();
    await expect(page).toHaveURL(/[?&]scope=all\b/);
    const quiet = running(page).locator('.bs-home__card--quiet');
    await expect(quiet).toHaveCount(1);
    await expect(quiet).toContainText('demo-hub');
    await expect(running(page).getByText('is quiet')).toHaveCount(0);
  });

  test('the budget follows the cards on screen', async ({ page }) => {
    await oneOfTwo(page);
    await page.goto('/overview');
    await expect(page.getByRole('link', { name: 'View blacksmith in Work' })).toBeVisible();
    const budget = page.locator('section[aria-labelledby="budget-heading"]');
    const active = await budget.innerText();
    await toggle(page).getByRole('link', { name: 'All' }).click();
    await expect(page.locator('.bs-home__card--quiet')).toHaveCount(1);
    await expect(budget).not.toHaveText(active);
  });

  test('no live session: the empty line replaces the cards, never "Nothing is running"', async ({
    page,
  }) => {
    await stubActiveScope(page, [], { liveSessions: 0 });
    await page.goto('/overview');
    await expect(page.getByText('Nothing is active right now. ·')).toBeVisible();
    await expect(page.locator('.bs-home__cards')).toHaveCount(0);
    await expect(page.getByText('Nothing is running right now.')).toHaveCount(0);
    await running(page).getByRole('link', { name: 'Show all' }).click();
    await expect(page).toHaveURL(/[?&]scope=all\b/);
    await expect(page.getByRole('link', { name: 'View blacksmith in Work' })).toBeVisible();
  });

  test('only unlinked sessions: the count line', async ({ page }) => {
    await stubActiveScope(page, [], { liveSessions: 2, unlinkedSessions: 2 });
    await page.goto('/overview');
    await expect(page.getByText('2 live sessions, none on an epic · Show all')).toBeVisible();
    await expect(page.locator('.bs-home__cards')).toHaveCount(0);
  });

  test('a project with no live session says so', async ({ page }) => {
    await oneOfTwo(page);
    await page.goto('/overview?project=demo-hub');
    await expect(page.getByText('No live session is on this project · Show all')).toBeVisible();
    await expect(page.locator('.bs-home__cards')).toHaveCount(0);
  });

  test('unmeasured: every card, the note under the head, never "none active"', async ({ page }) => {
    await stubActiveScope(page, [], { measured: false, liveSessions: 0 });
    await page.goto('/overview');
    await expect(running(page).getByText("Live sessions can't be read here")).toBeVisible();
    await expect(page.getByRole('link', { name: 'View blacksmith in Work' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'View demo-hub in Work' })).toBeVisible();
    await expect(page.locator('.bs-home__card--quiet')).toHaveCount(0);
    await expect(page.getByText('Nothing is active right now.')).toHaveCount(0);
    await expect(page.getByText('Nothing is running right now.')).toHaveCount(0);
  });

  test('while the scope answer is delayed, no All cards render under Active', async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/active-scope*', async (route) => {
      await gate;
      await route.fulfill({
        json: {
          measured: true,
          readAt: FIXTURE_NOW_ISO,
          liveSessions: 1,
          unlinkedSessions: 0,
          projects: [activeProject('blacksmith')],
          epics: [],
          factorySessions: [],
        },
      });
    });
    await page.goto('/overview');
    await expect(
      page.getByRole('heading', { name: 'What the factory decided recently' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'View demo-hub in Work' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'View blacksmith in Work' })).toHaveCount(0);
    release();
    await expect(page.getByRole('link', { name: 'View blacksmith in Work' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'View demo-hub in Work' })).toHaveCount(0);
  });

  test('while the scope answer is delayed, Budget keeps its loading state too', async ({
    page,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/active-scope*', async (route) => {
      await gate;
      await route.fulfill({
        json: activeScopeBody([], { liveSessions: 1, projects: [activeProject('blacksmith')] }),
      });
    });
    await page.goto('/overview');
    // Home has mounted (its decisions list starts in its loading state), and
    // the overview is in once that list has left it; only the scope is held.
    await expect(page.getByRole('heading', { name: 'Budget' })).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="decisions-heading"] .bs-skeleton'),
    ).toHaveCount(0);
    await expect(budget(page).locator('.bs-skeleton')).toBeVisible();
    await expect(budget(page).locator('.bs-home__tokens')).toHaveCount(0);
    release();
    await expect(budget(page).locator('.bs-home__tokens')).toBeVisible();
    await expect(budget(page).locator('.bs-skeleton')).toHaveCount(0);
  });

  test('a ?project= whose only live session is in another store is active', async ({ page }) => {
    await stubActiveScope(page, [], {
      liveSessions: 1,
      projects: [{ ...activeProject('demo-hub'), storeId: 'store-b' }],
    });
    await page.goto('/overview?project=demo-hub');
    await expect(page.getByRole('link', { name: 'View demo-hub in Work' })).toBeVisible();
    await expect(page.getByText('No live session is on this project')).toHaveCount(0);
  });

  test('Active with a hidden card drops the one-hour change; All keeps it', async ({ page }) => {
    await oneOfTwo(page);
    await withDelta(page, 4);
    await page.goto('/overview');
    await expect(budget(page).locator('.bs-home__tokens')).toBeVisible();
    await expect(budget(page).getByText('4 points higher than an hour ago')).toHaveCount(0);
    await page.goto('/overview?scope=all');
    await expect(page.locator('.bs-home__card--quiet')).toHaveCount(1);
    await expect(budget(page).getByText('4 points higher than an hour ago')).toBeVisible();
  });

  test('Active with every card hidden: Budget says no epic runs on an active project', async ({
    page,
  }) => {
    await stubActiveScope(page, [], { liveSessions: 0 });
    await page.goto('/overview');
    await expect(page.getByText('Nothing is active right now. ·')).toBeVisible();
    await expect(budget(page).getByText('No epic is running on an active project.')).toBeVisible();
  });

  test('a session on a project before its epic opens: its card shows, no "none on an epic" line', async ({
    page,
  }) => {
    await stubActiveScope(page, [], {
      liveSessions: 2,
      unlinkedSessions: 1,
      factorySessions: [],
      projects: [activeProject('blacksmith')],
    });
    await page.goto('/overview');
    await expect(page.getByRole('link', { name: 'View blacksmith in Work' })).toBeVisible();
    await expect(running(page).getByText('none on an epic')).toHaveCount(0);
  });

  test('an active card with no agent working hides the agents line, keeps the epics line', async ({
    page,
  }) => {
    await stubActiveScope(page, [], {
      liveSessions: 1,
      projects: [activeProject('blacksmith', 0)],
    });
    await page.goto('/overview');
    const card = running(page).locator('.bs-card', {
      has: page.getByRole('link', { name: 'View blacksmith in Work' }),
    });
    await expect(card).toBeVisible();
    await expect(card.getByText(/epics? in flight/)).toBeVisible();
    await expect(card.getByText(/agents? working/)).toHaveCount(0);
  });

  test('phone 375px: the toggle and the quiet-line link are 44px targets, no sideways scroll', async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await oneOfTwo(page);
    await page.goto('/overview');
    const show = running(page).getByRole('link', { name: 'Show it' });
    await expect(show).toBeVisible();
    expect((await show.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    for (const name of ['Active', 'All']) {
      const box = await toggle(page).getByRole('link', { name }).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`screenshot 1 of 2 projects active, desktop/${theme}`, async ({ page }) => {
      await setTheme(page, theme);
      await oneOfTwo(page);
      await page.goto('/overview');
      await settleForShot(page, page.getByRole('link', { name: 'View blacksmith in Work' }));
      await shootElement(running(page), `home-running-now-scope-active-desktop-${theme}`);
    });
  }

  test('screenshot 1 of 2 projects active, phone 375/light', async ({ page }) => {
    await setTheme(page, 'light');
    await page.setViewportSize(PHONE);
    await oneOfTwo(page);
    await page.goto('/overview');
    await settleForShot(page, page.getByRole('link', { name: 'View blacksmith in Work' }));
    await shootElement(running(page), 'home-running-now-scope-active-phone-light');
  });

  test('screenshot none active, desktop/light', async ({ page }) => {
    await setTheme(page, 'light');
    await stubActiveScope(page, [], { liveSessions: 0 });
    await page.goto('/overview');
    await settleForShot(page, page.getByText('Nothing is active right now. ·'));
    await shootElement(running(page), 'home-running-now-scope-none-desktop-light');
  });

  test('screenshot unmeasured, desktop/light', async ({ page }) => {
    await setTheme(page, 'light');
    await stubActiveScope(page, [], { measured: false, liveSessions: 0 });
    await page.goto('/overview');
    await settleForShot(page, page.getByRole('link', { name: 'View blacksmith in Work' }));
    await shootElement(running(page), 'home-running-now-scope-unmeasured-desktop-light');
  });

  // All with one muted card and one active card whose agents line is hidden at 0.
  const allMutedAndIdle = (page: Page) =>
    stubActiveScope(page, [], { liveSessions: 1, projects: [activeProject('blacksmith', 0)] });

  for (const theme of ['light', 'dark'] as const) {
    test(`screenshot All, one muted card and one with no agent working, desktop/${theme}`, async ({
      page,
    }) => {
      await setTheme(page, theme);
      await allMutedAndIdle(page);
      await page.goto('/overview?scope=all');
      await expect(page.locator('.bs-home__card--quiet')).toHaveCount(1);
      await settleForShot(page, page.getByRole('link', { name: 'View blacksmith in Work' }));
      await shootElement(running(page), `home-running-now-scope-all-desktop-${theme}`);
    });
  }

  test('screenshot All, one muted card and one with no agent working, phone 375/light', async ({
    page,
  }) => {
    await setTheme(page, 'light');
    await page.setViewportSize(PHONE);
    await allMutedAndIdle(page);
    await page.goto('/overview?scope=all');
    await expect(page.locator('.bs-home__card--quiet')).toHaveCount(1);
    await settleForShot(page, page.getByRole('link', { name: 'View blacksmith in Work' }));
    await shootElement(running(page), 'home-running-now-scope-all-phone-light');
  });

  test('screenshot only unlinked sessions, desktop/light', async ({ page }) => {
    await setTheme(page, 'light');
    await stubActiveScope(page, [], { liveSessions: 2, unlinkedSessions: 2 });
    await page.goto('/overview');
    await settleForShot(page, page.getByText('2 live sessions, none on an epic · Show all'));
    await shootElement(running(page), 'home-running-now-scope-unlinked-desktop-light');
  });

  test('screenshot no live session on the project, desktop/light', async ({ page }) => {
    await setTheme(page, 'light');
    await oneOfTwo(page);
    await page.goto('/overview?project=demo-hub');
    await settleForShot(page, page.getByText('No live session is on this project · Show all'));
    await shootElement(running(page), 'home-running-now-scope-no-session-desktop-light');
  });

  test('screenshot none active, phone 375/light', async ({ page }) => {
    await setTheme(page, 'light');
    await page.setViewportSize(PHONE);
    await stubActiveScope(page, [], { liveSessions: 0 });
    await page.goto('/overview');
    await settleForShot(page, page.getByText('Nothing is active right now. ·'));
    await shootElement(running(page), 'home-running-now-scope-none-phone-light');
  });

  test('screenshot unmeasured, phone 375/light', async ({ page }) => {
    await setTheme(page, 'light');
    await page.setViewportSize(PHONE);
    await stubActiveScope(page, [], { measured: false, liveSessions: 0 });
    await page.goto('/overview');
    await settleForShot(page, page.getByRole('link', { name: 'View blacksmith in Work' }));
    await shootElement(running(page), 'home-running-now-scope-unmeasured-phone-light');
  });
});

// "What the factory decided recently": one plain line per decision, the role
// and the short task name, never the provider, the tier or the free-text reason.
test.describe('Home: What the factory decided recently', () => {
  const LONG_REASON = `${'internal note round 4 finding F-12 commit 0a1b2c3 '.repeat(8)}`;
  const dispatch = (n: number, extra: Record<string, unknown> = {}) => ({
    eventId: `d-${n}`,
    ts: minutesAgo(n),
    agentRole: 'coder',
    provider: 'claude',
    modelTier: 'mid',
    taskId: 'epic-a/task-3-settings-integrations',
    reason: LONG_REASON,
    round: 1,
    ...extra,
  });
  const serve = (page: Page, rows: unknown[]) =>
    page.route('**/api/overview*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.recentDispatches = rows;
      await route.fulfill({ response, json: body });
    });
  const card = (page: Page) => page.locator('section[aria-labelledby="decisions-heading"]');

  for (const [label, viewport] of [
    ['1280px', VIEWPORTS.desktop],
    ['375px', PHONE],
  ] as const) {
    test(`${label}: a row is one ellipsized plain line with the full text in title`, async ({
      page,
    }) => {
      await serve(page, [dispatch(5), dispatch(9, { taskId: null }), dispatch(12, { round: 2 })]);
      await page.setViewportSize(viewport);
      await page.goto('/overview');
      const rows = card(page).locator('.bs-home__decision');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toHaveText('Builder started on Settings integrations');
      await expect(rows.nth(1)).toHaveText('Builder started');
      await expect(rows.nth(2)).toHaveText('Builder started on Settings integrations · round 2');
      await expect(rows.nth(0)).toHaveAttribute(
        'title',
        'Builder started on Settings integrations',
      );
      await expect(card(page)).not.toContainText(/internal note|Claude|standard model/);
      const first = await rows.nth(0).evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          height: el.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(cs.lineHeight),
          overflow: cs.textOverflow,
          nowrap: cs.whiteSpace,
        };
      });
      expect(first.overflow).toBe('ellipsis');
      expect(first.nowrap).toBe('nowrap');
      if (viewport.width <= 640) expect(first.height).toBeGreaterThanOrEqual(44);
      else expect(first.height).toBeLessThan(first.lineHeight * 2);
    });
  }

  test('a minted follow-up id reads Follow-up fix, with no hex', async ({ page }) => {
    await serve(page, [dispatch(5, { taskId: 'followup-48bb6826' })]);
    await page.goto('/overview');
    await expect(card(page).locator('.bs-home__decision')).toHaveText(
      'Builder started on Follow-up fix',
    );
    await expect(card(page)).not.toContainText('48bb6826');
  });

  test('over two stores a foreign row names its project and opens the task in its store', async ({
    page,
  }) => {
    await serve(page, [
      dispatch(5),
      dispatch(8, { eventId: 'f-1', store: { id: 'ab12cd34', label: 'project-b' } }),
    ]);
    await page.goto('/overview');
    const rows = card(page).locator('li');
    await expect(rows.nth(1)).toContainText('project-b');
    await expect(rows.nth(1).locator('.bs-home__decision')).toHaveAttribute(
      'href',
      '/tasks/epic-a%2Ftask-3-settings-integrations?store=ab12cd34',
    );
    await expect(rows.nth(0).locator('.bs-home__decision')).toHaveAttribute(
      'href',
      '/tasks/epic-a%2Ftask-3-settings-integrations',
    );
  });

  test('over one store no row names a project', async ({ page }) => {
    await serve(page, [dispatch(5), dispatch(8, { eventId: 'f-2' })]);
    await page.goto('/overview');
    await expect(card(page).locator('.bs-home__decision-project')).toHaveCount(0);
  });

  const LONG_LABEL = 'project-b-with-a-much-longer-name-than-fits';
  const foreignRows = () => [
    dispatch(5),
    dispatch(8, {
      eventId: 'f-3',
      taskId: 'epic-a/task-4-settings-panels-copy-and-layout',
      store: { id: 'ab12cd34', label: LONG_LABEL },
    }),
  ];
  const measureRow = (page: Page) =>
    card(page)
      .locator('li')
      .nth(1)
      .evaluate((li) => {
        const link = li.querySelector('.bs-home__decision') as HTMLElement;
        const label = li.querySelector('.bs-home__decision-project') as HTMLElement;
        const time = li.lastElementChild as HTMLElement;
        const width = (text: string) => {
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
          probe.style.font = getComputedStyle(link).font;
          probe.textContent = text;
          document.body.appendChild(probe);
          const w = probe.getBoundingClientRect().width;
          probe.remove();
          return w;
        };
        const box = (el: Element) => el.getBoundingClientRect();
        const text = link.textContent?.trim() ?? '';
        const range = document.createRange();
        range.selectNodeContents(link);
        return {
          textEnd: Math.min(range.getBoundingClientRect().right, box(link).right),
          fullLine: text,
          linkWidth: link.clientWidth,
          cut: link.scrollWidth > link.clientWidth,
          prefix: width('Builder started on Settings'),
          ellipsis: width('\u2026'),
          labelCut: label.scrollWidth > label.clientWidth,
          labelTitle: label.getAttribute('title'),
          linkTitle: link.getAttribute('title'),
          linkHeight: box(link).height,
          timeWrap: getComputedStyle(time).whiteSpace,
          link: { left: box(link).left, right: box(link).right },
          label: { left: box(label).left, right: box(label).right },
          time: { left: box(time).left, right: box(time).right },
          gap: Number.parseFloat(getComputedStyle(li).columnGap),
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
        };
      });

  test('1280px: the time follows the text and nothing is cut', async ({ page }) => {
    await serve(page, foreignRows());
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/overview');
    const m = await measureRow(page);
    expect(m.cut).toBe(false);
    expect(m.labelCut).toBe(false);
    expect(m.label.left - m.textEnd).toBeLessThanOrEqual(m.gap + 1);
    expect(m.time.left - m.label.right).toBeLessThanOrEqual(m.gap + 1);
    expect(m.linkTitle).toBe(`${m.fullLine} \u00b7 ${LONG_LABEL}`);
    const own = await card(page)
      .locator('li')
      .nth(0)
      .evaluate((li) => {
        const link = li.querySelector('.bs-home__decision') as HTMLElement;
        const time = li.lastElementChild as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(link);
        return time.getBoundingClientRect().left - range.getBoundingClientRect().right;
      });
    expect(own).toBeLessThanOrEqual(m.gap + 1);
  });

  for (const [label, viewport] of [
    ['375px', PHONE],
    ['320px', { width: 320, height: 700 }],
  ] as const) {
    test(`${label}: a long project label gives way to the task name`, async ({ page }) => {
      await serve(page, foreignRows());
      await page.setViewportSize(viewport);
      await page.goto('/overview');
      const m = await measureRow(page);
      expect(m.fullLine).toContain('Builder started on Settings');
      // The visible line keeps "<Role> started on <first word>" uncut.
      if (m.cut) expect(m.linkWidth).toBeGreaterThanOrEqual(m.prefix + m.ellipsis);
      expect(m.labelTitle).toBe(LONG_LABEL);
      expect(m.linkTitle).toBe(`${m.fullLine} \u00b7 ${LONG_LABEL}`);
      expect(m.linkHeight).toBeGreaterThanOrEqual(44);
      expect(m.link.right).toBeLessThanOrEqual(m.label.left + 0.5);
      expect(m.label.right).toBeLessThanOrEqual(m.time.left + 0.5);
      expect(m.time.right).toBeLessThanOrEqual(viewport.width);
      expect(m.timeWrap).toBe('nowrap');
      expect(m.scrollW).toBeLessThanOrEqual(m.clientW);
    });
  }

  test('375px: Just finished is rendered and untouched by the decision row rule', async ({
    page,
  }) => {
    await page.route('**/api/overview*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.recentDispatches = foreignRows();
      body.closedEpics = [
        {
          epicId: 'epic-just-done',
          closedBy: 'operator',
          machineVerdict: null,
          machineReason: null,
          overrideRationale: null,
          blockers: [],
          closedAt: minutesAgo(2),
        },
        ...body.closedEpics,
      ];
      await route.fulfill({ response, json: body });
    });
    await page.setViewportSize(PHONE);
    await page.goto('/overview');
    const line = page.locator('.bs-home__finished .bs-home__line').first();
    await expect(line).toBeVisible();
    const style = await line.evaluate((el) => ({
      align: getComputedStyle(el).alignItems,
      height: el.getBoundingClientRect().height,
    }));
    expect(style.align).toBe('baseline');
    // The decision rows are 44px tall tap rows; this one keeps its text height.
    expect(style.height).toBeLessThan(44);
  });
});
