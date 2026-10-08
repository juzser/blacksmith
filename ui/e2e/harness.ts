// The suite's `test`, with the browser clock pinned.
//
// ./fixtureClock.ts fixes the timeline the fixture writes; this fixes the
// instant the browser reads it from. Both halves are needed: the UI formats
// every elapsed and relative label against `new Date()` (format.ts,
// useNow.ts, liveness.ts's `nowIso` arguments), so a fixed fixture still
// rendered a label that moved a second per run — and the committed
// screenshots moved with it (D-235).
//
// setFixedTime, not install: Date is frozen, but timers keep running, so the
// pages' 5s/15s polls still fire and nothing waits forever on a clock that
// stopped.
import { test as base } from '@playwright/test';
import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { ARIAL_FONT_CSS, arialInit, arialSwitchOn } from './fontSwitch.js';

// `undefined`, not the `void` Playwright's own docs use for a value-less
// fixture: biome's noConfusingVoidType rejects void in that position, and
// nothing reads this fixture's value either way.
//
// `arialFont` is the BS_E2E_FONT=arial switch (./fontSwitch.ts). It adds the
// style to the *context*, so it reaches every page the context opens (popups
// included) and is re-run on each navigation and reload, before the page's
// own scripts. The product build is untouched.
export const test = base.extend<{ pinnedClock: undefined; arialFont: undefined }>({
  arialFont: [
    async ({ context }, use) => {
      if (arialSwitchOn()) {
        await context.addInitScript(arialInit, ARIAL_FONT_CSS);
      }
      await use(undefined);
    },
    { auto: true },
  ],
  pinnedClock: [
    async ({ page }, use) => {
      await page.clock.setFixedTime(new Date(FIXTURE_NOW_ISO));
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect, type Locator, type Page } from '@playwright/test';
