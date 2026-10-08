import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';
import { VIEWPORTS } from './helpers.js';

// Every relative time ("5 min ago") is a tooltip trigger with its own tab stop,
// so on a phone it is a tap target and must reach --bs-touch. The hit box has
// to grow without moving anything: the card or row holding it keeps its height,
// and the bigger box must not sit on top of another target.

const FONT_VARIANTS: { label: string; css: string | null }[] = [
  { label: '', css: null },
  { label: ' (Arial metrics)', css: ':root { --bs-font-sans: Arial, sans-serif; }' },
];

const TIME = '.bs-tooltip-trigger:has(> time)';
const SESSION_LINK = '.bs-timeline-row__detail a';
const NEIGHBOURS =
  'a[href], button, [role="button"], [role="tab"], input, select, [tabindex]:not([tabindex="-1"])';

interface Box {
  w: number;
  h: number;
  holder: number;
  overlaps: string[];
  inRow: boolean;
}

// Runs in the page: the box of every visible match, the height of the card or
// row holding it, and the other targets whose box it intersects by over 1px.
function measure(args: { selector: string; neighbours: string }): Box[] {
  const out: Box[] = [];
  for (const el of Array.from(document.querySelectorAll(args.selector))) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const holder = el.closest('li, article, tr') ?? el.parentElement;
    const overlaps: string[] = [];
    for (const o of Array.from(document.querySelectorAll(args.neighbours))) {
      if (o === el || o.contains(el) || el.contains(o)) continue;
      const b = o.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      // The top and tab bars sit over whatever scrolls under them.
      if (o.closest('header, nav')) continue;
      // Fixed or sticky chrome (the tab bar) overlaps whatever scrolls under it.
      let fixed = false;
      for (let a: Element | null = o; a; a = a.parentElement) {
        if (['fixed', 'sticky'].includes(getComputedStyle(a).position)) fixed = true;
      }
      if (fixed) continue;
      // A box that holds this whole one (a card's stretched link) is its
      // container, not a neighbour.
      if (b.left <= r.left && b.right >= r.right && b.top <= r.top && b.bottom >= r.bottom)
        continue;
      const w = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const h = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      if (w > 1 && h > 1) {
        const text = (o.textContent ?? '').trim().slice(0, 30);
        overlaps.push(`${o.tagName.toLowerCase()} "${text}" ${w.toFixed(1)}x${h.toFixed(1)}`);
      }
    }
    out.push({
      w: r.width,
      h: r.height,
      holder: holder?.getBoundingClientRect().height ?? 0,
      overlaps,
      // Only these two keep their text height (bs-primitives.css).
      inRow: el.matches('.bs-timeline-row__ts--meta, .bs-live-card__status .bs-reltime'),
    });
  }
  return out;
}

// Deletes the hit-box rules under test from the live stylesheets, so the same
// page can be measured as if they were never there.
const dropHitBoxRules = () => {
  const drop = (rules: CSSRuleList) => {
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i] as CSSStyleRule & CSSGroupingRule;
      if (r.cssRules && !r.selectorText) drop(r.cssRules);
      else if (r.selectorText === '.bs-reltime' || r.selectorText === '.bs-timeline-row__detail a')
        r.parentRule
          ? (r.parentRule as CSSGroupingRule).deleteRule(i)
          : r.parentStyleSheet?.deleteRule(i);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) drop(sheet.cssRules);
};
const round = (n: number) => Math.round(n * 10) / 10;

async function touchFloor(page: Page): Promise<number> {
  const touch = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bs-touch')),
  );
  return touch - 0.5;
}

// Heights of the holder of every trigger, read on main before the fix. They
// must not move: the hit box is padding cancelled by an equal negative margin.
const HOLDER_HEIGHTS: Record<string, number[]> = {
  kanban: [102],
  activity: [...Array(49).fill(65), 64],
  overview: [65, 65, 65, 65, ...Array(8).fill(40)],
  sessions: [98, 98],
};

const PAGES = [
  ['kanban', '/kanban'],
  ['activity', '/activity'],
  ['overview', '/overview'],
  ['sessions', '/sessions'],
] as const;

