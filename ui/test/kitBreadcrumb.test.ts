// Breadcrumb — port of ds/Breadcrumb.vue, reusing Crumb + useBreadcrumb.js
// unchanged, swapping the old string-icon Icon usage for a real Lucide
// ChevronRight component (kit/Icon.vue's icon prop is a Component, not a
// name string, see kitButton.test.ts's own note on this). Same static
// source-text style as kitButton.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const BREADCRUMB = readFileSync(join(KIT, 'Breadcrumb.vue'), 'utf8');

describe('kit/Breadcrumb.vue', () => {
  it('takes items as a required Crumb[] prop, reusing the existing Crumb type', () => {
    expect(BREADCRUMB).toMatch(
      /import\s*(?:type\s*)?\{\s*Crumb\s*\}\s*from\s*'\.\.\/\.\.\/composables\/useBreadcrumb\.js';/,
    );
    expect(BREADCRUMB).toMatch(/items:\s*Crumb\[\]/);
  });

  it("emits select with the crumb's `to` target", () => {
    expect(BREADCRUMB).toMatch(/defineEmits<\{\s*select:\s*\[to:\s*string\]\s*\}>/);
  });

  it('renders the last crumb as the current page, aria-current="page"', () => {
    expect(BREADCRUMB).toMatch(/aria-current="page"/);
  });

  it('uses a real Lucide ChevronRight component, not the old string icon name', () => {
    expect(BREADCRUMB).toMatch(/import\s*\{\s*ChevronRight\s*\}\s*from\s*'lucide-vue-next';/);
    expect(BREADCRUMB).toMatch(/<Icon[^>]*:icon="ChevronRight"[^>]*:size="14"/);
    expect(BREADCRUMB).not.toMatch(/name="chevron-right"/);
  });

  it('uses bs-crumbs class names, not the old ds-crumbs ones', () => {
    expect(BREADCRUMB).toMatch(/class="bs-crumbs"/);
    expect(BREADCRUMB).toMatch(/bs-crumbs__current/);
    expect(BREADCRUMB).toMatch(/bs-crumbs__link/);
    expect(BREADCRUMB).not.toMatch(/ds-crumbs/);
  });
});
