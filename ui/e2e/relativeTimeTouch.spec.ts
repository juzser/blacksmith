import type { Page } from '@playwright/test';
import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { expect, test } from './harness.js';
import { VIEWPORTS } from './helpers.js';

// Every relative time ("5 min ago") is a tooltip trigger with its own tab stop,
// so on a phone it is a tap target and must reach --bs-touch. The hit box has
// to grow without moving anything: the card or row holding it keeps its height,
// and the bigger box must not sit on top of another target. Three cramped
// phone rows (the timeline meta line, the live card status, a fix row) have no
// room for that box, so their time is plain text there; see the last describes.

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
  top: number;
  overlaps: string[];
}

// Runs in the page: the box of every visible match, the height of the card or
// row holding it, and the other targets whose box it intersects by over 1px.
function measure(args: { selector: string; neighbours: string }): Box[] {
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
      // The top and tab bars sit over whatever scrolls under them; the skip
      // link is parked above the viewport, and a row scrolled up there is not
      // on top of anything a finger can reach.
      if (o.closest('header, nav, .skip-link')) continue;
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
      top: own.top,
      overlaps,
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
function tapMisses(args: { selector: string; sizes?: { w: number; h: number }[] }): {
  sizes: { w: number; h: number }[];
  misses: string[][];
} {
  const sizes: { w: number; h: number }[] = [];
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
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const points: [string, number, number][] = [
      ['left', cx - w / 2 + 2, cy],
      ['right', cx + w / 2 - 2, cy],
      ['top', cx, cy - h / 2 + 2],
      ['bottom', cx, cy + h / 2 - 2],
    ];
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
  return { sizes, misses };
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

// Activity is not here: at phone width every one of its times is plain text.
const PAGES = [
  ['kanban', '/kanban'],
  ['kanban-group', '/work/kanban?scope=all'],
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

// A session's row shows its time as plain text inside the row button, so the
// tooltip times on the page are the selected session's head line ("started
// <time>") and one per agent row in its roster. Select a row whose roster has
// agents and wait for that roster to load, so the count below is not a race.
const ROSTER_TIME = `.bs-sessions__detail-head ${TIME}`;
const DETAIL = '.bs-sessions__detail';
const AGENT_ROW = `${DETAIL} .bs-agentblock__row`;
async function selectSession(page: Page): Promise<number> {
  const rows = page.locator('.bs-sessionrow');
  await expect(rows.first()).toBeVisible();
  const total = await rows.count();
  for (let i = 0; i < total; i++) {
    await rows.nth(i).click();
    await expect(page.locator(ROSTER_TIME)).toHaveCount(1);
    // Settled means the roster rendered: agent rows, or the empty line. A mere
    // missing skeleton can also be the instant before it first renders.
    await expect(page.locator(`${AGENT_ROW}, ${DETAIL} .bs-sessions__quiet`).first()).toBeVisible();
    await expect(page.locator(`${DETAIL} .bs-skeleton`)).toHaveCount(0);
    const agents = await page.locator(AGENT_ROW).count();
    if (agents > 0) return agents;
  }
  throw new Error('no listed session has agents in its roster');
}

// Opens what a page keeps closed until asked.
async function reveal(page: Page, name: string): Promise<void> {
  if (name === 'sessions') {
    await selectSession(page);
    return;
  }
  if (name !== 'kanban-group') return;
  await page.locator('.bs-kanban-group summary').first().click();
  await expect(page.locator('.bs-kanban-group__row-meta time').first()).toBeVisible();
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
        });
        expect(boxes.length).toBeGreaterThan(0);
        // Sessions: the head line's time plus one per agent row are measured, so
        // a time that drops out of the walk (or a row time that grows a tab
        // stop) fails here.
        if (name === 'sessions') {
          const agentRows = await page.locator(AGENT_ROW).count();
          expect(agentRows, 'sessions: agent rows').toBeGreaterThan(0);
          expect(boxes.length, 'sessions: measured times').toBe(1 + agentRows);
        }
        // A hit box wider than the text must not widen the page.
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(0);
        for (const b of boxes) {
          const where = `${name}: a relative time measures ${b.w.toFixed(1)}x${b.h.toFixed(1)}`;
          expect(b.w, `${where}, narrower than --bs-touch`).toBeGreaterThanOrEqual(floor);
          expect(b.h, `${where}, shorter than --bs-touch`).toBeGreaterThanOrEqual(floor);
          // A doubled hit-box rule (e.g. stacked on a card's own) would overshoot.
          expect(b.h, `${where}, taller than one --bs-touch box`).toBeLessThanOrEqual(floor + 1.5);
        }
        expect(
          [...new Set(boxes.flatMap((b) => b.overlaps))],
          `${name}: covers another target`,
        ).toEqual([]);
        // The hit box is an absolutely positioned ::after, so it takes no layout
        // space: with its rules dropped, each trigger's holder height and own top
        // are the same. Both are measured on the same page and font, so this
        // holds on any font, wherever a row happens to wrap.
        await page.evaluate(dropHitBoxRules);
        const before = await page.evaluate(measure, {
          selector: TIME,
          neighbours: NEIGHBOURS,
        });
        expect(boxes.map((b) => round(b.holder))).toEqual(before.map((b) => round(b.holder)));
        expect(boxes.map((b) => round(b.top))).toEqual(before.map((b) => round(b.top)));
      });
    }
  }

  // The width floor comes from a fixed 4px on each side, so it holds only if the
  // narrowest text the formatters can produce is already wide enough.
  for (const font of FONT_VARIANTS) {
    for (const [label, path, selector] of [
      ['card time', '/kanban', TIME],
      ['session roster time', '/sessions', ROSTER_TIME],
    ] as const) {
      test(`${label}: the shortest time texts still reach --bs-touch wide${font.label}`, async ({
        page,
      }) => {
        await page.setViewportSize(VIEWPORTS.mobile);
        await page.goto(path);
        if (font.css) await page.addStyleTag({ content: font.css });
        await expect(page.locator('.bs-skeleton')).toHaveCount(0);
        if (path === '/sessions') await selectSession(page);
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
        const real = await page.evaluate(tapMisses, { selector: TIME });
        expect(real.misses.length).toBeGreaterThan(0);
        if (name === 'sessions') {
          const agentRows = await page.locator(AGENT_ROW).count();
          expect(agentRows, 'sessions: agent rows').toBeGreaterThan(0);
          expect(real.misses.length, 'sessions: tapped times').toBe(1 + agentRows);
        }
        expect(
          real.misses.map((m, i) => (m.length ? `time ${i}: ${m.join(', ')}` : '')).filter(Boolean),
          `${name}: a tap inside a time's box lands elsewhere`,
        ).toEqual([]);
        // Control: without the hit-box rules the same points miss, so the check
        // above cannot pass by accident.
        await page.evaluate(dropHitBoxRules);
        const bare = await page.evaluate(tapMisses, { selector: TIME, sizes: real.sizes });
        const missing = bare.misses.filter((m) => m.length > 0).length;
        expect(missing, `${name}: the control misses for only ${missing} times`).toBeGreaterThan(
          bare.misses.length / 2,
        );
      });
    }
  }

  // A Sessions row is itself a button: nothing focusable may sit inside it, so
  // its time is plain text (no tooltip trigger, no hit box, no tab stop).
  test('sessions: no hit box and no other focusable element inside a row button', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/sessions');
    await expect(page.locator('.bs-skeleton')).toHaveCount(0);
    await expect(page.locator('.bs-sessionrow').first()).toBeVisible();
    const inside = await page.evaluate(
      ({ neighbours }) => {
        const rows = Array.from(document.querySelectorAll('.bs-sessionrow'));
        const found: string[] = [];
        for (const row of rows) {
          for (const e of Array.from(
            row.querySelectorAll(`.bs-reltime, .bs-tooltip-trigger, ${neighbours}`),
          ))
            found.push(`${e.tagName.toLowerCase()}.${String(e.className)}`);
        }
        return { rows: rows.length, found };
      },
      { neighbours: NEIGHBOURS },
    );
    expect(inside.rows).toBeGreaterThan(0);
    expect(inside.found, 'something focusable inside a row button').toEqual([]);
  });

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

