import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

test.describe('Flow', () => {
  test('renders the task DAG with wave labels and an sr-only table alternative', async ({
    page,
  }) => {
    await page.goto('/flow');
    await expect(page.locator('h1')).toHaveText('Flow');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.locator('.flow-node').first()).toBeVisible();
    // Round 11: `.flow-wave-band` (an absolutely-positioned stripe behind the
    // canvas) is now `.flow-wave-label`, a Vue Flow node — so it is visible,
    // not merely attached, and it moves with the column it heads.
    await expect(page.locator('.flow-wave-label').first()).toBeVisible();
    await expect(page.locator('table.sr-only')).toBeAttached();
  });

  // Round 11 ("flow nodes need to be spaced apart"): the separation is
  // asserted as
  // arithmetic in ui/test/flowLayout.test.ts, which runs everywhere. This is
  // the same claim against the real rendered boxes — it only runs where a
  // browser exists, which is why it is not the only place the claim is made.
  test('never overlaps two rendered task nodes', async ({ page }) => {
    await page.goto('/flow');
    await expect(page.locator('.flow-node').first()).toBeVisible();
    const boxes = await page
      .locator('.flow-node')
      .evaluateAll((els) =>
        els
          .map((el) => el.getBoundingClientRect())
          .map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })),
      );
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (!a || !b) continue;
        const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlaps, `node ${i} overlaps node ${j}`).toBe(false);
      }
    }
  });

  test('clicking a task node navigates to task detail', async ({ page }) => {
    await page.goto('/flow');
    const firstNode = page.locator('.flow-node').first();
    await expect(firstNode).toBeVisible();
    await firstNode.click();
    await expect(page).toHaveURL(/\/tasks\//);
  });

  test('never sits on the skeleton when the epic list is what failed', async ({ page }) => {
    // Same shape as Kanban's: the picker's /api/overview fetch was awaited
    // before the graph's own, unguarded, so a failure there meant fetchFlow()
    // never ran and `loading` never cleared (D-222).
    await page.route('**/api/overview*', (route) => route.abort('failed'));
    await page.goto('/flow');
    await expect(page.locator('h1')).toHaveText('Flow');
    await expect(page.locator('.ds-skeleton')).toHaveCount(0);
    await expect(page.locator('.ds-banner')).toBeVisible();
    await expect(page.locator('.flow-node').first()).toBeVisible();
  });

  // The picker is filled from /api/overview, which `load()` never fetches.
  // `setProject` on /flow is a query push on the same route record, so the
  // component is never remounted, and this page has no poll — so a project
  // watcher that called load() alone left the epic list frozen on the
  // previous project's epics for good: the new project's epics could not be
  // picked at all without a manual reload (D-228).
  test('re-reads the epic list when the project switches under it', async ({ page }) => {
    const epicOptions = () =>
      page.getByLabel('Epic', { exact: true }).locator('option').allTextContents();
    const projectSwitcher = page.getByLabel('Project', { exact: true });

    await page.goto('/flow');
    await expect(page.locator('.flow-node').first()).toBeVisible();
    // Proof the population is not empty before anything is claimed absent:
    // unscoped, the picker carries epics from both fixture projects.
    expect(await epicOptions()).toEqual(expect.arrayContaining(['epic-1', 'epic-9']));

    await projectSwitcher.selectOption('black-smith');
    await expect(page).toHaveURL(/[?&]project=black-smith/);
    await expect.poll(epicOptions).not.toContain('epic-9');
    expect(await epicOptions()).toContain('epic-1');

    await projectSwitcher.selectOption('demo-hub');
    await expect(page).toHaveURL(/[?&]project=demo-hub/);
    await expect.poll(epicOptions).not.toContain('epic-1');
    expect(await epicOptions()).toContain('epic-9');
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/flow');
        await expect(page.locator('h1')).toHaveText('Flow');
        await settleForShot(page, page.locator('.flow-node').first(), 300);
        await shoot(page, `flow-${vpName}-${theme}`);
      });
    }
  }
});
