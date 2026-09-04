import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Overview', () => {
  test('/ redirects to the Projects hub', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.locator('h1')).toHaveText('Projects');
  });

  test('global mode renders live agents, milestone progress, per-project breakdown, and a11y basics', async ({
    page,
  }) => {
    await page.goto('/overview');
    await expect(page.locator('h1')).toHaveText('Overview (all projects)');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.getByText('Active agents')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
  });

  test('shows a liveness indicator that reports the age of the last successful load', async ({
    page,
  }) => {
    // Round 7 ("a kind of real-time update; mind the timestamps"): the
    // page has polled every 5s since 6a, but nothing on screen said so. The
    // label starts at "Connecting…" and must resolve to a real state once the
    // first fetch lands — that transition IS the feature. The indicator itself
    // has since moved into the app shell and reads /api/pulse, so this is the
    // shell's; ui/e2e/shell.spec.ts covers it on the nine pages that are not
    // Overview. It stays asserted here because Overview is where it was born.
    await page.goto('/overview');
    await expect(page.locator('.live-status__label')).toHaveText(/^Live · updated /);
    await expect(page.getByRole('button', { name: 'Refresh now' })).toBeVisible();
  });

  test('per-project mode scopes the page title and data to one project', async ({ page }) => {
    await page.goto('/p/demo-hub/overview');
    await expect(page.locator('h1')).toHaveText('demo-hub · Overview');
  });

  // D-234. An epic-level agent — planner, spec-reviewer, scribe, epic-close
  // judge — is dispatched for the epic and holds no task. It read as "no task
  // assigned" while it was working, and scoping the page to its own project
  // dropped it entirely. Both halves are asserted here because e2e is the only
  // layer in this repo that runs an SFC template at all.
  test('an epic-level agent names its epic, in its own project', async ({ page }) => {
    await page.goto('/p/demo-hub/overview');
    // Rendered twice on this page by design — once in Now running, once in the
    // Live agents groups below — so the assertion is on presence, not a count.
    const tasks = page.locator('.live-agent-entry__task');
    await expect(tasks.filter({ hasText: 'epic: epic-10' }).first()).toBeVisible();
    await expect(tasks.filter({ hasText: 'no task assigned' })).toHaveCount(0);
  });

  test('the sidebar brand mark is the project logo, decoded and not a broken image', async ({
    page,
  }) => {
    await page.goto('/overview');
    const mark = page.locator('.ds-side__mark img');
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute('alt', 'Blacksmith');

    // toBeVisible() passes on a broken <img> too — the element is there, the
    // box has size, and nothing errors. naturalWidth is the only check that
    // proves the bytes reached the browser and decoded, which is the failure
    // this test exists for: a wrong asset path ships a silent empty corner.
    const naturalWidth = await mark.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);
  });

  // "Pending your review" counts two things from /api/overview and one from
  // /api/lessons, and those two calls fail independently. Before D-225 the
  // supplementary call's catch wrote 0 into the lesson count, so a failed
  // fetch and an empty review queue rendered the same all-clear -- the one
  // card whose whole job is to say whether the operator is needed.
  test('never reports an empty review queue when the lessons API is what failed', async ({
    page,
  }) => {
    // The fixture carries real waivers and escalations, and any non-zero count
    // hides the all-clear on its own -- which would leave this test asserting
    // nothing. Zero just those two fields on the way through, so the lesson
    // count is the only thing standing between the operator and "Nothing
    // pending.", which is exactly the state D-225 got wrong.
    await page.route('**/api/overview*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.alerts = { ...body.alerts, pendingWaivers: 0, escalations: 0 };
      await route.fulfill({ response, json: body });
    });
    await page.route('**/api/lessons*', (route) => route.abort('failed'));
    await page.goto('/overview');
    await expect(page.getByText('Pending your review')).toBeVisible();

    await expect(page.getByText('Nothing pending.')).toHaveCount(0);
    await expect(page.getByText('lesson candidates unavailable')).toBeVisible();
  });

  // This page polls every 5s and deliberately does NOT raise `loading` when it
  // does -- the point of a background refresh is that the page stays put. But
  // `load()` cleared `error` on attempt, so each of those unattended polls
  // took the danger banner off the screen for the length of its own flight
  // and put nothing in its place: a dashboard whose server is down spends
  // most of every 5s interval looking like a healthy one. The rule is already
  // written down on this page -- LiveStatus's `lastUpdatedAt` prop doc says
  // "the last SUCCESSFUL load, not the last attempt", and `load()` honours it
  // two lines below -- it just was never applied to the error beside it.
  // D-226 fixed Timeline and Kanban, whose polls are 15s; the two 5s pages it
  // never reached are this one and Sessions (D-240).
  test('a failing refresh never takes the error banner off the screen', async ({ page }) => {
    let served = 0;
    await page.route('**/api/overview*', async (route) => {
      served += 1;
      if (served === 1) {
        await route.abort('failed');
        return;
      }
      // Hangs rather than fails: the window this is about is the one where
      // the request is still in flight and its verdict is not yet in.
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      await route.abort('failed').catch(() => {});
    });
    await page.goto('/overview');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    // Resolves the moment the refetch is issued -- i.e. the moment `load()`
    // has done whatever it does to `error` -- so the assertion below lands
    // inside the in-flight window rather than racing it.
    const refetch = page.waitForRequest('**/api/overview*');
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await refetch;

    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  // D-241. `isFirstRun` was `liveAgentCount === 0 && epicsInFlight.length === 0`
  // -- both of which go true the moment a run *finishes*, not only before the
  // first one ever starts. design-spec.md:190 reserves the coffee illustration
  // for "zero events ever logged", and the same paragraph carries a MUST: the
  // stat row, main body and rail are three independent remote-data zones,
  // "none is implied by a sibling resolving". Chaining the whole TwoColumn to
  // that `v-if` broke both: between runs the page threw away Live agents,
  // Recent dispatch decisions, Milestone progress and the entire rail --
  // including Pending your review, which is exactly what an operator opens
  // the page for once a wave lands.
  test('a finished run keeps the dashboard: idle is not the same as never-run', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.route('**/api/overview*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      // Every agent closed out and every epic terminal -- the ordinary steady
      // state between two runs. The history below it is untouched.
      body.liveAgentCount = 0;
      body.liveAgentEntries = [];
      body.epicsInFlight = [];
      await route.fulfill({ response, json: body });
    });
    await page.goto('/overview');
    await expect(page.locator('h1')).toHaveText('Overview (all projects)');

    await expect(page.getByText('Recent dispatch decisions')).toBeVisible();
    await expect(page.getByText('Pending your review')).toBeVisible();
    await expect(page.getByText('Milestone progress')).toBeVisible();
    await expect(page.getByText('Nothing running yet.')).toHaveCount(0);

    await settleForShot(page, page.getByText('Recent dispatch decisions'));
    await shoot(page, 'overview-between-runs');
  });

  // D-241, second half of the same `v-else-if`. On a genuine first run the
  // chain hid the rail -- and with it the Factory commands card, the only
  // place on the page that names `/bs plan <goal>`. The empty state said
  // "Start the factory with a plan" while hiding the instruction for doing so.
  test('the first-run empty state tells the operator how to start the factory', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.route('**/api/overview*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const empty = {
        liveAgentCount: 0,
        liveAgentEntries: [],
        epicsInFlight: [],
        closedEpics: [],
        runningSessions: [],
        recentDispatches: [],
        milestoneProgress: [],
        tokensByEpic: [],
        alerts: { escalations: 0, pendingWaivers: 0 },
      };
      await route.fulfill({ response, json: { ...body, ...empty } });
    });
    await page.goto('/overview');
    await expect(page.getByText('Nothing running yet.')).toBeVisible();
    await expect(page.getByText('/bs plan <goal>')).toBeVisible();

    await settleForShot(page, page.getByText('Nothing running yet.'));
    await shoot(page, 'overview-first-run');
  });

  test('theme toggle switches to dark and persists the class on <html>', async ({ page }) => {
    await page.goto('/overview');
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/overview');
        await expect(page.locator('h1')).toHaveText('Overview (all projects)');
        await settleForShot(page, page.getByText('Active agents'));
        await shoot(page, `overview-${vpName}-${theme}`);
      });
    }
  }
});
