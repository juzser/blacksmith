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
});