test.describe('Phone: the relative-time tooltip trigger is a --bs-touch target', () => {
  for (const font of FONT_VARIANTS) {
    for (const [name, path] of PAGES) {
      test(`${name}: every relative time is at least --bs-touch square, moves nothing, covers no target${font.label}`, async ({
        page,
      }) => {
        await page.setViewportSize(VIEWPORTS.mobile);
        await page.goto(path);
        if (font.css) await page.addStyleTag({ content: font.css });
        await expect(page.locator('.bs-skeleton')).toHaveCount(0);
        await expect(page.locator(`${TIME}:visible`).first()).toBeVisible();
        const floor = await touchFloor(page);
        const boxes = await page.evaluate(measure, { selector: TIME, neighbours: NEIGHBOURS });
        expect(boxes.length).toBeGreaterThan(0);
        for (const b of boxes) {
          // A timeline row (or live card) holds a neighbour's 44px box right above its
          // time (bs-primitives.css, .bs-timeline-row__ts--meta, .bs-live-card__status), so its time
          // keeps its text box: only its width is a floor.
          // That title box already covers 8px of the time's own text on main.
          if (b.inRow) {
            expect(b.w, `${name}: a row's time is narrower than --bs-touch`).toBeGreaterThanOrEqual(
              floor,
            );
            continue;
          }
          const where = `${name}: a relative time measures ${b.w.toFixed(1)}x${b.h.toFixed(1)}`;
          expect(b.w, `${where}, narrower than --bs-touch`).toBeGreaterThanOrEqual(floor);
          expect(b.h, `${where}, shorter than --bs-touch`).toBeGreaterThanOrEqual(floor);
          // A doubled hit-box rule (e.g. stacked on a card's own) would overshoot.
          expect(b.h, `${where}, taller than one --bs-touch box`).toBeLessThanOrEqual(floor + 1.5);
        }
        expect(
          [...new Set(boxes.filter((b) => !b.inRow).flatMap((b) => b.overlaps))],
          `${name}: covers another target`,
        ).toEqual([]);
        // Row heights follow the font (a wrapped line), so they are pinned for
        // the default font only.
        if (!font.css) expect(boxes.map((b) => round(b.holder))).toEqual(HOLDER_HEIGHTS[name]);
      });
    }
  }

  // An expanded timeline row's Session link, on Activity and on a task's
  // History tab. The row keeps the height it had before the link grew: the
  // same rows are measured again with the hit-box rules switched off.
  for (const font of FONT_VARIANTS) {
    for (const where of ['activity', 'history'] as const) {
      test(`${where}: the Session link in an expanded row is at least --bs-touch and covers no target${font.label}`, async ({
        page,
      }) => {
        await page.setViewportSize(VIEWPORTS.mobile);
        await page.goto(
          where === 'activity' ? '/activity' : `/tasks/${encodeURIComponent('epic-9/task-3')}`,
        );
        if (where === 'history') await page.getByRole('tab', { name: 'History' }).click();
        if (font.css) await page.addStyleTag({ content: font.css });
        await expect(page.locator('.bs-skeleton')).toHaveCount(0);
        const chevrons = page.locator('.bs-timeline-row__chevron:visible');
        await expect(chevrons.first()).toBeVisible();
        for (let i = 0; i < Math.min(12, await chevrons.count()); i++)
          await chevrons.nth(i).click();
        await expect(page.locator(`${SESSION_LINK}:visible`).first()).toBeVisible();
        const floor = await touchFloor(page);
        const boxes = await page.evaluate(measure, {
          selector: SESSION_LINK,
          neighbours: NEIGHBOURS,
        });
        for (const b of boxes) {
          const at = `${where}: the Session link measures ${b.w.toFixed(1)}x${b.h.toFixed(1)}`;
          expect(b.w, `${at}, narrower than --bs-touch`).toBeGreaterThanOrEqual(floor);
          expect(b.h, `${at}, shorter than --bs-touch`).toBeGreaterThanOrEqual(floor);
        }
        expect(
          [...new Set(boxes.flatMap((b) => b.overlaps))],
          `${where}: covers another target`,
        ).toEqual([]);
        await page.evaluate(dropHitBoxRules);
        const before = await page.evaluate(measure, {
          selector: SESSION_LINK,
          neighbours: NEIGHBOURS,
        });
        expect(boxes.map((b) => round(b.holder))).toEqual(before.map((b) => round(b.holder)));
      });
    }
  }
});
