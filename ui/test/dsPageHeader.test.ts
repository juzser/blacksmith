// ds/PageHeader.vue — operator fix: the top bar's crumb already shows the
// page name, so the h1 is sr-only (every ds-spec page's title equals its
// crumb, so no opt-out prop is needed here — see kit/PageHeader.vue for the
// one page that differs).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'ds');
const PAGE_HEADER = readFileSync(join(DS, 'PageHeader.vue'), 'utf8');

describe('ds/PageHeader.vue', () => {
  it('hides the title visually, keeping it for screen readers', () => {
    expect(PAGE_HEADER).toMatch(/<h1 class="ds-ph__title sr-only">/);
  });

  // Fix round 3: the title is always sr-only here (no titleVisible opt-out),
  // so with no description/status/actions the `.ds-ph` wrapper (and its
  // flex-item ancestors) must not stay an in-flow item of the page's gapped
  // stack -- same pattern as kit/PageHeader.vue's isEmpty branch
  // (SessionsPage, TimelinePage).
  it('skips the .ds-ph wrapper entirely when nothing is visible, rendering only the sr-only h1', () => {
    expect(PAGE_HEADER).toMatch(/v-if="!isEmpty"\s+class="ds-ph"/);
    expect(PAGE_HEADER).toMatch(/<h1 v-else class="ds-ph__title sr-only">/);
    expect(PAGE_HEADER).toMatch(
      /isEmpty\s*=\s*computed\(\s*\(\)\s*=>\s*!props\.description\s*&&\s*!slots\.status\s*&&\s*!slots\.actions/,
    );
  });
});
