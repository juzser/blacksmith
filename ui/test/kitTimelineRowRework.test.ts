// DS6 PR4b round 2 item 4 (ds-review.html `.ev` grid, ds-spec.md §4.1 1b):
// body / time / chevron end columns, relative time everywhere, phone meta
// line carries the time too. Same DOM-free, source-text contract as
// kitTimelineRowRail.test.ts (ui/vitest.config.ts has no DOM).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TIMELINE_ROW = readFileSync(join(KIT, 'TimelineRow.vue'), 'utf8');
const PRIMITIVES = readFileSync(join(dirname(dirname(KIT)), 'styles', 'bs-primitives.css'), 'utf8');
const TOKENS = readFileSync(join(dirname(dirname(KIT)), 'styles', 'bs-tokens.css'), 'utf8');

describe('kit/TimelineRow.vue row rework (round 2 item 4)', () => {
  it('wraps the head/meta/detail stack in its own body element', () => {
    expect(TIMELINE_ROW).toMatch(/<div class="bs-timeline-row__body">/);
  });

  it("places the chevron as the row's own end column, outside the meta line", () => {
    expect(TIMELINE_ROW).toMatch(
      /<IconButton\s+v-if="hasDetails"\s+class="bs-timeline-row__chevron"/,
    );
  });

  it('carries a second RelativeTime at the end of the meta line for phone', () => {
    expect(TIMELINE_ROW).toMatch(
      /<RelativeTime class="bs-timeline-row__ts bs-timeline-row__ts--meta" :iso="entry\.ts" \/>/,
    );
  });

  it('styles the row as a body/time/chevron grid', () => {
    expect(PRIMITIVES).toMatch(
      /\.bs-timeline-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto\s*auto;/s,
    );
  });

  it('hides the time column and shows the meta-line time on phone', () => {
    expect(PRIMITIVES).toMatch(/\.bs-timeline-row__ts--meta\s*\{\s*display:\s*none;/);
    expect(PRIMITIVES).toMatch(
      /@media \(max-width: 640px\) \{\s*\.bs-timeline-row__ts(?!--meta)[^-][^{]*\{\s*display:\s*none;/s,
    );
  });

  it('sets the title weight to 550 via a token', () => {
    expect(TOKENS).toMatch(/--bs-font-weight-title:\s*550;/);
    expect(PRIMITIVES).toMatch(
      /\.bs-timeline-row__title\s*\{[^}]*font-weight:\s*var\(--bs-font-weight-title\);/s,
    );
  });
});
