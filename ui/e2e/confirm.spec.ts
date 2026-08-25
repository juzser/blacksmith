import { expect, test } from '@playwright/test';

/**
 * A destructive confirm has exactly one job: say what is about to happen
 * before the operator commits to it. AlertDialog carries that sentence in its
 * `description` prop — "This candidate won't be compiled into agent prompts."
 * — and rendered it as a bare <p> that nothing pointed at, inside a plain
 * `role="dialog"`. A screen reader announcing the dialog reads its accessible
 * name and its description; with no `aria-describedby` the consequence was
 * never spoken, so the operator heard "Reject this lesson?" and "Cancel
 * button" and was asked to decide on that (D-236).
 *
 * Asserted through the browser, not the SFC: `ui/vitest.config.ts` runs in
 * `environment: 'node'` with no component harness, so e2e is the only layer
 * here that renders a template at all.
 */
test.describe('Destructive confirm', () => {
  test('is an alertdialog whose consequence sentence is its description', async ({ page }) => {
    await page.goto('/lessons');
    await page.getByRole('button', { name: 'All' }).click();
    await page.getByText(/loop bound/).click();
    await page
      .getByRole('dialog', { name: 'Review lesson' })
      .getByRole('button', { name: 'Reject' })
      .click();

    // `alertdialog`, not `dialog`: WAI-ARIA reserves it for exactly this —
    // an alert that also demands a response. Assistive clients treat the two
    // differently, and the review Dialog next door is a plain `dialog`.
    const confirm = page.getByRole('alertdialog', { name: 'Reject this lesson?' });
    await expect(confirm).toBeVisible();

    // Resolve the IDREF in the page rather than asserting the attribute's
    // value: what matters is that it lands on the sentence, not what the id
    // happens to be called.
    const described = await confirm.evaluate((el) => {
      const id = el.getAttribute('aria-describedby');
      return id === null ? null : (document.getElementById(id)?.textContent ?? null);
    });
    expect(described).toMatch(/won't be compiled into agent prompts/);
  });
});