// Three phone rows are too cramped for a 44px time box (it would sit on the
// title or copy buttons beside it), so at <=640px their time is plain text: a
// bare <time>, no tooltip, no tab stop. Desktop keeps the tooltip everywhere,
// and the timeline row's expanded phone detail carries the full time instead.
const PLAIN_TIMES = [
  ['timeline meta-line', '/activity', '.bs-timeline-row__meta time'],
  ['live card status', '/overview', '.bs-live-card__status time'],
  ['kanban fix row', '/work/kanban?scope=all', '.bs-kanban-group__row-meta time'],
] as const;

// "30 Sep 2026, 14:07:12": lib/format.ts formatAbsolute, in the page's zone.
function absoluteOf(iso: string): string {
  const d = new Date(iso);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function openPlainPage(page: Page, name: string, path: string, width: 'mobile' | 'desktop') {
  if (path === '/overview') await serveLiveCards(page);
  const key = path.startsWith('/work') ? 'kanban-group' : name;
  await prepare(page, key);
  await page.setViewportSize(VIEWPORTS[width]);
  await page.goto(path);
  await expect(page.locator('.bs-skeleton')).toHaveCount(0);
  if (key === 'kanban-group') await reveal(page, key);
}

test.describe('Phone: three cramped rows show their time as plain text', () => {
  for (const [name, path, selector] of PLAIN_TIMES) {
    test(`${name}: the time has no tooltip trigger, no tab stop, and a tap shows no tooltip`, async ({
      page,
    }) => {
      await openPlainPage(page, name, path, 'mobile');
      const times = page.locator(`${selector}:visible`);
      await expect(times.first()).toBeVisible();
      const found = await page.evaluate((sel) => {
        const out: string[] = [];
        for (const t of Array.from(document.querySelectorAll(sel))) {
          const wrap = t.closest('.bs-tooltip-trigger');
          if (wrap) out.push(`inside ${wrap.className}`);
          if ((t as HTMLElement).tabIndex >= 0) out.push('tab stop on time');
          if (t.parentElement?.closest('.bs-tooltip-trigger, [tabindex]:not([tabindex="-1"])'))
            out.push('focusable ancestor');
        }
        return out;
      }, selector);
      expect(found, `${name}: still a tooltip trigger`).toEqual([]);
      await times.first().click({ force: true });
      await page.waitForTimeout(700);
      await expect(page.getByRole('tooltip')).toHaveCount(0);
    });
  }

  test('activity: an expanded row shows a Time pair with the full time', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto('/activity');
    await expect(page.locator('.bs-skeleton')).toHaveCount(0);
    const chevrons = page.locator('.bs-timeline-row__chevron:visible');
    await expect(chevrons.first()).toBeVisible();
    for (let i = 0; i < Math.min(12, await chevrons.count()); i++) await chevrons.nth(i).click();
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.bs-timeline-row'))
        .filter((li) => li.querySelector('.bs-timeline-row__detail:not([style*="display: none"])'))
        .map((li) => {
          const dts = Array.from(li.querySelectorAll('.bs-timeline-row__detail > dt'));
          const labels = dts.map((d) => d.textContent?.trim() ?? '');
          const at = labels.indexOf('Time');
          const dd = at >= 0 ? dts[at]?.nextElementSibling : null;
          const t = dd?.querySelector('time');
          return {
            labels,
            visible: !!dd && getComputedStyle(dd).display !== 'none',
            shown: dd?.textContent?.trim() ?? null,
            datetime: t?.getAttribute('datetime') ?? null,
            rowTs:
              li
                .querySelector('.bs-timeline-row__body > .bs-timeline-row__meta time')
                ?.getAttribute('datetime') ?? null,
          };
        }),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(
        r.labels.filter((l) => l === 'Time'),
        JSON.stringify(r.labels),
      ).toHaveLength(1);
      expect(r.visible).toBe(true);
      expect(r.datetime).toBe(r.rowTs);
      expect(r.shown).toBe(absoluteOf(r.rowTs ?? ''));
    }
  });
});

