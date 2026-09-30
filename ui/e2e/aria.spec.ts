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
});
