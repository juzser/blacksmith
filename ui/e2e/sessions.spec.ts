import type { RunningSession, SessionAgent, SessionAgentsResult } from '../src/lib/api.js';
import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

// DS8 PR3 round 2 (item 6): the Sessions page rebuilt on the kit — a
// history list (kit SessionRow) with a finished-runs toggle, and one kit
// AgentBlock per role for whichever run is selected. The VueFlow canvas
// this file used to describe is gone; every claim here is against that
// markup, stubbed deterministically through `page.route` the way
// lessons.spec.ts stubs `/api/lessons` rather than against the real fixture
// db, so each state (every badge, every token kind, the title fallback) is
// reachable without hunting for a fixture run that happens to be in it.
const minutesAgo = (minutes: number): string =>
  new Date(Date.parse(FIXTURE_NOW_ISO) - minutes * 60_000).toISOString();

function session(partial: Partial<RunningSession> & { sessionId: string }): RunningSession {
  return {
    startedAt: minutesAgo(6 * 60),
    lastEventAt: minutesAgo(3),
    eventCount: 5,
    liveAgentCount: 0,
    workingAgentCount: 0,
    lastEventType: 'task-created',
    projects: ['black-smith'],
    title: null,
    ...partial,
  };
}

function agent(partial: Partial<SessionAgent> & { id: string }): SessionAgent {
  return {
    agentRole: 'coder',
    provider: 'anthropic',
    modelTier: 'sonnet',
    taskId: `task-${partial.id}`,
    taskTitle: null,
    epicId: 'epic-1',
    round: 1,
    dispatchedAt: minutesAgo(30),
    terminalAt: null,
    terminalType: null,
    status: 'live',
    tokens: { state: 'pending' },
    lastEventType: 'task-created',
    lastEventAt: minutesAgo(10),
    ...partial,
  };
}

// run-active: one of each of the 5 badge states, and 3 of the 4 token kinds
// (measured, unmeasured, none) plus a pending one — enough to prove every
// label and every token rendering in one AgentBlock, with liveAgentCount
// matching the 2 `live` rows below (working + no-result).
const AGENTS_ACTIVE: SessionAgentsResult = {
  sessionId: 'run-active',
  roles: [
    {
      agentRole: 'coder',
      agents: [
        agent({
          id: 'a-working',
          status: 'live',
          dispatchedAt: minutesAgo(30),
          tokens: { state: 'pending' },
        }),
        agent({
          id: 'a-no-result',
          status: 'live',
          dispatchedAt: minutesAgo(5 * 60),
          tokens: { state: 'unmeasured' },
        }),
        agent({
          id: 'a-done',
          status: 'done',
          dispatchedAt: minutesAgo(90),
          tokens: { state: 'measured', input: 1234, output: 567, total: 1801 },
        }),
        agent({
          id: 'a-failed',
          status: 'error',
          dispatchedAt: minutesAgo(80),
          tokens: { state: 'none' },
        }),
        agent({
          id: 'a-stopped',
          status: 'superseded',
          dispatchedAt: minutesAgo(70),
          tokens: { state: 'none' },
        }),
      ],
    },
  ],
};

const AGENTS_UNTITLED: SessionAgentsResult = {
  sessionId: 'run-untitled',
  roles: [
    {
      agentRole: 'reviewer',
      agents: [
        agent({ id: 'u-done', agentRole: 'reviewer', status: 'done', tokens: { state: 'none' } }),
      ],
    },
  ],
};

const SESSIONS: RunningSession[] = [
  session({
    sessionId: 'run-active',
    liveAgentCount: 2,
    workingAgentCount: 1,
    title: 'Fix the login retry loop',
  }),
  // No title at all: the row falls back to the bare session id.
  session({
    sessionId: 'run-untitled',
    startedAt: minutesAgo(10 * 60),
    lastEventAt: minutesAgo(9 * 60),
    liveAgentCount: 0,
    title: null,
  }),
  session({
    sessionId: 'run-second-finished',
    startedAt: minutesAgo(20 * 60),
    lastEventAt: minutesAgo(19 * 60),
    liveAgentCount: 0,
    title: 'Second finished run',
  }),
];

async function serveSessions(page: import('@playwright/test').Page) {
  await page.route('**/api/sessions*', (route) => route.fulfill({ json: SESSIONS }));
  await page.route('**/api/sessions/run-active/agents*', (route) =>
    route.fulfill({ json: AGENTS_ACTIVE }),
  );
  await page.route('**/api/sessions/run-untitled/agents*', (route) =>
    route.fulfill({ json: AGENTS_UNTITLED }),
  );
}

