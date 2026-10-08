import type { Page } from '@playwright/test';
import { FIXTURE_NOW_ISO } from './fixtureClock.js';
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
function measure(args: { selector: string; neighbours: string; exempt: string }): Box[] {
  const out: Box[] = [];
  // The hit box: the bare box, or the ::after centred on it when that grows it.
  const hit = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e, '::after');
    if (cs.content === 'none' || cs.position !== 'absolute') return r;
    const w = Number.parseFloat(cs.width);
    const h = Number.parseFloat(cs.height);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return new DOMRect(cx - w / 2, cy - h / 2, w, h);
  };
  for (const el of Array.from(document.querySelectorAll(args.selector))) {
    const own = el.getBoundingClientRect();
    if (own.width === 0 || own.height === 0) continue;
    const r = hit(el);
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
        const text = (o.getAttribute('aria-label') ?? o.textContent ?? '').trim().slice(0, 30);
        const cls = String(o.className).slice(0, 40);
        overlaps.push(
          `${o.tagName.toLowerCase()}.${cls} "${text}" ${w.toFixed(1)}x${h.toFixed(1)}`,
        );
      }
    }
    out.push({
      w: r.width,
      h: r.height,
      holder: holder?.getBoundingClientRect().height ?? 0,
      overlaps,
      inRow: el.matches(args.exempt),
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
      else if (/^\.bs-reltime(::after)?$|^\.bs-timeline-row__detail a$/.test(r.selectorText))
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
// must not move: the hit box is an absolutely positioned ::after.
const HOLDER_HEIGHTS: Record<string, number[]> = {
  kanban: [102],
  'kanban-group': [272, 60, 61, 61],
  errors: [20, 64],
  activity: [...Array(49).fill(65), 64],
  overview: [65, 65, 65, 65, ...Array(8).fill(40)],
  sessions: [98, 98],
};

// The shortest text each formatter tier can produce (lib/format.ts): "just now",
// the one-digit form of every "… ago" unit, and the one-digit "for …" forms.
const SHORT_TEXTS = [
  'just now',
  '5 s ago',
  '1 min ago',
  '1 h ago',
  '1 d ago',
  '1 w ago',
  '1 mo ago',
  '1 y ago',
  'for 1 min',
  'for 1 h',
  'for 1 d',
  'for 1 w',
  'for 1 mo',
  'for 1 y',
];

// Runs in the page: the width of the first matching trigger with each text set.
function widthsFor(args: { selector: string; texts: string[] }): Record<string, number> {
  const el = document.querySelector(args.selector);
  const time = el?.querySelector('time');
  if (!el || !time) throw new Error(`no time for ${args.selector}`);
  const out: Record<string, number> = {};
  // Same as `hit` in `measure`: a page.evaluate body cannot share a closure.
  const hit = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e, '::after');
    if (cs.content === 'none' || cs.position !== 'absolute') return r;
    const w = Number.parseFloat(cs.width);
    const h = Number.parseFloat(cs.height);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return new DOMRect(cx - w / 2, cy - h / 2, w, h);
  };
  for (const t of args.texts) {
    time.textContent = t;
    out[t] = hit(el).width;
  }
  return out;
}

// Runs in the page: scrolls each time to the middle of the viewport and asks
// which element a tap 2px inside each edge of its hit box would land on.
// `sizes` measures the points of boxes given by `sizes` (the box before the
// rules were dropped) around the element's centre instead of its own box.
function tapMisses(args: {
  selector: string;
  exempt: string;
  sizes?: { w: number; h: number }[];
}): { sizes: { w: number; h: number }[]; exempt: boolean[]; misses: string[][] } {
  const sizes: { w: number; h: number }[] = [];
  const exempt: boolean[] = [];
  const misses: string[][] = [];
  // Same as `hit` in `measure`: a page.evaluate body cannot share a closure.
  const hit = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e, '::after');
    if (cs.content === 'none' || cs.position !== 'absolute') return r;
    const w = Number.parseFloat(cs.width);
    const h = Number.parseFloat(cs.height);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return new DOMRect(cx - w / 2, cy - h / 2, w, h);
  };
  const els = Array.from(document.querySelectorAll(args.selector)).filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  els.forEach((el, i) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = hit(el);
    const w = args.sizes?.[i]?.w ?? r.width;
    const h = args.sizes?.[i]?.h ?? r.height;
    sizes.push({ w: r.width, h: r.height });
    exempt.push(el.matches(args.exempt));
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const points: [string, number, number][] = [
      ['left', cx - w / 2 + 2, cy],
      ['right', cx + w / 2 - 2, cy],
    ];
    if (!el.matches(args.exempt))
      points.push(['top', cx, cy - h / 2 + 2], ['bottom', cx, cy + h / 2 - 2]);
    const missed: string[] = [];
    for (const [side, x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !el.contains(hit)) {
        const name = hit
          ? `${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 40)}`
          : 'nothing';
        missed.push(`${side} -> ${name}`);
      }
    }
    misses.push(missed);
  });
  return { sizes, exempt, misses };
}

