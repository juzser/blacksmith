import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Timeline', () => {
  test('renders the seeded event log and a11y basics', async ({ page }) => {
    await page.goto('/timeline');
    await expect(page.locator('h1')).toHaveText('Timeline');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.getByText('Build the widget and fix the flaky import.')).toBeVisible();
  });

  // D-253. Both of these rows are a judge run that reached no verdict, and
  // until this change both rendered the identical words "schema failure" --
  // one provider that answered unusably, one that was never sent a request
  // because its API key is unset. The row has to name which, because the two
  // name different repairs. Asserted in the browser rather than only in the
  // unit test because no fixture wrote a judge-verdict event at all before
  // now: the label had no screenshot and no e2e coverage of any kind.
  test('a failed judge verdict names its cause, not just that it failed', async ({ page }) => {
    await setTheme(page, 'light');
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/timeline');
    await expect(page.locator('h1')).toHaveText('Timeline');
    await page.getByLabel('Search prompts and dispatch reasons').fill('Judge verdict');
    const missingKey = page.getByText(
      'Judge verdict — failed: provider.missing-api-key (verifier/deepseek)',
    );
    await expect(missingKey).toBeVisible();
    await expect(
      page.getByText('Judge verdict — failed: provider.invalid-output (reviewer/codex)'),
    ).toBeVisible();
    // Captured as well as asserted: the two rows sit side by side here, and a
    // reviewer comparing this PNG against the same view on main sees the whole
    // defect in one glance -- two different repairs that used to print the
    // same four words. The full-page shots below can't show it, since the
    // judge rows are causally nested and collapsed there.
    await settleForShot(page, missingKey);
    await shoot(page, 'timeline-judge-failure-desktop-light');
  });

  test('empty state renders when the search filter matches nothing, with a working Clear filters', async ({
    page,
  }) => {
    await page.goto('/timeline');
    await page
      .getByLabel('Search prompts and dispatch reasons')
      .fill('no such event exists anywhere');
    await expect(page.getByText('No events match these filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByText('Build the widget and fix the flaky import.')).toBeVisible();
  });

  test('disclosure chevron expands a dispatch row and shows its children', async ({ page }) => {
    await page.goto('/timeline');
    const chevron = page.locator('button[aria-expanded="false"]').first();
    await expect(chevron).toBeVisible();
    await chevron.click();
    await expect(page.locator('button[aria-expanded="true"]').first()).toBeVisible();
  });

  // D-229. The Clear control carried `class="hds-chips__clear"`, and no rule
  // by that name existed in any of the three stylesheets -- so Tailwind
  // preflight was the only thing styling it: inherited 14px body text,
  // `cursor: default`, no padding, 20px tall in a row of 24px pills. Nothing
  // could catch it: `ui/tsconfig.json` skips .vue, biome skips .vue, and no
  // tool in the repo reads CSS at all. Asserted here rather than in the unit
  // test because only a browser resolves a class to a rule -- and asserted
  // against a chip in the same row rather than against literals, since the
  // claim is that the two agree, not that either is 24px.
  test('the Clear control is styled like the chips it sits beside', async ({ page }) => {
    await page.goto('/timeline');
    await expect(page.getByText('Build the widget and fix the flaky import.')).toBeVisible();
    // Clear only renders once something is selected -- which is why no
    // screenshot test has ever had it on screen.
    await page.getByRole('button', { name: 'Dispatches', exact: true }).click();
    const clear = page.getByRole('button', { name: 'Clear', exact: true });
    const chip = page.locator('.hds-chip').last();
    await expect(clear).toBeVisible();

    const box = async (l: typeof clear) =>
      await l.evaluate((el) => {
        const c = getComputedStyle(el);
        return {
          cursor: c.cursor,
          fontSize: c.fontSize,
          height: Math.round(el.getBoundingClientRect().height),
          top: Math.round(el.getBoundingClientRect().top),
        };
      });
    const [a, b] = [await box(clear), await box(chip)];
    expect(a.cursor).toBe('pointer');
    expect(a.fontSize).toBe(b.fontSize);
    expect(a.height).toBe(b.height);
    expect(a.top).toBe(b.top);
  });

  // The operator's ask, end to end: "the prompts subagents hand each other,
  // group them compactly". A wave admits its tasks and the planner fans out one
  // dispatch per task from that single decision, so the timeline folds the run
  // into one row. Only e2e can prove it — the unit test folds a hand-built
  // tree, and the shape that reaches the page is built by the projector and the
  // causal tree above it.
  test('a run of sibling dispatches folds into one expandable group row', async ({ page }) => {
    await page.goto('/timeline');
    // Through the Dispatches chip, which is where a wall of them is actually
    // read: the filter drops the wave-admitted they hang off, buildCausalTree
    // promotes every one of them to a root, and a run of roots is the same run.
    await page.getByRole('button', { name: 'Dispatches', exact: true }).click();
    const header = page.locator('.timeline-row__title', { hasText: /^\d+ dispatches — / }).first();
    // Mixed-role since D-253 seeded two judge dispatches into the fixture (and
    // D-255 a third), and that is the shape a real run has: the chip promotes
    // every dispatch in the log to a root, so one run holds whatever roles the
    // log dispatched, busiest first, and only a repeated role carries a count.
    await expect(header).toHaveText(/^\d+ dispatches — coder ×\d+, verifier ×\d+, reviewer$/);
    // Asserted against the rows it turns out to hold rather than a fixture
    // constant — the count is the fold's own claim, and the seeded log spans
    // two fixtures that neither owns the other's dispatch count.
    const claimed = Number((await header.innerText()).split(' ')[0]);
    expect(claimed).toBeGreaterThanOrEqual(4);
    // The rows it stands for are not on the page until it is opened — that is
    // the whole trade the fold makes.
    await expect(page.getByText('implement the widget renderer')).toHaveCount(0);

    await shoot(page, 'timeline-dispatch-groups-desktop-light');

    await page.getByRole('button', { name: 'Expand dispatches' }).click();
    await expect(page.getByText('implement the widget renderer')).toBeVisible();
    await expect(page.getByText('simplify the config loader')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Collapse dispatches' })).toBeVisible();
    await expect(page.locator('.timeline-row__title', { hasText: /^Dispatched / })).toHaveCount(
      claimed,
    );
    await shoot(page, 'timeline-dispatch-groups-expanded-desktop-light');
    // An open group renders its members as rows, never as another group: the
    // members are by construction a foldable run, so a fold that recursed
    // would rebuild the same group under the same id and never terminate.
    await expect(
      page.locator('.timeline-row__title', { hasText: /^\d+ dispatches — / }),
    ).toHaveCount(1);
  });

  test('"Decisions" lens narrows the list to prompts + operator decisions', async ({ page }) => {
    await page.goto('/timeline');
    await expect(page.locator('.timeline-row').first()).toBeVisible();
    // Counted from the toolbar, not from rendered rows. Rows are the *roots*
    // of a causal disclosure tree, and dropping an entry promotes its children
    // to roots — so a narrower lens can legitimately render more top-level
    // rows than a wider one. The entry count is what actually narrows.
    // `[1-9]\d*`, not `\d+`: the toolbar renders "0 events" before the fetch
    // resolves, and `\d+` matches that — so the wait that exists to hold until
    // there is data would return with none, and `before` would be 0. Every
    // assertion below compares against `before`.
    const count = page.locator('.hds-toolbar__count');
    await expect(count).toHaveText(/^[1-9]\d* events$/);
    const before = Number((await count.innerText()).split(' ')[0]);
    await page.getByRole('button', { name: 'Decisions', exact: true }).click();
    await expect(count).not.toHaveText(`${before} events`);
    const after = Number((await count.innerText()).split(' ')[0]);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
  });

  // D-153, end to end through the real read path: the unit test can only prove
  // KIND_OPTIONS names operator-note, and the defect was that queries.ts
  // dropped it a layer earlier. Nothing below the server can catch that, and
  // the fixture used to contain a user_prompt and no operator-note — which is
  // exactly why the suite stayed green while the chip returned an empty list
  // over the factory's own logs, where the ratio is reversed: 57 to 0.
  test('the Prompts chip shows both kinds of row a person writes', async ({ page }) => {
    await page.goto('/timeline');
    // Same nonzero wait as above, and this test is the one that proved it
    // necessary: it has no rendered-row assertion to hide behind, so it read
    // "0 events" straight off the pre-fetch render and failed on `2 < 0`.
    const count = page.locator('.hds-toolbar__count');
    await expect(count).toHaveText(/^[1-9]\d* events$/);
    const before = Number((await count.innerText()).split(' ')[0]);

    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    await expect(page.getByText('No events match these filters.')).toHaveCount(0);
    await expect(page.getByText('Build the widget and fix the flaky import.')).toBeVisible();
    await expect(
      page.getByText('scope-check — the flaky import is in the same module, so one task covers it'),
    ).toBeVisible();

    const after = Number((await count.innerText()).split(' ')[0]);
    expect(after).toBe(2);
    expect(after).toBeLessThan(before);

    await shoot(page, 'timeline-prompts-desktop-light');
  });

  // The page polls every 15s, and `load()` cleared `error` before every
  // attempt. So a sustained outage spent each request's flight time with the
  // banner gone and "No events match these filters." in its place: the
  // factory's own event log reporting itself empty because the request for it
  // never answered. Refresh drives the very same `load()` the poll does, so
  // this reaches the window without waiting 15s for it.
  test('a failing refresh never replaces the error with an empty timeline', async ({ page }) => {
    let served = 0;
    await page.route('**/api/timeline*', async (route) => {
      served += 1;
      if (served === 1) {
        await route.abort('failed');
        return;
      }
      // Hold the second request in flight. The window this test is about is
      // exactly "a request is outstanding and the last one failed", and it
      // would otherwise close before an assertion could look at it.
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      await route.abort('failed').catch(() => {});
    });
    await page.goto('/timeline');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    // Resolves the moment the refetch is issued -- i.e. the moment `load()`
    // has done whatever it does to `error` -- so the assertions below land
    // inside the in-flight window rather than racing it.
    const refetch = page.waitForRequest('**/api/timeline*');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await refetch;

    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.getByText('No events match these filters.')).toHaveCount(0);
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/timeline');
        await expect(page.locator('h1')).toHaveText('Timeline');
        await settleForShot(page, page.locator('.timeline-row').first());
        await shoot(page, `timeline-${vpName}-${theme}`);
      });
    }
  }
});
