import { expect, test } from './harness.js';
import { VIEWPORTS } from './helpers.js';

// Shared across e2e specs (taskDetail.spec.ts): demo-hub's smallest fixture
// task with more than a bare "not started" state, so the detail page's tabs
// and actions render for real instead of an empty shell.
const FIXTURE_TASK_ID = 'epic-9/task-3';

const PAGES: Record<string, string> = {
  overview: '/overview',
  sessions: '/sessions',
  timeline: '/timeline',
  kanban: '/kanban',
  roadmap: '/roadmap',
  flow: '/flow',
  lessons: '/lessons',
  errors: '/errors',
  analytics: '/analytics',
  'task detail': `/tasks/${encodeURIComponent(FIXTURE_TASK_ID)}`,
};

const INTERACTIVE_SELECTOR =
  'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="radio"], input, select';

interface Measurement {
  name: string;
  width: number;
  height: number;
  exempt: string | null;
}

/**
 * Runs inside the page so both exemptions can compare an element against a
 * node it builds on the spot, rather than against a hard-coded list of
 * elements that are known to be fine today. WCAG 2.2 SC 2.5.8 names exactly
 * two exceptions to the target-size floor; this project's floor is the
 * larger --bs-touch token, but the exceptions themselves carry over.
 */
function measureInteractiveElements(selector: string): Measurement[] {
  function label(el: Element, index: number): string {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const text = (el.textContent ?? '').trim();
    if (text) return text.slice(0, 40);
    return `${el.tagName.toLowerCase()} #${index}`;
  }

  // "Inline" exception: an <a> left at its default inline display, with real
  // text among its parent's other children, sits inside a sentence — its
  // target is the surrounding line-height, not something this app's CSS
  // chose.
  function isInlineProseLink(el: Element): boolean {
    if (el.tagName.toLowerCase() !== 'a') return false;
    if (getComputedStyle(el).display !== 'inline') return false;
    const parent = el.parentElement;
    if (!parent) return false;
    return Array.from(parent.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
    );
  }

  // "User agent control" exception: build a bare reference node of the same
  // tag/type with no class or inline style, and compare its natural box to
  // the real element's. Equal boxes mean this app never set a size on it at
  // all — the browser alone decided, so there is nothing here to exempt by
  // name.
  function isBrowserSizedControl(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'select') return false;
    const probe = document.createElement(tag);
    if (tag === 'input') {
      (probe as HTMLInputElement).type = (el as HTMLInputElement).type || 'text';
    }
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    const a = el.getBoundingClientRect();
    const b = probe.getBoundingClientRect();
    probe.remove();
    return Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
  }

  const out: Measurement[] = [];
  const els = Array.from(document.querySelectorAll(selector));
  els.forEach((el, index) => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Off-canvas until :focus-visible (the skip link, main.css) is not a
    // target a pointer/touch user can see at all — sighted keyboard use is
    // the only path to it, and 2.5.8 is a pointer-input criterion. This is a
    // visibility check, not a named exemption: anything genuinely off-screen
    // is excluded the same way, by position, not by name.
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
      return;
    }
    let exempt: string | null = null;
    if (isInlineProseLink(el)) {
      exempt = 'inline link inside a sentence of prose (WCAG 2.2 SC 2.5.8 "Inline" exception)';
    } else if (isBrowserSizedControl(el)) {
      exempt =
        'native control this app never sizes; the browser decides its hit area (WCAG 2.2 SC 2.5.8 "User agent control" exception)';
    }
    out.push({ name: label(el, index), width: rect.width, height: rect.height, exempt });
  });
  return out;
}

test.describe('Mobile touch targets meet --bs-touch on every routed page (WCAG 2.2 SC 2.5.8)', () => {
  for (const [name, path] of Object.entries(PAGES)) {
    test(`${name} (${path}): every visible interactive element clears the hit-area floor`, async ({
      page,
    }) => {
      await page.setViewportSize(VIEWPORTS.mobile);
      await page.goto(path);
      await expect(page.locator('.bs-skeleton')).toHaveCount(0);

      // Read the floor from the page rather than hard-coding 44 — a change
      // to the token is a design decision this guard should follow, not
      // fight.
      const touch = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bs-touch')),
      );
      expect(touch).toBeGreaterThan(0);

      const measurements = await page.evaluate(measureInteractiveElements, INTERACTIVE_SELECTOR);
      // Sub-pixel rendering (fractional device-pixel rounding) can report a
      // box a fraction of a px under its CSS value; a tolerance this small
      // only absorbs that, never a real shortfall.
      const floor = touch - 0.5;
      for (const m of measurements) {
        if (m.exempt) continue;
        const where = `${name} (${path}): "${m.name}" measures ${m.width.toFixed(1)}x${m.height.toFixed(1)}`;
        expect(m.width, `${where}, narrower than --bs-touch (${touch}px)`).toBeGreaterThanOrEqual(
          floor,
        );
        expect(m.height, `${where}, shorter than --bs-touch (${touch}px)`).toBeGreaterThanOrEqual(
          floor,
        );
      }
    });
  }
});