// The e2e server's CLI registry is empty, so the live card is served from a stub.
async function serveLiveCards(page: Page): Promise<void> {
  const startedAt = new Date(Date.parse(FIXTURE_NOW_ISO) - 12 * 60_000).toISOString();
  await page.route('**/api/cli-sessions*', (route) =>
    route.fulfill({
      json: {
        state: 'ok',
        configSource: 'default',
        readAt: FIXTURE_NOW_ISO,
        formatWarning: null,
        hidden: { outOfScope: 0, dead: 0, unparsed: 0, nonInteractive: 0 },
        sessions: [
          {
            cliSessionId: 'cli-x',
            name: null,
            cwdLabel: 'workspace-c',
            status: 'working',
            statusSince: startedAt,
            focus: null,
          },
        ],
      },
    }),
  );
}

const EXEMPT =
  '.bs-timeline-row__ts--meta, .bs-live-card__status .bs-reltime, .bs-kanban-group__row-meta .bs-reltime';

const PAGES = [
  ['kanban', '/kanban'],
  ['kanban-group', '/work/kanban?scope=all'],
  ['activity', '/activity'],
  ['errors', '/activity?kind=errors'],
  ['overview', '/overview'],
  ['sessions', '/sessions'],
] as const;

// A follow-up group with short titles, so each row's copy button sits right
// above its time, and the Errors lens with one class card (its "Last seen").
function fixRow(name: string, title: string) {
  return {
    taskId: `epic-a/followup-${name}`,
    taskStatus: 'todo',
    title: `Fix: ${title}`,
    agentRole: null,
    agentModelTier: null,
    agentActivity: null,
    milestoneId: null,
    tags: { case: null, origin: null, severity: null },
    updatedAt: '2026-01-01T00:00:00.000Z',
    project: null,
    attemptCount: 0,
    judgeRound: null,
    commentCount: 0,
    prUrl: null,
    dependencies: [],
    epicLabel: null,
    hasRequest: false,
    requestFirstLine: null,
    parentTaskId: 'epic-a/task-1',
    parentTitle: 'Settings layout',
  };
}

// Stubs the data a page needs, before it loads.
async function prepare(page: Page, name: string): Promise<void> {
  if (name === 'kanban-group')
    await page.route('**/api/kanban*', (route) =>
      route.fulfill({
        json: [
          {
            taskStatus: 'todo',
            tasks: [fixRow('a1', 'Wrap labels'), fixRow('b2', 'ab'), fixRow('c3', 'a')],
          },
        ],
      }),
    );
  if (name === 'errors')
    await page.route('**/api/errors*', (route) =>
      route.fulfill({
        json: {
          byClass: [],
          byDay: [],
          classSummary: [
            {
              id: 'spec.wrong-criterion',
              errorGroup: 'spec',
              errorClass: 'wrong-criterion',
              count: 1,
              severityMix: { 'S4-nit': 1 },
              lastSeen: '2026-01-01T00:00:00.000Z',
              projects: ['project-a'],
              trend7d: [0, 1, 0, 2],
            },
          ],
        },
      }),
    );
}

// Opens what a page keeps closed until asked.
async function reveal(page: Page, name: string): Promise<void> {
  if (name !== 'kanban-group') return;
  await page.locator('.bs-kanban-group summary').first().click();
  await expect(page.locator('.bs-kanban-group__row-meta .bs-reltime').first()).toBeVisible();
}

