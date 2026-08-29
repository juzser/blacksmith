import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Roadmap', () => {
  test('renders milestones with progress and the mini-timeline (operator directive 4)', async ({
    page,
  }) => {
    await page.goto('/roadmap');
    await expect(page.locator('h1')).toHaveText('Roadmap');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    // Round 6 ("display theo dạng VueFlow"): the milestone name now appears
    // twice — once in its flow node, once in the sr-only order table — so this
    // is scoped to the node rather than left as a bare getByText (which would
    // trip Playwright's strict mode).
    await expect(
      page.locator('.roadmap-node__title', { hasText: 'Phase 6b — Remaining pages' }),
    ).toBeVisible();
    // Operator directive 4 (Phase 6b round 3): "Recently done"/"Next up" ->
    // "Recent"/"Next" (re-laid-out mini-timeline column labels).
    await expect(page.getByText('Recent', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Next', { exact: true }).first()).toBeVisible();
  });

  test('renders as a VueFlow diagram with viewport controls and an sr-only order table', async ({
    page,
  }) => {
    await page.goto('/roadmap');
    await expect(page.locator('.roadmap-node').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fit view' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await expect(page.locator('table.sr-only')).toBeAttached();
  });

  test('marks the in-progress milestone as the live node (operator directive, round 8)', async ({
    page,
  }) => {
    // "có animation ở node đang running" — the class is what is assertable
    // here; the pulse itself is a CSS keyframe, and asserting a computed
    // animation frame would be testing the browser, not the app.
    //
    // The other half of round 8 ("line nối giữa các node thẳng") is NOT
    // asserted here on purpose: global-setup seeds phase-6a under
    // black-smith and phase-6b under demo-hub, i.e. one milestone per lane,
    // and roadmapFlowEdges() only chains WITHIN a lane — so this fixture
    // renders zero edges. Straight-edge behaviour is covered where it can
    // actually be exercised, in ui/test/roadmapFlow.test.ts.
    await page.goto('/roadmap');
    await expect(page.locator('.roadmap-node--live').first()).toBeVisible();
  });

  test('search filters the milestone list', async ({ page }) => {
    await page.goto('/roadmap');
    await page
      .getByLabel('Search milestone name', { exact: true })
      .fill('no such milestone exists');
    await expect(page.getByText('No milestones match these filters.')).toBeVisible();
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/roadmap');
        await expect(page.locator('h1')).toHaveText('Roadmap');
        await settleForShot(
          page,
          page.locator('.roadmap-node__title', { hasText: 'Phase 6b — Remaining pages' }),
        );
        await shoot(page, `roadmap-${vpName}-${theme}`);
      });
    }
  }
});
