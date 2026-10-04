import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

// DS6 PR4b round 3: fixture builder for the live-updates / session-divider
// e2e tests below. Shape matches TimelineEntry (api.ts) — sessionId/Title are
// mandatory there since DS6 PR4b, unlike home.spec.ts's older synthetic rows.
function synthEntry(
  id: string,
  minsAgo: number,
  overrides: Partial<{
    sessionId: string;
    sessionTitle: string;
    payload: Record<string, unknown>;
  }> = {},
) {
  return {
    eventId: id,
    ts: new Date(Date.now() - minsAgo * 60_000).toISOString(),
    eventType: 'user_prompt',
    taskId: null as string | null,
    agentId: null,
    planVersion: 1,
    causalParent: null,
    payload: overrides.payload ?? { prompt: `Synthetic row ${id}` },
    project: 'black-smith',
    actor: 'operator',
    sessionId: overrides.sessionId ?? 'sess-synth',
    sessionTitle: overrides.sessionTitle ?? 'Synthetic session',
  };
}

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
    // The fixture's operator-note (kind Prompt, same as user_prompt -- D-153)
    // is the newer of the two Prompt rows, so it -- not the user_prompt --
    // is first on this newest-first page.
    await expect(page.locator('.bs-timeline-row__title').first()).toHaveText(
      'scope-check: the flaky import is in the same module, so one task covers it',
    );

    // Clicking the same chip again clears the filter.
    await chip.click();
    await expect(page).not.toHaveURL(/kind=/);
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  // Visual pass round 4, item 3 — ds-spec.md §3.1 shell table: phone shows
  // the kind filter as an underline tab row (mock's `.mtabs`), not the
  // desktop chip row, and hides Refresh/the chip row there.
  test('phone layout shows the kind filter as a tab row, hides chips and Refresh', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/activity?session=sess-fixture');
    const tablist = page.getByRole('tablist', { name: 'Filter' });
    await expect(tablist).toBeVisible();
    await expect(page.locator('.activity-kind-filter')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);

    const allTab = tablist.getByRole('tab', { name: 'All' });
    await expect(allTab).toHaveAttribute('aria-selected', 'true');
    const promptTab = tablist.getByRole('tab', { name: 'Prompt', exact: true });
    await expect(promptTab).toHaveAttribute('aria-selected', 'false');
    const box = await promptTab.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    await promptTab.click();
    await expect(page).toHaveURL(/kind=prompt/);
    await expect(promptTab).toHaveAttribute('aria-selected', 'true');
    await expect(allTab).toHaveAttribute('aria-selected', 'false');

    await allTab.click();
    await expect(page).not.toHaveURL(/kind=/);
  });

  test('desktop layout keeps the chip row and Refresh, no tablist', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/activity?session=sess-fixture');
    await expect(page.locator('.activity-kind-filter')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Filter' })).toHaveCount(0);
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

  // DS6 PR4b round 3 item 1 (ds-spec.md §4.3 "Live"): spec-local route
  // overrides, per the brief, so these don't touch the shared fixture or its
  // screenshot baselines above.
  test('a new-events pill appears while scrolled away, and clicking it prepends and scrolls to top', async ({
    page,
  }) => {
    const initial = Array.from({ length: 30 }, (_, i) => synthEntry(`init-${i}`, i));
    const fresh = synthEntry('fresh-1', -1, { payload: { prompt: 'Brand new row' } });
    await page.route('**/api/timeline?*', (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has('after')) {
        route.fulfill({ json: { entries: [fresh], nextBefore: null, newestId: fresh.eventId } });
        return;
      }
      route.fulfill({
        json: { entries: initial, nextBefore: null, newestId: initial[0]?.eventId ?? null },
      });
    });
    await page.goto('/activity');
    await expect(page.locator('.bs-timeline-row__title').first()).toBeVisible();

    // Scroll away from the top so the pill buffers instead of merging live.
    // The feed scrolls inside .app-scroll (the app shell's own container),
    // not the window/body -- window.scrollTo is a no-op here.
    await page.evaluate(() => {
      const el = document.querySelector('.app-scroll');
      el?.scrollTo(0, el.scrollHeight);
    });
    await page.waitForTimeout(200);

    // Refresh now is aria-disabled while live (ds-spec.md §2.2) -- pause
    // first, same as shell.spec.ts. Its signal still fires poll() regardless
    // of the paused state (usePoll.ts), no real 15s wait needed.
    await page.getByRole('button', { name: 'Pause updates' }).click();
    await page.getByRole('button', { name: 'Refresh now' }).click();

    const pill = page.locator('.activity-newpill');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText('1 new event');
    // Not merged into the list while scrolled away: a reader paged back
    // never has rows re-sort under them.
    await expect(page.getByText('Brand new row')).toHaveCount(0);

    await pill.getByRole('button').click();
    await expect(pill).toHaveCount(0);
    await expect(page.locator('.bs-timeline-row__title').first()).toHaveText('Brand new row');
    await expect
      .poll(() => page.evaluate(() => document.querySelector('.app-scroll')?.scrollTop))
      .toBe(0);
  });

  test('Pause live updates stops the incremental poll from firing', async ({ page }) => {
    test.setTimeout(45_000);
    let afterRequests = 0;
    await page.route('**/api/timeline?*', (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has('after')) {
        afterRequests += 1;
        route.fulfill({ json: { entries: [], nextBefore: null, newestId: null } });
        return;
      }
      route.continue();
    });
    await page.goto('/activity');
    await expect(page.locator('.bs-timeline-row__title').first()).toBeVisible();
    await page.getByRole('button', { name: 'Pause updates' }).click();
    await expect(page.getByRole('button', { name: 'Resume updates' })).toBeVisible();

    // Activity's poll cadence is 15s (design-spec.md §8); a window
    // comfortably longer than one tick with zero after= requests proves
    // Pause stands the new incremental poll() down, not just usePoll's
    // pre-existing full-reload callers.
    await page.waitForTimeout(17_000);
    expect(afterRequests).toBe(0);
  });

  test('the bottom sentinel loads older rows without touching the newer page', async ({ page }) => {
    const first = Array.from({ length: 50 }, (_, i) => synthEntry(`first-${i}`, i));
    const older = [synthEntry('older-1', 100, { payload: { prompt: 'Much older row' } })];
    await page.route('**/api/timeline?*', (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has('before')) {
        route.fulfill({ json: { entries: older, nextBefore: null, newestId: null } });
        return;
      }
      route.fulfill({
        json: { entries: first, nextBefore: 'cursor-1', newestId: first[0]?.eventId ?? null },
      });
    });
    await page.goto('/activity');
    await expect(page.locator('.bs-timeline-row__title').first()).toBeVisible();
    // .bs-timeline-row__title only: the collapsed detail <dd> repeats the
    // same text (v-show, not v-if, D-227), so an unscoped getByText matches
    // both and trips strict mode.
    const olderTitle = page.locator('.bs-timeline-row__title', { hasText: 'Much older row' });
    await expect(olderTitle).toHaveCount(0);
    await page.locator('.activity-sentinel').last().scrollIntoViewIfNeeded();
    await expect(olderTitle).toBeVisible();
  });

  test('a session divider separates adjacent rows from different sessions, and its details link to Sessions', async ({
    page,
  }) => {
    const entries = [
      synthEntry('div-a', 0, { sessionId: 'sess-a', sessionTitle: 'Session A' }),
      synthEntry('div-b', 1, { sessionId: 'sess-b', sessionTitle: 'Session B' }),
    ];
    await page.route('**/api/timeline?*', (route) => {
      route.fulfill({ json: { entries, nextBefore: null, newestId: entries[0]?.eventId ?? null } });
    });
    await page.goto('/activity');
    await expect(page.locator('.bs-session-divider')).toHaveText('Session: Session B');

    await page.getByRole('button', { name: 'Expand all' }).click();
    const detail = page.locator('.bs-timeline-row__detail').nth(1);
    await expect(detail).toBeVisible();
    const link = detail.getByRole('link', { name: 'Session B' });
    await link.click();
    await expect(page).toHaveURL('/sessions');
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
