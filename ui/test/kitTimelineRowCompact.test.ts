// DS6 PR4 (ds-spec.md §2.2 TimelineRow variant table): the `compact`
// variant Home's "Recent activity" uses — title and meta each clamp to one
// line with ellipsis, otherwise identical markup/behaviour to the default
// row. Same DOM-free, source-text contract as kitTimelineRowRail.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TIMELINE_ROW = readFileSync(join(KIT, 'TimelineRow.vue'), 'utf8');

describe('kit/TimelineRow.vue compact variant', () => {
  it('extends the variant prop to accept compact alongside rail', () => {
    expect(TIMELINE_ROW).toMatch(/variant\?:\s*'rail'\s*\|\s*'compact';/);
  });

  it('binds a compact class only when variant is compact', () => {
    expect(TIMELINE_ROW).toMatch(/'bs-timeline-row--compact': variant === 'compact'/);
  });
});
