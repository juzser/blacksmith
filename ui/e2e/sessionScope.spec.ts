import { expect, test } from './harness.js';

// The session picker and its width control (D-264's other half).
//
// ui/test/sessionScope.test.ts owns the rules -- what a query reads as, what
// a fetch writes, which routes show the control -- and runs everywhere. This
// file makes the one claim that only a browser can settle: the pair the
// controls emit is a pair the server accepts, end to end, with a page
// rendered on the far side of it. The client's whole reason for modelling
// `lineage` as unrepresentable without a `session` is that app.ts 400s on
// that pair; a test that never sends a real request cannot show it doesn't.

const PICKER = 'select[aria-label="Session"]';
const WIDTH = 'select[aria-label="Session scope width"]';

/** The fixture's own run, read off the picker rather than imported, so the
 *  spec keeps working when the fixture grows a third session. */
async function firstSession(page: import('@playwright/test').Page): Promise<string> {
  const values = await page
    .locator(`${PICKER} option`)
    .evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value).filter((v) => v !== ''));
  expect(values.length, 'the fixture projects at least one session').toBeGreaterThan(0);
  return values[0] as string;
}

test.describe('Session scope', () => {
  test('offers the picker on the pages that read the scope, and nowhere else', async ({ page }) => {
    for (const path of ['/sessions', '/timeline', '/kanban', '/flow', '/errors', '/analytics']) {
      await page.goto(path);
      await expect(page.locator(PICKER), `${path} offers the picker`).toBeVisible();
    }
    for (const path of ['/projects', '/roadmap', '/lessons']) {
      await page.goto(path);
      await expect(page.locator(PICKER), `${path} does not`).toHaveCount(0);
    }
  });

  test('picking a run scopes the page and shows the width control', async ({ page }) => {
    await page.goto('/sessions');
    await expect(page.locator(PICKER)).toBeVisible();
    // Hidden until there is a session to widen: the pair app.ts refuses is
    // not reachable from the UI, it is not merely discouraged.
    await expect(page.locator(WIDTH)).toHaveCount(0);

    const session = await firstSession(page);
    const scoped = page.waitForRequest(
      (r) => r.url().includes('/api/overview') && r.url().includes(`session=${session}`),
    );
    await page.locator(PICKER).selectOption(session);
    await scoped;

    await expect(page).toHaveURL(new RegExp(`session=${session}`));
    await expect(page.locator(WIDTH)).toBeVisible();
    // Still a page, not a 400: the canvas drew the run that was asked for.
    await expect(page.locator('.session-node')).toHaveCount(1);
  });

  test('widening asks for the lineage, and the server answers it', async ({ page }) => {
    await page.goto('/sessions');
    const session = await firstSession(page);
    await page.locator(PICKER).selectOption(session);
    await expect(page.locator(WIDTH)).toBeVisible();

    const widened = page.waitForResponse(
      (r) => r.url().includes('/api/overview') && r.url().includes('lineage=true'),
    );
    await page.locator(WIDTH).selectOption('lineage');
    expect((await widened).status(), 'app.ts accepts the pair the UI emits').toBe(200);
    await expect(page).toHaveURL(/lineage=true/);
    await expect(page.locator('.session-node').first()).toBeVisible();
    await expect(page.locator('.ds-banner')).toHaveCount(0);
  });

  test('clearing the run takes the widening with it', async ({ page }) => {
    await page.goto('/sessions');
    const session = await firstSession(page);
    await page.locator(PICKER).selectOption(session);
    await expect(page.locator(WIDTH)).toBeVisible();
    await page.locator(WIDTH).selectOption('lineage');
    await expect(page).toHaveURL(/lineage=true/);

    await page.locator(PICKER).selectOption('');
    // Both params, or the next session picked would inherit a widening the
    // operator did not choose -- and a `lineage` left behind alone is the
    // 400 the type exists to prevent.
    await expect(page).not.toHaveURL(/session=/);
    await expect(page).not.toHaveURL(/lineage=/);
    await expect(page.locator(WIDTH)).toHaveCount(0);
  });

  test('a hand-typed scope is read on load, not just on click', async ({ page }) => {
    const session = 'sess-fixture';
    await page.goto(`/timeline?session=${session}&lineage=true`);
    await expect(page.locator(PICKER)).toHaveValue(session);
    await expect(page.locator(WIDTH)).toHaveValue('lineage');
    await expect(page.locator('h1')).toHaveText('Timeline');
    await expect(page.locator('.ds-banner')).toHaveCount(0);
  });
});