// PR1 (ds8 active-sessions spec §3 "Sessions"): the unscoped running list
// groups by project, newest group first, newest row first within a group.
const GROUPED_SESSIONS: RunningSession[] = [
  session({
    sessionId: 'grp-newest',
    lastEventAt: minutesAgo(1),
    liveAgentCount: 1,
    workingAgentCount: 1,
    projects: ['proj-a'],
    title: 'Newest in proj-a',
  }),
  session({
    sessionId: 'grp-middle',
    lastEventAt: minutesAgo(2),
    liveAgentCount: 1,
    workingAgentCount: 1,
    projects: ['proj-b'],
    title: 'Only one in proj-b',
  }),
  session({
    sessionId: 'grp-older',
    lastEventAt: minutesAgo(3),
    liveAgentCount: 1,
    workingAgentCount: 1,
    projects: ['proj-a'],
    title: 'Older in proj-a',
  }),
];

// A session whose agents are all `live` but dispatched well outside the 4h
// staleness window: liveAgentCount > 0, workingAgentCount 0 -- the ghost
// case the running/finished split must now treat as quiet.
const STALE_SESSIONS: RunningSession[] = [
  session({
    sessionId: 'stale-only',
    liveAgentCount: 2,
    workingAgentCount: 0,
    projects: ['proj-a'],
    title: 'Stale ghost run',
  }),
];

