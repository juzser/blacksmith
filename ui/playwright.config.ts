import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// The dev container sets PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers and
// PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, so Playwright's own lookup finds
// nothing there and the executable has to be named outright.
//
// Everywhere else that path is the problem rather than the fix: on CI, macOS
// or WSL, `playwright install chromium` puts the browser in the per-user
// cache, and pointing launchOptions at a file that does not exist turns a
// working browser into "Executable doesn't exist". So the path is used only
// when it is actually there, and otherwise Playwright resolves its own.
const PINNED_CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
// A committed screenshot has to be a pure function of the tree, and Chromium's
// partial raster broke that: tiles carried over from an earlier render came
// back with ~1/255 different antialiasing coverage on the epic-picker
// <select>'s rounded corners. Identical geometry, 11-26 pixels, invisible to
// the eye — and enough to re-write a committed PNG on a no-op run. Measured
// over three consecutive suites: 3-5 of the 48 files drifted per pair without
// this flag, 0 of 48 with it (D-235).
const RASTER_ARGS = ['--disable-partial-raster'];
const launchOptions = existsSync(PINNED_CHROMIUM)
  ? { executablePath: PINNED_CHROMIUM, args: RASTER_ARGS }
  : { args: RASTER_ARGS };

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4681',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions,
      },
    },
  ],
});
