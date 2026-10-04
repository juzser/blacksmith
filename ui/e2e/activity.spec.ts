import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

// DS6 PR3 (ds-spec.md §4.3 / ds-review.html #p-activity): Timeline and
// Errors fold into one flat, day-grouped feed. Replaces timeline.spec.ts and
// errors.spec.ts — the search box, "Decisions" lens, causal dispatch-group
// fold, and Errors' own charts/table/Dialog all retired with those pages
// (operator decisions; Errors' own class cards are a PR4 follow-up).

test.describe('Activity', () => {
  test('renders the seeded event log and a11y basics', async ({ page }) => {
    await page.goto('/activity');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.getByRole('feed', { name: 'Activity' })).toBeVisible();
    // The default feed's 50-row page is newest-first, and this fixture's
    // prompt is its very first event -- assert on something the default page
    // actually renders, not a row long since pushed off it.
    await expect(page.locator('.bs-timeline-row__title').first()).toBeVisible();
  });

  test('/timeline redirects into Activity, query kept', async ({ page }) => {
    await page.goto('/timeline?task=epic-9%2Ftask-3');
    // The browser normalizes the query string on navigation -- '/' is valid
    // unencoded inside a query component, so %2F round-trips as a literal '/'.
    await expect(page).toHaveURL(/\/activity\?task=epic-9\/task-3/);
    await expect(page.getByRole('feed', { name: 'Activity' })).toBeVisible();
  });

  // Errors kept its own chip (operator decision) rather than its own page:
  // /errors now lands on Activity pre-filtered to the Error kind.
  test('/errors redirects into Activity, pre-filtered to the Error kind', async ({ page }) => {
    await page.goto('/errors');
    await expect(page).toHaveURL(/\/activity\?kind=errors/);
    // exact: unscoped getByRole name matching is substring, and a feed row
    // titled "Error — coordination.deadlock" also contains "Error".
    const chip = page.getByRole('button', { name: 'Error', exact: true });
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  test('a kind chip filters the feed and reflects in the URL', async ({ page }) => {
    // Scoped to this fixture's own session: unscoped, the feed merges the
    // demo-hub multi-project fixture too, and its own prompts are newer.
    // Session, not `project=black-smith`: recordUserPrompt() never threads a
    // project through, so every prompt lands tagged with the column default
    // ('black-smith') regardless of which project it was meant for.
    await page.goto('/activity?session=sess-fixture');
    // exact: substring matching also catches the "because of your prompt at
    // ..." dispatch-row link.
    const chip = page.getByRole('button', { name: 'Prompt', exact: true });
    await chip.click();
    await expect(page).toHaveURL(/kind=prompt/);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.bs-timeline-row__title').first()).toHaveText(
      'Build the widget and fix the flaky import.',
    );

    // Clicking the same chip again clears the filter.
    await chip.click();
    await expect(page).not.toHaveURL(/kind=/);
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  test("Expand all opens every row's detail", async ({ page }) => {
    await page.goto('/activity?kind=prompt');
    // v-show, not v-if (TimelineRow.vue, D-227): the detail <dl> exists while
    // collapsed, just hidden, so this checks visibility, not presence.
    const detail = page.locator('.bs-timeline-row__detail').first();
    await expect(detail).toBeHidden();
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(detail).toBeVisible();
  });

  // A prompt row names its speaker in the meta line, not the title
  // (ds-review.html #p-activity: "You · caused N dispatches"; metaFor()
  // owns the wording, timelineDisplay.test.ts owns that proof) — this is the
  // end-to-end claim that the real feed renders it, not a fixture built
  // around the assertion.
  test('a Prompt row names "You" in its meta line', async ({ page }) => {
    await page.goto('/activity?kind=prompt');
    await expect(page.getByText(/^You/).first()).toBeVisible();
  });

  test('a failed fetch never renders as a clean, empty feed', async ({ page }) => {
    await page.route('**/api/timeline*', (route) => route.abort('failed'));
    await page.goto('/activity');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.getByText('No activity matches these filters.')).toHaveCount(0);
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/activity');
        await settleForShot(page, page.getByRole('feed', { name: 'Activity' }));
        await shoot(page, `activity-${vpName}-${theme}`);
      });
    }
  }
});
