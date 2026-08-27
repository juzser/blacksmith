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
// has no authority over the animation clock, and ds-components.css runs
// `ds-pulse` and `ds-ring-pulse` on `infinite` — so a live dot or an agent
// halo was captured at whatever phase the frame happened to land on, and 15 of
// the 48 committed PNGs re-wrote themselves on a no-op run because of it
// (D-235). `animations: 'disabled'` fast-forwards finite animations to their
// end state and cancels infinite ones to their initial state: same pixels
// every run.
export async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    animations: 'disabled',
  });
}
