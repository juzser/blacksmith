import { expect, type Page, test } from './harness.js';
import { VIEWPORTS } from './helpers.js';

/**
 * `aria-modal="true"` is a promise: everything outside this element is
 * unavailable. It is the author's job to make that true — the attribute
 * changes what assistive tech announces, it does not change what the keyboard
 * can reach. The mobile navigation Sheet declared it and enforced none of it:
 * focus stayed on the hamburger behind the overlay, Tab walked straight out
 * into the topbar and page behind, `#app` was never inert, and closing left
 * focus on <body> when the X button it was on got unmounted (D-238).
 *
 * The sibling Dialog in the same directory had all four behaviours. These
 * assertions are written against the Sheet because that is where they were
 * missing, and phrased as behaviour ("focus is still inside") rather than as
 * a focusable-element count, so they survive a nav item being added.
 */
test.use({ viewport: VIEWPORTS.mobile });

async function openSheet(page: Page) {
  await page.goto('/overview');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  return page.getByRole('dialog', { name: 'Navigation' });
}

test.describe('Mobile navigation Sheet', () => {
  test('moves focus into itself on open, and marks the background inert', async ({ page }) => {
    const sheet = await openSheet(page);
    await expect(sheet).toBeVisible();

    expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    expect(await page.evaluate(() => document.getElementById('app')?.hasAttribute('inert'))).toBe(
      true,
    );
  });

  test('traps Tab inside itself', async ({ page }) => {
    const sheet = await openSheet(page);

    // More presses than the sheet has focusables, so this fails if Tab ever
    // escapes rather than only if it escapes on the first try.
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press('Tab');
      expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
  });

  test('returns focus to the trigger on Escape, and releases the background', async ({ page }) => {
    const sheet = await openSheet(page);
    // Move focus off the trigger first. Without this the assertion below
    // passes on a Sheet that does nothing at all, because a Sheet that never
    // moves focus leaves it on the hamburger it was already on.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Open navigation' })).not.toBeFocused();

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
    expect(await page.evaluate(() => document.getElementById('app')?.hasAttribute('inert'))).toBe(
      false,
    );
  });
});
