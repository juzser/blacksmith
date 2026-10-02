#!/usr/bin/env node
// Renders one frame of ui/docs/ds-review.html (the binding visual mock, see
// ui/docs/DESIGN.md "Reference") to a PNG, so a visual pass can set an app
// screenshot beside the frame it must match.
//
// A "frame" is a `<h3 id="p-<page>">` heading inside the mock's "Each
// page: before and after" section plus every sibling element up to (not
// including) the next page heading — the before/after notes and the
// example markup together, which is what a reviewer actually compares
// against the app.
//
// Usage:
//   node scripts/design/shoot_mock.mjs <frame-id> <desktop|mobile> <light|dark> <out-dir>
// Example:
//   node scripts/design/shoot_mock.mjs p-home desktop light /tmp/shots
//     -> writes /tmp/shots/mock-home-desktop-light.png
//
// Viewport sizes mirror ui/e2e/helpers.ts VIEWPORTS. Kept in sync by hand:
// this script runs standalone (no TS build), so it cannot import that file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 390, height: 844 },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MOCK_PATH = path.join(here, '..', '..', 'ui', 'docs', 'ds-review.html');

export async function shootFrame(
  { mockPath = DEFAULT_MOCK_PATH, frame, viewport, theme },
  outDir,
) {
  const size = VIEWPORTS[viewport];
  if (!size) {
    throw new Error(`unknown viewport "${viewport}", expected desktop or mobile`);
  }
  if (theme !== 'light' && theme !== 'dark') {
    throw new Error(`unknown theme "${theme}", expected light or dark`);
  }
  // The id names the output file too, so only a plain slug may reach path.join.
  if (!/^p-[a-z0-9-]+$/.test(frame ?? '')) {
    throw new Error(`invalid frame id "${frame}", expected p-<page>`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const pageName = frame.replace(/^p-/, '');
  const outPath = path.join(outDir, `mock-${pageName}-${viewport}-${theme}.png`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: size });
    await page.goto(`file://${mockPath}`);
    await page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
    }, theme);

    const box = await page.evaluate((frameId) => {
      const heading = document.getElementById(frameId);
      if (!heading) return null;
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      const expand = (el) => {
        const r = el.getBoundingClientRect();
        left = Math.min(left, r.left + window.scrollX);
        top = Math.min(top, r.top + window.scrollY);
        right = Math.max(right, r.right + window.scrollX);
        bottom = Math.max(bottom, r.bottom + window.scrollY);
      };
      expand(heading);
      let el = heading.nextElementSibling;
      while (el && !(el.tagName === 'H3' && el.id && el.id.startsWith('p-'))) {
        expand(el);
        el = el.nextElementSibling;
      }
      return { x: left, y: top, width: right - left, height: bottom - top };
    }, frame);

    if (!box) {
      throw new Error(`frame "${frame}" not found in ${mockPath}`);
    }

    // fullPage so `clip` is in document coordinates, not just the current
    // viewport — a frame can run taller than the viewport height.
    await page.screenshot({
      path: outPath,
      fullPage: true,
      clip: box,
    });
    return outPath;
  } finally {
    await browser.close();
  }
}

function parseArgs(argv) {
  const [frame, viewport, theme, outDir] = argv;
  if (!frame || !viewport || !theme || !outDir) {
    throw new Error('usage: shoot_mock.mjs <frame-id> <desktop|mobile> <light|dark> <out-dir>');
  }
  return { frame, viewport, theme, outDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { frame, viewport, theme, outDir } = parseArgs(process.argv.slice(2));
  shootFrame({ frame, viewport, theme }, outDir)
    .then((outPath) => {
      console.log(outPath);
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}