test.describe('Desktop: the relative times keep their tooltip, and the detail has no Time pair', () => {
  const DESKTOP_TIMES = [
    ['timeline end-column', '/activity', '.bs-timeline-row__ts'],
    ['live card status', '/overview', '.bs-live-card__status .bs-reltime'],
    ['kanban fix row', '/work/kanban?scope=all', '.bs-kanban-group__row-meta .bs-reltime'],
  ] as const;
  for (const [name, path, selector] of DESKTOP_TIMES) {
    test(`${name}: hovering the time shows the full time`, async ({ page }) => {
      await openPlainPage(page, name, path, 'desktop');
      const trigger = page.locator(`${selector}:visible`).first();
      await expect(trigger).toBeVisible();
      const iso = await trigger.locator('time').getAttribute('datetime');
      await trigger.hover();
      await expect(page.getByRole('tooltip')).toHaveText(absoluteOf(iso ?? ''));
    });
  }

  test('activity: an expanded row has no visible Time pair', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/activity');
    await expect(page.locator('.bs-skeleton')).toHaveCount(0);
    const chevrons = page.locator('.bs-timeline-row__chevron:visible');
    await expect(chevrons.first()).toBeVisible();
    for (let i = 0; i < Math.min(12, await chevrons.count()); i++) await chevrons.nth(i).click();
    await expect(page.locator('.bs-timeline-row__detail:visible').first()).toBeVisible();
    await expect(
      page.locator('.bs-timeline-row__detail dt:visible', { hasText: /^Time$/ }),
    ).toHaveCount(0);
  });
});
