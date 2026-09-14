import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

// Payload rows for the running-only tests below, dated as offsets from the
// browser's pinned clock (harness.ts) so every label they render is exact.
// The lines that matter are liveness.ts's: a session is active for 15
// minutes after its last event, an agent is working for 4h after dispatch.
const minutesAgo = (minutes: number): string =>
  new Date(Date.parse(FIXTURE_NOW_ISO) - minutes * 60_000).toISOString();
const session = (sessionId: string, lastEventAt: string, working: number, live: number) => ({
  sessionId,
  startedAt: minutesAgo(6 * 60),
  lastEventAt,
  eventCount: 3,
  liveAgentCount: live,
  workingAgentCount: working,
  lastEventType: 'task-created',
  projects: ['black-smith'],
});
const agent = (id: string, sessionId: string, dispatchedAt: string) => ({
  id,
  sessionId,
  agentRole: 'coder',
  provider: 'anthropic',
  modelTier: 'sonnet',
  taskId: `task-${id}`,
  epicId: 'epic-1',
  dispatchedAt,
});

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
      body.workingAgentCount = 0;
      body.stalledAgentCount = 0;
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
    // No agent is not the same as no session: the fixture's runs logged an
    // event inside the last 15 minutes, so they are still running, with
    // nobody working -- and the Live agents card says exactly that.
    await expect(page.getByText('No agents working right now.')).toBeVisible();
    await expect(page.getByText('No sessions running.')).toHaveCount(0);
    await expect(page.locator('.running-session').first()).toBeVisible();

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
        workingAgentCount: 0,
        stalledAgentCount: 0,
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

  // Running-only liveness (operator directive). `runningSessions` is every
  // projected run and `liveAgentEntries` every `agents` row nobody closed
  // out, so between waves the payload carries ghosts: a run whose last event
  // is an hour old, an agent dispatched yesterday. The page draws neither,
  // and says so in numbers wherever they used to be -- the count is the
  // claim, so each one is asserted verbatim rather than by presence.
  test('draws only running sessions and working agents, and counts the rest', async ({ page }) => {
    await page.route('**/api/overview*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.runningSessions = [
        // Active on its own events: 3 minutes is inside the 15-minute line.
        session('sess-active', minutesAgo(3), 1, 2),
        // Quiet for 40 minutes, but its agent was dispatched 20 minutes ago:
        // running on the agent half of the rule, which is the half that keeps
        // a long task's session on the page between its events.
        session('sess-quiet', minutesAgo(40), 1, 1),
        // Quiet for 40 minutes and its only live row is 5h old: idle.
        session('sess-idle', minutesAgo(40), 0, 1),
        // Nothing for 5 hours and nothing live: idle.
        session('sess-done', minutesAgo(5 * 60), 0, 0),
      ];
      body.liveAgentEntries = [
        agent('a-working', 'sess-active', minutesAgo(30)),
        agent('a-stalled', 'sess-active', minutesAgo(5 * 60)),
        agent('q-working', 'sess-quiet', minutesAgo(20)),
        agent('i-stalled', 'sess-idle', minutesAgo(5 * 60)),
      ];
      body.liveAgentCount = 4;
      body.workingAgentCount = 2;
      body.stalledAgentCount = 2;
      body.workingAgentCountDelta5m = 0;
      await route.fulfill({ response, json: body });
    });
    await page.goto('/overview');

    // The stat counts the working two and names the other two beside it.
    const stat = page.locator('.ds-stat', { hasText: 'Active agents' });
    await expect(stat.locator('.ds-stat__value')).toHaveText('2');
    await expect(stat).toContainText('vs 5 min ago · 2 stalled not counted');

    // Now running: two of the four runs, the summary and the footer both
    // stating the two it left out, and the one row with a stalled agent
    // stating that too.
    const nowRunning = page.locator('.ds-card', {
      has: page.locator('.ds-card__title', { hasText: 'Now running' }),
    });
    await expect(nowRunning.locator('.live-agents-summary')).toHaveText(
      '2 sessions running · 2 idle sessions not shown · last event 3m ago',
    );
    await expect(nowRunning.locator('.running-session__id')).toHaveText([
      'sess-active',
      'sess-quiet',
    ]);
    await expect(nowRunning.locator('.running-session__note')).toHaveText([
      '1 stalled agent not shown',
    ]);
    await expect(nowRunning.locator('.now-running-more')).toHaveText(['2 idle sessions not shown']);
    await expect(page.getByText('sess-idle')).toHaveCount(0);
    await expect(page.getByText('sess-done')).toHaveCount(0);
    // A row listed under "Now running" never calls itself idle: the quiet
    // session is on the page because an agent vouches for it, and its lozenge
    // and its state line say that, not "idle", which is the word the footer
    // uses for the runs that are NOT listed.
    const quiet = nowRunning.locator('.running-session', { hasText: 'sess-quiet' });
    await expect(quiet.locator('.ds-loz').first()).toHaveText('working');
    await expect(quiet.locator('.running-session__state')).toHaveText(
      'no event for over 15 minutes, 1 agent working',
    );
    const active = nowRunning.locator('.running-session', { hasText: 'sess-active' });
    await expect(active.locator('.ds-loz').first()).toHaveText('active');

    // Live agents: the same two, grouped, with the same two named as hidden.
    const liveAgents = page.locator('.ds-card', {
      has: page.locator('.ds-card__title', { hasText: 'Live agents' }),
    });
    await expect(liveAgents.locator('.live-agents-summary')).toHaveText(
      '2 agents working · 2 stalled agents not shown · longest running 30m',
    );
    await expect(liveAgents.locator('.live-agent-group')).toHaveCount(1);
    await expect(liveAgents.locator('.live-agent-group-row')).toContainText('×2');
    // A stalled agent's task is drawn nowhere on the page, not even in a
    // group's detail lines.
    const tasks = page.locator('.live-agent-entry__task');
    await expect(tasks.filter({ hasText: 'task-a-working' }).first()).toBeVisible();
    await expect(tasks.filter({ hasText: 'task-q-working' }).first()).toBeVisible();
    await expect(tasks.filter({ hasText: 'task-a-stalled' })).toHaveCount(0);
    await expect(tasks.filter({ hasText: 'task-i-stalled' })).toHaveCount(0);
  });

  // The other end of the same rule. Every run quiet for an hour and every
  // live row past the 4h line is the ordinary state of a factory nobody has
  // driven since yesterday -- not the never-ran state (D-241), and not
  // nothing: each card keeps its place and states what it is not drawing.
  // An unreadable timestamp is named as such, because calling it stalled
  // would be a second unsupported claim, in the other direction.
  test('an idle factory keeps both cards and says what they hide', async ({ page }) => {
    await page.route('**/api/overview*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.runningSessions = [
        session('sess-idle-1', minutesAgo(60), 0, 2),
        session('sess-idle-2', minutesAgo(60), 0, 0),
      ];
      body.liveAgentEntries = [
        agent('one-stalled', 'sess-idle-1', minutesAgo(5 * 60)),
        agent('one-unreadable', 'sess-idle-1', 'not a timestamp'),
      ];
      body.liveAgentCount = 2;
      body.workingAgentCount = 0;
      body.stalledAgentCount = 2;
      body.workingAgentCountDelta5m = 0;
      await route.fulfill({ response, json: body });
    });
    await page.goto('/overview');

    const stat = page.locator('.ds-stat', { hasText: 'Active agents' });
    await expect(stat.locator('.ds-stat__value')).toHaveText('0');
    await expect(stat).toContainText('vs 5 min ago · 2 stalled not counted');

    await expect(page.getByText('No sessions running.')).toBeVisible();
    await expect(page.getByText('No agents working right now.')).toBeVisible();
    await expect(page.locator('.running-session')).toHaveCount(0);
    await expect(page.locator('.live-agent-entry')).toHaveCount(0);
    // Document order: the Now running card's line, then the Live agents card's.
    await expect(page.locator('.now-running-more')).toHaveText([
      '2 idle sessions not shown',
      '1 stalled agent not shown, 1 with an unreadable timestamp',
    ]);

    // Idle, not first-run: the dashboard around the two cards stays.
    await expect(page.getByText('Nothing running yet.')).toHaveCount(0);
    await expect(page.getByText('Recent dispatch decisions')).toBeVisible();
    await expect(page.getByText('Pending your review')).toBeVisible();
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
