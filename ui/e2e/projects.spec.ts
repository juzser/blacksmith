import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Projects (hub)', () => {
  test('renders one card per project with a11y basics', async ({ page }) => {
    await page.goto('/projects');
    await expect(page.locator('h1')).toHaveText('Projects');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(
      page.getByRole('link', { name: /black-smith project, opens overview/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: /demo-hub project, opens overview/ }),
    ).toBeVisible();
  });

  test('shows a project the roadmap declares before its first task exists', async ({ page }) => {
    // The fixture roadmap's third phase declares `envkit` and nothing else --
    // no epics, no tasks, no events. This hub and the topbar switcher both
    // render overview().projects, which was derived from the tasks table
    // alone: a project in that state existed as a scope, answered when asked
    // for by URL, and could be reached from neither.
    await page.goto('/projects');
    await expect(page.getByRole('link', { name: /envkit project, opens overview/ })).toBeVisible();
    // ...and it is selectable from the topbar, which the hub route itself
    // does not carry (App.vue's SCOPABLE_ROUTES) -- so ask a page that does.
    await page.goto('/roadmap');
    await expect(
      page.getByLabel('Project', { exact: true }).locator('option', { hasText: 'envkit' }),
    ).toHaveCount(1);
  });

  test('counts epics in flight, rather than epic in flights', async ({ page }) => {
    // pluralize()'s default plural appends an "s" to the whole phrase, so
    // every card whose count was not exactly 1 read "N epic in flights".
    await page.goto('/projects');
    await expect(page.getByText('2 epics in flight')).toBeVisible();
    await expect(page.getByText('0 epics in flight')).toBeVisible();
    await expect(page.getByText('epic in flights')).toHaveCount(0);
  });

  // Running-only liveness: the agent stat is the WORKING count (inside the
  // 4h dispatch window), and a card whose live rows include a stalled one
  // says so in the label rather than folding it into the number. Both halves
  // still add up to the project's liveAgentCount, so nothing is dropped.
  test('counts working agents, and names the stalled ones beside them', async ({ page }) => {
    const counts: Record<string, { live: number; working: number }> = {
      'black-smith': { live: 3, working: 2 },
      'demo-hub': { live: 1, working: 1 },
      envkit: { live: 0, working: 0 },
    };
    await page.route('**/api/overview*', async (route) => {
      const body = await (await route.fetch()).json();
      body.projects = body.projects.map((p: { project: string }) => ({
        ...p,
        liveAgentCount: counts[p.project]?.live ?? 0,
        workingAgentCount: counts[p.project]?.working ?? 0,
      }));
      await route.fulfill({ json: body });
    });
    await page.goto('/projects');
    const card = (project: string) =>
      page.getByRole('link', { name: new RegExp(`${project} project, opens overview`) });
    await expect(card('black-smith').locator('.project-card__stat-value').first()).toHaveText('2');
    await expect(card('black-smith').getByText('2 working agents (1 stalled)')).toBeVisible();
    await expect(card('demo-hub').getByText('1 working agent', { exact: true })).toBeVisible();
    await expect(card('envkit').getByText('0 working agents', { exact: true })).toBeVisible();
    // The stalled clause only appears where there is something to state.
    await expect(page.getByText('stalled')).toHaveCount(1);
    await expect(page.getByText('live agent')).toHaveCount(0);
  });

  test('clicking a project card navigates to its scoped Overview', async ({ page }) => {
    await page.goto('/projects');
    await page.getByRole('link', { name: /demo-hub project, opens overview/ }).click();
    await expect(page).toHaveURL(/\/p\/demo-hub\/overview$/);
    await expect(page.locator('h1')).toHaveText('demo-hub · Overview');
  });

  // This hub is the app's default route -- `/` redirects here, so it is the
  // first thing an operator sees. Its error Banner sat outside the render
  // chain rather than at the head of it, so a failed fetch rendered the
  // banner and, directly beneath it, "No projects yet. Every event ever
  // logged is untagged" -- a specific claim about the contents of a database
  // the page had just failed to reach.
  test('a failed overview fetch never renders as an empty project hub', async ({ page }) => {
    await page.route('**/api/overview*', (route) => route.abort('failed'));
    await page.goto('/projects');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    await expect(page.getByText('No projects yet')).toHaveCount(0);
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/projects');
        await expect(page.locator('h1')).toHaveText('Projects');
        await settleForShot(
          page,
          page.getByRole('link', { name: /demo-hub project, opens overview/ }),
        );
        await shoot(page, `projects-${vpName}-${theme}`);
      });
    }
  }
});