test.describe('Sessions', () => {
  test('groups the unscoped running list by project, newest group and row first', async ({
    page,
  }) => {
    await page.route('**/api/sessions*', (route) => route.fulfill({ json: GROUPED_SESSIONS }));
    await page.goto('/sessions');
    await expect(page.getByRole('heading', { level: 3 })).toHaveText(['proj-a', 'proj-b']);
    const titles = await page.locator('.bs-sessionrow__title').allTextContents();
    expect(titles).toEqual(['Newest in proj-a', 'Older in proj-a', 'Only one in proj-b']);
  });

  test('a session with live-but-stale agents lands in finished, not running', async ({ page }) => {
    await page.route('**/api/sessions*', (route) => route.fulfill({ json: STALE_SESSIONS }));
    await page.goto('/sessions');
    await expect(page.getByText('Nothing is active right now.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show 1 finished run' })).toBeVisible();
    await page.getByRole('button', { name: 'Show 1 finished run' }).click();
    await expect(page.getByText('Stale ghost run')).toBeVisible();
  });

  test('lists running sessions and offers a count of finished ones', async ({ page }) => {
    await serveSessions(page);
    await page.goto('/sessions');
    await expect(page.locator('h1')).toHaveText('Sessions');
    // Only the one running row renders up front; the finished ones are
    // behind the toggle, which states exactly how many. Without the
    // running/finished split every row would render at once and this count
    // would not exist.
    await expect(page.getByRole('button', { name: 'Show 2 finished runs' })).toBeVisible();
    await expect(page.getByText('run-untitled')).toHaveCount(0);
    await expect(page.getByText('Second finished run')).toHaveCount(0);

    await page.getByRole('button', { name: 'Show 2 finished runs' }).click();
    await expect(page.getByRole('button', { name: 'Hide finished runs' })).toBeVisible();
    await expect(page.getByText('run-untitled')).toBeVisible();
    await expect(page.getByText('Second finished run')).toBeVisible();
  });

  // The title column (SessionRow.vue): a session with a title shows it; one
  // with none falls back to its bare sessionId. Both rows exist in the same
  // fixture so this fails the instant either one stops being distinguished.
  test('a run with a title shows it; a run without one falls back to its session id', async ({
    page,
  }) => {
    await serveSessions(page);
    await page.goto('/sessions');
    await expect(page.getByText('Fix the login retry loop')).toBeVisible();

    await page.getByRole('button', { name: 'Show 2 finished runs' }).click();
    // The untitled row's own title line reads the raw id -- not blank, not
    // "Untitled", which is what a missing fallback would render instead.
    await expect(
      page.locator('.bs-sessionrow__title').getByText('run-untitled', { exact: true }),
    ).toBeVisible();
  });

  // Selecting a run shows its agents and writes `?session=<id>` onto the URL
  // -- the page's own deep-link marker (sessionsSelection.ts), round-tripped.
  test('selecting a run loads its agents and writes the id onto the URL', async ({ page }) => {
    await serveSessions(page);
    await page.goto('/sessions');
    await page.getByText('Fix the login retry loop').click();
    await expect(page.locator('.bs-agentblock')).toBeVisible();
    await expect(page).toHaveURL(/[?&]session=run-active\b/);
  });

  // Deep link in: `/sessions?session=<id>` selects that run on load (even a
  // finished one, which also has to flip the toggle open for its row to be
  // there at all) and its AgentBlocks render without a click.
  test('a deep link selects its run and shows its agents on load', async ({ page }) => {
    await serveSessions(page);
    await page.goto('/sessions?session=run-untitled');
    await expect(page.locator('.bs-agentblock')).toBeVisible();
    await expect(page.locator('.bs-agentblock__role')).toHaveText('Code reviewer');
    // The finished row the id points at is visible, so the toggle already
    // reads "open" -- proof the deep link reached into the finished half of
    // the list, not only the running one.
    await expect(page.getByRole('button', { name: 'Hide finished runs' })).toBeVisible();
  });

  // The 5 badge labels (ds-spec.md §4.6 pattern 13, operator Q2), each from
  // its own agent row. A badge mapping that collapsed any two of these to
  // the same label, or dropped the "No result after 4h" anomaly case,
  // leaves one of these five `getByText` misses its row.
  test('shows all 5 agent status badges', async ({ page }) => {
    await serveSessions(page);
    await page.goto('/sessions?session=run-active');
    const block = page.locator('.bs-agentblock');
    await expect(block).toBeVisible();
    for (const label of ['Working', 'No result after 4h', 'Done', 'Failed', 'Stopped']) {
      await expect(block.getByText(label, { exact: true }), label).toBeVisible();
    }
  });

  // Token states (lib/agentStatus.ts's tokenDisplay): measured renders both
  // figures through CompactNumber, unmeasured says so in words and never as
  // "0", pending says "Running" and none renders no token text at all.
  test('renders every token state, and never a bare 0 for an unmeasured run', async ({ page }) => {
    await serveSessions(page);
    await page.goto('/sessions?session=run-active');
    const rows = page.locator('.bs-agentblock__row');
    const workingTokens = rows.filter({ hasText: 'Working' }).locator('.bs-agentblock__tokens');
    const noResultTokens = rows
      .filter({ hasText: 'No result after 4h' })
      .locator('.bs-agentblock__tokens');
    const doneTokens = rows.filter({ hasText: 'Done' }).locator('.bs-agentblock__tokens');
    const failedTokens = rows.filter({ hasText: 'Failed' }).locator('.bs-agentblock__tokens');

    await expect(workingTokens).toHaveText('Running');
    await expect(noResultTokens).toHaveText('not measured');
    await expect(noResultTokens).not.toHaveText(/^0$/);
    await expect(doneTokens).toContainText('1.2K tokens in');
    await expect(doneTokens).toContainText('567 tokens out');
    await expect(failedTokens).toHaveText('');
  });

  // Fix round 2 item 2: the selected background (--bs-surface-selected) is
  // an aria-current cue, not a focus cue -- the :focus-visible ring
  // (bs-sessionrow--clickable:focus-visible) must stay off a mouse click and
  // only appear for keyboard/programmatic focus (the deep-link case above).
  test('a mouse click selects the row without showing the focus ring', async ({ page }) => {
    await serveSessions(page);
    await page.goto('/sessions');
    await page.getByText('Fix the login retry loop').click();
    const row = page.locator('.bs-sessionrow--selected');
    await expect(row).toBeVisible();
    const boxShadow = await row.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow).toBe('none');
  });

  test('a deep-linked row shows the focus ring', async ({ page }) => {
    await serveSessions(page);
    await page.goto('/sessions?session=run-active');
    const row = page.locator('.bs-sessionrow--selected');
    await expect(row).toBeVisible();
    const boxShadow = await row.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow).not.toBe('none');
  });

  // Entry points: the nav carries a Sessions item, and Home's "Running now"
  // card links into this page for the project it is showing.
  test('the Sessions nav entry is present and Home links to it', async ({ page }) => {
    await page.goto('/overview');
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Sessions' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'View blacksmith in Sessions' })).toHaveAttribute(
      'href',
      /\/sessions/,
    );
  });

  // Fix round 2 item 1: the mock drops Refresh on phone (ds-review.html:951),
  // matching every other polling page's `v-if="!isPhoneWidth"` pattern.
  test('Refresh is hidden on phone and visible on desktop', async ({ page }) => {
    await serveSessions(page);
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/sessions?session=run-active');
    await expect(page.locator('h1')).toHaveText('Sessions');
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);

    await page.setViewportSize(VIEWPORTS.desktop);
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  });

  // Fix round item 6: on phone, every agent row's badge used to land on a
  // second line for some rows and not others, depending on the token
  // text's length. A fixed column layout (title, then one meta line) means
  // the badge and its RelativeTime now always share one line, whatever the
  // token text says.
  test('every phone agent row keeps its badge on the same line as its time', async ({ page }) => {
    await serveSessions(page);
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/sessions?session=run-active');
    const rows = page.locator('.bs-agentblock__row');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const [timeBox, badgeBox] = await Promise.all([
        row.locator('time').boundingBox(),
        row.locator('.bs-tag').boundingBox(),
      ]);
      expect(timeBox).not.toBeNull();
      expect(badgeBox).not.toBeNull();
      const timeCenter = (timeBox?.y ?? 0) + (timeBox?.height ?? 0) / 2;
      const badgeCenter = (badgeBox?.y ?? 0) + (badgeBox?.height ?? 0) / 2;
      expect(Math.abs(timeCenter - badgeCenter)).toBeLessThanOrEqual(4);
    }
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await serveSessions(page);
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/sessions?session=run-active');
        await expect(page.locator('h1')).toHaveText('Sessions');
        await settleForShot(page, page.locator('.bs-agentblock').first());
        await shoot(page, `sessions-${vpName}-${theme}`);
      });
    }
  }
});
