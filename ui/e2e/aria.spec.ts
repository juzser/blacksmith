import { expect, type Page, test } from './harness.js';

/**
 * A disclosure's `aria-controls` is at its most useful while COLLAPSED — that
 * is the state in which it is the only thing telling an assistive client what
 * the chevron is about to open. Every disclosure in this app rendered the
 * attribute unconditionally but rendered the `role="group"` it names behind a
 * `v-if` on `expanded`, so the default state of every page shipped an IDREF
 * pointing at nothing (D-227).
 *
 * Swept, not enumerated: the assertion reads whatever `[aria-controls]` the
 * page happens to render and resolves each one in the browser, so a disclosure
 * added later is covered without touching this file. `ui/tsconfig.json` does
 * not type-check `.vue` templates and there is no component-test harness — e2e
 * is the only layer in this repo that runs an SFC template at all.
 */
async function danglingIdrefs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-controls]'))
      .map((el) => el.getAttribute('aria-controls') ?? '')
      .filter((id) => id === '' || document.getElementById(id) === null),
  );
}

test.describe('Disclosure ARIA', () => {
  test('timeline chevrons name a real element while collapsed, and still do once expanded', async ({
    page,
  }) => {
    await page.goto('/timeline');
    // Data-gated, not h1-gated: the <h1> renders before any /api/ response
    // arrives, and a sweep over an empty page asserts nothing (D-150).
    await expect(page.getByText('Build the widget and fix the flaky import.')).toBeVisible();

    const triggers = page.locator('[aria-controls]');
    // The sweep's own claim, said out loud — otherwise "no dangling IDREFs"
    // and "no disclosures on the page" read identically.
    expect(await triggers.count()).toBeGreaterThan(0);
    await expect(page.locator('button[aria-expanded="true"]')).toHaveCount(0);

    expect(await danglingIdrefs(page)).toEqual([]);

    // Resolving is half of it -- a panel that resolves but is on screen while
    // its chevron says aria-expanded="false" is a different lie. Ids here
    // carry a '#', so the attribute selector, not '#id'.
    const chevron = page.locator('button[aria-expanded="false"]').first();
    const panel = page.locator(`[id="${await chevron.getAttribute('aria-controls')}"]`);
    await expect(panel).toBeHidden();

    // The other half of the contract: opening one must not break the rest.
    await chevron.click();
    await expect(panel).toBeVisible();
    expect(await danglingIdrefs(page)).toEqual([]);
  });

  test('overview live-agent group chevrons name a real element while collapsed', async ({
    page,
  }) => {
    await page.goto('/overview');

    // Data-gated on THIS page's own fetch. The liveness label used to serve as
    // that gate, but it moved into the app shell and now runs off /api/pulse —
    // it turns "Live" when the pulse lands, which can be before /api/overview
    // has returned a single agent. Waiting on the rows the sweep is about is
    // the only gate that cannot drift out from under it again.
    const groups = page.locator('.live-agent-group-row');
    await expect(groups.first()).toBeVisible();
    const count = await groups.count();
    // Said out loud, because "no dangling IDREFs" and "no disclosures on the
    // page" read identically otherwise.
    expect(count).toBeGreaterThan(0);

    // This page opens every group by default while the whole factory fits on
    // screen (<=6 agents), which the fixture does — so collapsed has to be
    // reached deliberately. It is the state the IDREF exists for.
    for (let i = 0; i < count; i++) {
      const group = groups.nth(i);
      if ((await group.getAttribute('aria-expanded')) === 'true') await group.click();
    }
    await expect(page.locator('.live-agent-group-row[aria-expanded="true"]')).toHaveCount(0);

    expect(await danglingIdrefs(page)).toEqual([]);

    // `hidden` has to actually hide: this panel's own class is `display: flex`
    // and would outrank the UA stylesheet on its own. What settles it is
    // Tailwind's preflight shipping [hidden] with `!important` -- a dependency
    // detail, so assert the outcome rather than trust it.
    const panel = page.locator(`[id="${await groups.first().getAttribute('aria-controls')}"]`);
    await expect(panel).toBeHidden();

    // The other half of the contract: re-opening one must not break the rest.
    await groups.first().click();
    await expect(panel).toBeVisible();
    expect(await danglingIdrefs(page)).toEqual([]);
  });
});
