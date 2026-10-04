import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { expect, type Page, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

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
    const view = page.getByRole('link', { name: 'View black-smith in Work' });
    await expect(view).toHaveAttribute('href', '/work/kanban?project=black-smith');
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
        await settleForShot(page, page.getByRole('link', { name: 'View black-smith in Work' }));
        await shoot(page, `home-${vpName}-${theme}`);
      });
    }
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
