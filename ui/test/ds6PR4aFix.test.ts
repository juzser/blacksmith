// DS6 PR4a fix round (visual-pass + review findings). Source-text/CSS-rule
// scrape, same DOM-free convention as roadmapMobileCss.test.ts and
// kitTimelineRowCompact.test.ts — this vitest config has no DOM harness;
// Playwright covers the rendered result.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CSS = readFileSync(join(ROOT, 'styles', 'bs-primitives.css'), 'utf8');
const TASK_DETAIL = readFileSync(join(ROOT, 'pages', 'TaskDetailPage.vue'), 'utf8');
const HOME = readFileSync(join(ROOT, 'pages', 'HomePage.vue'), 'utf8');
const ACTIVITY = readFileSync(join(ROOT, 'pages', 'ActivityPage.vue'), 'utf8');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('item 1 — totals bar box ports ds-review.html .totals', () => {
  it('is a bordered sunken 3-column grid with dividers', () => {
    const decl = rule('.bs-task-totals-bar');
    expect(decl).toMatch(/display:\s*grid/);
    expect(decl).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(decl).toMatch(/border:\s*1px solid var\(--bs-border\)/);
    expect(decl).toMatch(/background:\s*var\(--bs-surface-sunken\)/);
  });

  it('gives each cell after the first a left divider', () => {
    expect(CSS).toMatch(
      /\.bs-task-totals-bar__cell \+ \.bs-task-totals-bar__cell\s*\{[^}]*border-left:\s*1px solid var\(--bs-border\)/,
    );
  });

  it('keys are 11px/500, values are 400 weight', () => {
    const key = rule('.bs-task-totals-bar__key');
    expect(key).toMatch(/font-size:\s*11px/);
    expect(key).toMatch(/font-weight:\s*var\(--bs-font-weight-medium\)/);
    const value = rule('.bs-task-totals-bar__value');
    expect(value).toMatch(/font-weight:\s*var\(--bs-font-weight-normal\)/);
  });
});

describe('item 2+3 — totals bar a11y and tooltip-on-value-only', () => {
  it('uses a role=group container, not a dl', () => {
    expect(TASK_DETAIL).toMatch(
      /<div v-if="totalsCells\.length > 0" class="bs-task-totals-bar" role="group" aria-label="Task totals">/,
    );
  });

  it('wraps only the value in Tooltip, not the whole cell', () => {
    expect(TASK_DETAIL).toMatch(
      /<div class="bs-task-totals-bar__value">\s*<Tooltip mode="describe" :text="cell\.exact">/,
    );
    // the label/icon line sits outside the Tooltip
    expect(TASK_DETAIL).toMatch(/<div class="bs-task-totals-bar__key">\s*<Icon :icon="cell\.icon"/);
  });
});

describe('item 4 — compact title ellipsis at <=640px', () => {
  it('wraps the title--link label in an inner span carrying the ellipsis', () => {
    // the link itself stays inline-flex (touch target), but it is no longer
    // the element text-overflow applies to -- that moves to an inner span.
    expect(CSS).toMatch(/\.bs-timeline-row__title-label\s*\{[^}]*overflow:\s*hidden/);
    expect(CSS).toMatch(/\.bs-timeline-row__title-label\s*\{[^}]*text-overflow:\s*ellipsis/);
  });
});

describe('item 5 — last timeline row drops its border', () => {
  it('zeroes border-bottom on :last-child', () => {
    expect(rule('.bs-timeline-row:last-child')).toMatch(/border-bottom:\s*0/);
  });
});

describe('item 6 — Home recent-activity section head', () => {
  it('gives the header space-4 margin-bottom', () => {
    expect(rule('.bs-home__section-head')).toMatch(/margin-bottom:\s*var\(--bs-space-4\)/);
  });

  it('flushes "View all activity" to the edge against its own sm padding', () => {
    expect(CSS).toMatch(
      /\.bs-home__section-head > \.bs-btn--sm\s*\{[^}]*margin-right:\s*calc\(-1 \* var\(--bs-space-2\)\)/,
    );
  });
});

describe('item 7 — because-of wiring (shared helper, not a no-op)', () => {
  it('Home no longer passes a no-op handler', () => {
    expect(HOME).not.toMatch(/@because-of="\(\) => \{\}"/);
    expect(HOME).toMatch(/@because-of="becauseOf"/);
  });

  it('both pages import the shared scroll helper', () => {
    expect(HOME).toMatch(/import \{ scrollToTimelineRow \} from '..\/lib\/scrollToRow\.js';/);
    expect(ACTIVITY).toMatch(/import \{ scrollToTimelineRow \} from '..\/lib\/scrollToRow\.js';/);
  });

  it('Home highlights the scrolled-to row the same way Activity does', () => {
    expect(HOME).toMatch(/'bs-timeline-row--highlight':\s*highlighted === entry\.eventId/);
  });
});

describe('highlighted timeline row keeps its background', () => {
  it('paints the row Activity and Home mark with .bs-timeline-row--highlight', () => {
    expect(ACTIVITY).toContain('bs-timeline-row--highlight');
    expect(HOME).toContain('bs-timeline-row--highlight');
    expect(rule('.bs-timeline-row--highlight')).toMatch(/background:\s*var\(--bs-accent-subtle\)/);
  });
});
