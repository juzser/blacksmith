import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { expect, type Page, test } from './harness.js';
import { setTheme, settleForShot, shoot, shootElement, VIEWPORTS } from './helpers.js';

// Home (ds-spec.md §4.1): Overview and Projects merged into one page. The
// numbers and sentences are unit-tested in ui/test/homeView.test.ts and the
// grouping in ui/test/inbox.test.ts; this suite is the only layer that runs
// the templates, so it asserts what reaches the screen.

const minutesAgo = (minutes: number): string =>
  new Date(Date.parse(FIXTURE_NOW_ISO) - minutes * 60_000).toISOString();

// One row of each kind, across two projects plus the project-less group, so
// the grouping, the per-kind tag and the per-kind action are all on screen.
const INBOX_ROWS = [
  {
    id: 'esc-1',
    kind: 'escalation',
    title: 'Checkout flow',
    description: 'Tester found a failing refund path; the task stays blocked until you choose.',
    project: 'black-smith',
    taskId: 'epic-1/task-3-checkout',
    createdAt: minutesAgo(5),
  },
  {
    id: 'waiver-1',
    kind: 'waiver',
    title: 'Show fee',
    description: null,
    project: 'demo-hub',
    taskId: 'epic-9/task-2-show-fee',
    createdAt: minutesAgo(30),
  },
  {
    id: 'lesson-1',
    kind: 'lesson_candidate',
    title: 'Run the full suite before a gate check',
    description: null,
    project: null,
    taskId: null,
    createdAt: minutesAgo(90),
  },
];

async function serveInbox(page: Page, rows: unknown[]): Promise<void> {
  await page.route('**/api/inbox*', (route) => route.fulfill({ json: { rows } }));
}

const PHONE = { width: 375, height: 812 };

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
    await expect(
      inbox.getByText('Tester found a failing refund path', { exact: false }),
    ).toBeVisible();
    await expect(inbox.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/tasks/epic-1%2Ftask-3-checkout',
    );
    const reviews = inbox.getByRole('link', { name: 'Review' });
    await expect(reviews).toHaveCount(2);
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

    // §3.1: the single most urgent row (the escalation, first group/row)
    // gets one full-width 44px "Decide" action; every other row keeps its
    // small per-kind link ("Open"/"Review"), not a primary button.
    await expect(inbox.locator('.bs-btn--primary')).toHaveCount(1);
    const decide = inbox.getByRole('link', { name: 'Decide: Checkout flow' });
    await expect(decide).toHaveClass(/bs-btn--primary/);
    await expect(decide).toHaveClass(/bs-btn--touch/);
    await expect(decide).toHaveClass(/bs-btn--block/);
    await expect(inbox.getByRole('link', { name: 'Open' })).toHaveCount(0);

    // A folded group opens from its summary.
    await inbox.locator('summary', { hasText: 'demo-hub · 1' }).click();
    await expect(inbox.getByText('Show fee')).toBeVisible();
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

  async function serveTimeline(
    page: Page,
    entries: ReturnType<typeof syntheticEntries>,
  ): Promise<void> {
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
  for (const x of lefts) expect(Math.abs(x - lefts[0])).toBeLessThanOrEqual(1);
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
  targets: { name: string; h: number; clipped: string | null }[];
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
    const targets: { name: string; h: number; clipped: string | null }[] = [];
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
            ? v.getBoundingClientRect().top + (v.getBoundingClientRect().height - vlh) / 2
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
        targets.push({ name: (el.textContent ?? '').trim().slice(0, 30), h, clipped });
      }
    }
    const longCard = cards[cards.length - 1];
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
        firstTop: rects[0].top,
        vTop: vr.top + parseFloat(cs.paddingTop),
        lineTops: rects.map((r) => r.top),
        clipBottom: vr.bottom - parseFloat(cs.borderBottomWidth),
        lineH,
      },
    };
  });
}

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

  test('375px: tight rows, one title rhythm, 44px unclipped targets, long title clamps inline', async ({
    page,
  }) => {
    await serveLive(page, liveResponse({ sessions: [...LIVE_CARDS, LONG_CARD] }));
    await page.setViewportSize(PHONE);
    await page.goto('/overview');
    await expect(page.locator('.bs-live-card')).toHaveCount(4);
    const m = await measureLiveCards(page);
    // a. one text line per row, key top-aligned with the value
    expect(m.rows.some((r) => r.oneLine)).toBe(true);
    for (const r of m.rows) {
      if (!r.oneLine) continue;
      expect(r.rowH, `row "${r.text}" height`).toBeLessThanOrEqual(r.lineH + 2);
      expect(Math.abs(r.kTop - r.vTop), `row "${r.text}" key/value tops`).toBeLessThanOrEqual(2);
    }
    // b. linked and unlinked one-line titles share one height
    const one = m.titles.filter((t) => t.lines === 1);
    const linked = one.find((t) => t.linked);
    const unlinked = one.find((t) => !t.linked);
    expect(linked && unlinked).toBeTruthy();
    expect(Math.abs((linked?.h ?? 0) - (unlinked?.h ?? 0))).toBeLessThanOrEqual(1);
    // c + d. every target measures >= 44 and no clamped ancestor clips it
    expect(m.targets.length).toBeGreaterThanOrEqual(8);
    for (const t of m.targets) {
      expect(t.h, `target "${t.name}" height`).toBeGreaterThanOrEqual(43.5);
      expect(t.clipped, `target "${t.name}" clipped`).toBeNull();
    }
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
