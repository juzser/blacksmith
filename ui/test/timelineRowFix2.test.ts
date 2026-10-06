// DS6 PR4b fix round 2 (ds-review.html `.mrow.tlrow .mm`, `.mrow` min-height):
// same DOM-free, source-text contract as kitTimelineRowRework.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TIMELINE_ROW = readFileSync(join(KIT, 'TimelineRow.vue'), 'utf8');
const PRIMITIVES = readFileSync(join(dirname(dirname(KIT)), 'styles', 'bs-primitives.css'), 'utf8');

describe('kit/TimelineRow.vue fix round 2 item 1 (every phone row shows its time once)', () => {
  it('renders a time-only meta line when the row has no details', () => {
    expect(TIMELINE_ROW).toMatch(
      /<div v-else class="bs-timeline-row__meta">\s*<RelativeTime class="bs-timeline-row__ts bs-timeline-row__ts--meta" :iso="entry\.ts" \/>\s*<\/div>/,
    );
  });
});

describe('kit/TimelineRow.vue fix round 2 item 4 (row height matches the mock .mrow)', () => {
  it('reserves the mock min-height and padding on phone', () => {
    expect(PRIMITIVES).toMatch(
      /@media \(max-width: 640px\) \{[^}]*\.bs-timeline-row \{[^}]*min-height:\s*var\(--bs-touch\);[^}]*padding:\s*10px var\(--bs-m-card-pad\);/s,
    );
  });
});

describe('kit/TimelineRow.vue phone tag order (status tag after title and kind tag)', () => {
  it('puts the status class on the status Tag', () => {
    expect(TIMELINE_ROW).toMatch(/<Tag v-if="statusTag"[^>]*class="bs-timeline-row__status"/);
  });
  it('orders it after the kind tag on phone', () => {
    expect(PRIMITIVES).toMatch(
      /@media \(max-width: 640px\) \{[^}]*\.bs-event-kind-tag \{\s*order: 2;[^@]*\.bs-timeline-row__head \.bs-timeline-row__status \{\s*order: 3;/s,
    );
  });
});
