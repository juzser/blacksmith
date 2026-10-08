import { stubActiveScope } from './activeScopeStub.js';
import { expect, test } from './harness.js';
import { VIEWPORTS } from './helpers.js';

// ds-review.html `.ph-body`: the phone page body has a --bs-m-gutter side
// gutter and a --bs-m-gap between its sections. Desktop keeps 24px.
const FIXTURE_TASK = `/tasks/${encodeURIComponent('epic-9/task-3')}`;
const PAGES: Record<string, string> = {
  work: '/kanban',
  activity: '/activity',
  'task detail': FIXTURE_TASK,
};

interface PageBox {
  firstLeft: number;
  gap: number | null; // null when the page shows a single block (Work)
  tabsLeft: number | null;
  tabsWidth: number | null;
}

function measurePage(): PageBox {
  const root = document.querySelector('.app-page');
  if (!root) throw new Error('no .app-page on the route');
  const kids = Array.from(root.children).filter((c) => {
    const r = c.getBoundingClientRect();
    // sr-only text is a 1px box; it is not a section.
    return r.width > 1 && r.height > 1;
  });
  const [a, b] = kids.map((k) => k.getBoundingClientRect());
  if (!a) throw new Error('no section in .app-page');
  const tabs = root.querySelector('.bs-tabs__list')?.getBoundingClientRect() ?? null;
  return {
    firstLeft: a.left,
    gap: b ? b.top - a.bottom : null,
    tabsLeft: tabs ? tabs.left : null,
    tabsWidth: tabs ? tabs.width : null,
  };
}

test.describe('Page gutter matches the mock (ds-review.html .ph-body)', () => {
  for (const [name, path] of Object.entries(PAGES)) {
    test(`phone ${name}: 16px gutter, 16px section gap, tab row edge to edge`, async ({ page }) => {
      await page.setViewportSize(VIEWPORTS.mobile);
      await page.goto(path);
      await expect(page.locator('.app-page')).toBeVisible();
      await expect(page.locator('.bs-skeleton')).toHaveCount(0);
      const m = await page.evaluate(measurePage);
      expect.soft(m.firstLeft, `first block left edge ${m.firstLeft}px`).toBeCloseTo(16, 0);
      if (m.gap !== null) {
        expect.soft(Math.abs(m.gap - 16), `section gap ${m.gap}px`).toBeLessThanOrEqual(0.5);
      } else {
        expect(name).toBe('work');
      }
      if (m.tabsLeft !== null) {
        expect.soft(m.tabsLeft).toBeCloseTo(0, 0);
        expect.soft(m.tabsWidth).toBeCloseTo(VIEWPORTS.mobile.width, 0);
      }
    });

    test(`desktop ${name}: gutter stays 24px`, async ({ page }) => {
      await page.setViewportSize(VIEWPORTS.desktop);
      await page.goto(path);
      await expect(page.locator('.bs-skeleton')).toHaveCount(0);
      // Computed values, not a child's box: a desktop first block may carry
      // its own sub-pixel offset (a sticky bar, a focus ring).
      const css = await page.evaluate(() => {
        const cs = getComputedStyle(document.querySelector('.app-page') as Element);
        return { pad: parseFloat(cs.paddingLeft), gap: parseFloat(cs.rowGap) };
      });
      expect(css.pad, `desktop padding ${css.pad}px`).toBe(24);
      expect(css.gap, `desktop gap ${css.gap}px`).toBe(24);
    });
  }

  // ds-review.html `.mtabs`: Cost & quality's period tabs run edge to edge, so
  // the row's bottom border spans the viewport, not just the three tabs.
  test('phone cost & quality: period tab row runs edge to edge', async ({ page }) => {
    await stubActiveScope(page, [], {
      factorySessions: [{ storeId: 'home', sessionId: 'sess-fixture' }],
    });
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/analytics?scope=all');
    const row = page.locator('.bs-periodswitch--tabs');
    await expect(row).toBeVisible();
    const box = await row.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    });
    expect.soft(box.left, `row left ${box.left}px`).toBeCloseTo(0, 0);
    expect.soft(box.width, `row width ${box.width}px`).toBeCloseTo(VIEWPORTS.mobile.width, 0);
  });
});