test.describe('Phone: the relative-time tooltip trigger is a --bs-touch target', () => {
  for (const font of FONT_VARIANTS) {
    for (const [name, path] of PAGES) {
      test(`${name}: every relative time is at least --bs-touch square, moves nothing, covers no target${font.label}`, async ({
        page,
      }) => {
        await prepare(page, name);
        await page.setViewportSize(VIEWPORTS.mobile);
        await page.goto(path);
        if (font.css) await page.addStyleTag({ content: font.css });
        await expect(page.locator('.bs-skeleton')).toHaveCount(0);
        await reveal(page, name);
        await expect(page.locator(`${TIME}:visible`).first()).toBeVisible();
        const floor = await touchFloor(page);
        const boxes = await page.evaluate(measure, {
          selector: TIME,
          neighbours: NEIGHBOURS,
          exempt: EXEMPT,
        });
        expect(boxes.length).toBeGreaterThan(0);
        // A hit box wider than the text must not widen the page.
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(0);
        for (const b of boxes) {
          // Only these three keep their text height (bs-primitives.css): a
          // neighbour's 44px box sits right against each (a row's title button, the
          // live card's head link, a fix row's copy button above and next open
          // button below), so a second 44px box would lie on it. Their width is
          // still a floor.
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

  // The width floor comes from a fixed 4px on each side, so it holds only if the
  // narrowest text the formatters can produce is already wide enough.
  for (const font of FONT_VARIANTS) {
    for (const [label, path, selector] of [
      ['card time', '/kanban', TIME],
      ['session row time', '/sessions', TIME],
      ['live-card time', '/overview', '.bs-live-card__status .bs-reltime'],
      ['meta-line time', '/activity', '.bs-timeline-row__ts--meta'],
    ] as const) {
      test(`${label}: the shortest time texts still reach --bs-touch wide${font.label}`, async ({
        page,
      }) => {
        if (path === '/overview') await serveLiveCards(page);
        await page.setViewportSize(VIEWPORTS.mobile);
        await page.goto(path);
        if (font.css) await page.addStyleTag({ content: font.css });
        await expect(page.locator('.bs-skeleton')).toHaveCount(0);
        await expect(page.locator(`${selector}:visible`).first()).toBeVisible();
        const floor = await touchFloor(page);
        const widths = await page.evaluate(widthsFor, { selector, texts: SHORT_TEXTS });
        console.log(`WIDTHS ${label}${font.label}: ${JSON.stringify(widths)}`);
        const short = Object.entries(widths)
          .filter(([, w]) => w < floor)
          .map(([text, w]) => `"${text}" ${w.toFixed(1)}`);
        expect(short, `${label}: narrower than --bs-touch`).toEqual([]);
      });
    }
  }

  // A tap inside the grown box must land on the time: no ancestor clips it and
  // no later sibling covers it.
  for (const font of FONT_VARIANTS) {
    for (const [name, path] of PAGES) {
      test(`${name}: a tap inside every relative time's hit box lands on it${font.label}`, async ({
        page,
      }) => {
        await prepare(page, name);
        if (path === '/overview') await serveLiveCards(page);
        await page.setViewportSize(VIEWPORTS.mobile);
        await page.goto(path);
        if (font.css) await page.addStyleTag({ content: font.css });
        await expect(page.locator('.bs-skeleton')).toHaveCount(0);
        await reveal(page, name);
        await expect(page.locator(`${TIME}:visible`).first()).toBeVisible();
        const real = await page.evaluate(tapMisses, { selector: TIME, exempt: EXEMPT });
        expect(real.misses.length).toBeGreaterThan(0);
        expect(
          real.misses.map((m, i) => (m.length ? `time ${i}: ${m.join(', ')}` : '')).filter(Boolean),
          `${name}: a tap inside a time's box lands elsewhere`,
        ).toEqual([]);
        // Control: without the hit-box rules the same points miss, so the check
        // above cannot pass by accident. Times with a grown box only: the two
        // exempt ones have no vertical box to lose.
        const grown = real.sizes.filter((_, i) => !real.exempt[i]);
        if (grown.length === 0) return;
        await page.evaluate(dropHitBoxRules);
        const bare = await page.evaluate(tapMisses, {
          selector: `${TIME}:not(${EXEMPT})`,
          exempt: EXEMPT,
          sizes: grown,
        });
        const missing = bare.misses.filter((m) => m.length > 0).length;
        expect(missing, `${name}: the control misses for only ${missing} times`).toBeGreaterThan(
          bare.misses.length / 2,
        );
      });
    }
  }

  // A fix row's copy button sits right above its time. A tap on the lower half
  // of the copy button must stay on the copy button, not open the tooltip.
  for (const font of FONT_VARIANTS) {
    test(`kanban-group: a tap on the lower half of a fix row's copy button lands on it${font.label}`, async ({
      page,
    }) => {
      await prepare(page, 'kanban-group');
      await page.setViewportSize(VIEWPORTS.mobile);
      await page.goto('/work/kanban?scope=all');
      if (font.css) await page.addStyleTag({ content: font.css });
      await expect(page.locator('.bs-skeleton')).toHaveCount(0);
      await reveal(page, 'kanban-group');
      const stolen = await page.evaluate(() => {
        const out: string[] = [];
        const copies = Array.from(document.querySelectorAll('.bs-kanban-group__row-title button'));
        for (const c of copies) {
          c.scrollIntoView({ block: 'center' });
          const r = c.getBoundingClientRect();
          // Every point in the lower half, 2px in from the left, bottom and right.
          for (const [x, y] of [
            [r.left + 2, r.bottom - 2],
            [r.left + r.width / 2, r.bottom - 2],
            [r.right - 2, r.bottom - 2],
            [r.left + 2, r.top + r.height * 0.75],
          ] as const) {
            const hit = document.elementFromPoint(x, y);
            if (!hit || !c.contains(hit)) out.push(`${(hit?.className ?? 'nothing').toString()}`);
          }
        }
        return { copies: copies.length, out };
      });
      expect(stolen.copies).toBeGreaterThanOrEqual(2);
      expect(stolen.out, 'a tap on a copy button lands elsewhere').toEqual([]);
    });
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
          exempt: EXEMPT,
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
          exempt: EXEMPT,
        });
        expect(boxes.map((b) => round(b.holder))).toEqual(before.map((b) => round(b.holder)));
      });
    }
  }
});
