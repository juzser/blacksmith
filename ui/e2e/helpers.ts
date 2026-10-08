import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';

// Absolute, not CWD-relative — page.screenshot()'s path option resolves
// against process.cwd(), which differs between `pnpm test:e2e` (repo root)
// and running playwright directly from ui/.
const here = path.dirname(fileURLToPath(import.meta.url));
// Phase 6b re-captures every page (design changed — DESIGN.md's Kanban
// cleanup pass, real Roadmap/Task-detail/Lessons/Errors/Analytics/Flow/
// Projects pages) into its own screenshot directory, not overwriting 6a's.
const SCREENSHOT_DIR = path.join(here, '__screenshots__', 'phase-6b');

export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((t) => localStorage.setItem('smith-ui-theme', t), theme);
}

export const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

// Ten of the eleven screenshot blocks used to wait on the page's <h1> and then
// sleep 150ms. The <h1> is a static title — it renders before any /api/ response
// arrives — so that wait was satisfied by the empty state it existed to exclude,
// and the capture was whatever the network happened to deliver inside the sleep.
// No assertion reads the PNG, so a blank page failed nothing: the run stayed
// green and the artifact was worthless. That is D-150, and it is D-147's shape
// with the alarm removed. (Task detail was the exception — its tablist sits
// behind the page's `v-else-if="detail"`, so it was already data-gated.)
//
// So: wait for something only the data can render, and let the sleep do the one
// job a fixed sleep is good for — letting layout settle once the data is in.
export async function settleForShot(page: Page, marker: Locator, settleMs = 150): Promise<void> {
  await expect(marker).toBeVisible();
  await page.waitForTimeout(settleMs);
}

// Every capture goes through here, and every one of them disables animations.
//
// harness.ts pins `Date`; this pins the compositor. `page.clock.setFixedTime`
// has no authority over the animation clock, and bs-primitives.css runs
// `bs-pulse` on `infinite` — so a live dot was captured at whatever phase
// the frame happened to land on, and 15 of the 48 committed PNGs re-wrote
// themselves on a no-op run because of it (D-235). `animations: 'disabled'`
// fast-forwards finite animations to their end state and cancels infinite
// ones to their initial state: same pixels every run.
export async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    animations: 'disabled',
  });
}

// Same capture, scoped to one element rather than the viewport -- for a
// card that needs proving in full when the page around it is taller than
// any fixed viewport (DS8 PR3 fix round 2, item 3: the Running now card).
export async function shootElement(locator: Locator, name: string): Promise<void> {
  await locator.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    animations: 'disabled',
  });
}

// `fullPage: true` scrolls the outer document, but the shell's own scroll
// container is the inner `.app-scroll` div (App.vue) — the outer document
// never grows, so a full-page capture of a tall page was just the viewport's
// worth of content (DS7 PR2 round 3 defect 7). Grow the viewport to
// `.app-scroll`'s scrollHeight instead, so the whole page fits in one frame
// and a plain (non-fullPage) screenshot captures all of it.
//
// `.app-shell` is pinned to `height: 100vh` (bs-primitives.css), so setting
// the viewport to just `.app-scroll`'s scrollHeight still leaves the topbar
// and any banner eating into that budget — `.app-scroll`'s own clientHeight
// shrinks back below its scrollHeight and the bottom of the page (the last
// card's axis, DS7 PR2 round 4 defect 2) stays clipped. Add back the
// "overhead" — whatever `.app-shell__main` spends on siblings of
// `.app-scroll` — so the grown viewport has room for the topbar/banner AND
// the full content height.
export async function growToPageHeight(page: Page): Promise<void> {
  const height = await page.evaluate(() => {
    const scroll = document.querySelector('.app-scroll');
    const main = document.querySelector('.app-shell__main');
    if (scroll && main) {
      const overhead = main.getBoundingClientRect().height - scroll.clientHeight;
      return Math.ceil(overhead + scroll.scrollHeight);
    }
    return document.documentElement.scrollHeight;
  });
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: viewport?.width ?? 1280, height });
}

// A route handler that proxies with route.fetch() may still be mid-fetch when a
// test ends; the page then closes under it and the handler throws "Response has
// been disposed", which the runner charges to the test. Unrouting with
// ignoreErrors does not wait for those handlers and swallows what they throw.
export async function dropRoutes(page: Page): Promise<void> {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
}
