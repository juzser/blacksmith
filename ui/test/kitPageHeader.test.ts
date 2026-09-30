// PageHeader — direct port of ds/PageHeader.vue onto bs-* class names (no
// contract change: title required, description optional, status/actions
// slots). Same static source-text style as kitButton.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const PAGE_HEADER = readFileSync(join(KIT, 'PageHeader.vue'), 'utf8');

describe('kit/PageHeader.vue', () => {
  it('declares title as required and description as optional', () => {
    expect(PAGE_HEADER).toMatch(/title:\s*string/);
    expect(PAGE_HEADER).toMatch(/description\?:\s*string/);
  });

  it('renders the title, an optional description, and status/actions slots', () => {
    expect(PAGE_HEADER).toMatch(/\{\{\s*title\s*\}\}/);
    expect(PAGE_HEADER).toMatch(/v-if="description"/);
    expect(PAGE_HEADER).toMatch(/<slot name="status"/);
    expect(PAGE_HEADER).toMatch(/<slot name="actions"/);
  });

  it('uses bs-ph class names, not the old ds-ph ones', () => {
    expect(PAGE_HEADER).toMatch(/class="bs-ph"/);
    expect(PAGE_HEADER).toMatch(/bs-ph__title/);
    expect(PAGE_HEADER).not.toMatch(/ds-ph/);
  });
});
