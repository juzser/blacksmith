// Banner — ds-spec.md §2.1 lists only 3 tones (info|warning|danger); the old
// kit's Banner had a 4th, `success`, dropped here to match spec literally.
// New `collapsible?` prop (batch brief, built fresh): reuses kit/IconButton.vue
// with a chevron + a real `label` to toggle slot content, starts expanded.
// Retry uses kit/Button.vue variant="secondary" (new Button has no "outline"
// variant, unlike the old kit's Banner). role="status" aria-live="polite"
// carried over unchanged. Same static source-text style as kitButton.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const BANNER = readFileSync(join(KIT, 'Banner.vue'), 'utf8');

describe('kit/Banner.vue', () => {
  it('declares exactly the 3 spec tones (info|warning|danger), dropping the old success tone', () => {
    expect(BANNER).toMatch(/tone\?:\s*'danger'\s*\|\s*'warning'\s*\|\s*'info'/);
    expect(BANNER).not.toMatch(/'success'/);
  });

  it('declares collapsible as an optional boolean, defaulting to false (starts expanded)', () => {
    expect(BANNER).toMatch(/collapsible\?:\s*boolean/);
  });

  it('keeps retryLabel/showRetry and role="status" aria-live="polite"', () => {
    expect(BANNER).toMatch(/retryLabel\?:\s*string/);
    expect(BANNER).toMatch(/showRetry\?:\s*boolean/);
    expect(BANNER).toMatch(/role="status"/);
    expect(BANNER).toMatch(/aria-live="polite"/);
  });

  it('uses kit/Button.vue variant="secondary" for retry, not the old "outline" variant', () => {
    expect(BANNER).toMatch(/import\s+Button\s+from\s+'\.\/Button\.vue';/);
    expect(BANNER).toMatch(/<Button[^>]*variant="secondary"/);
    expect(BANNER).not.toMatch(/variant="outline"/);
  });

  it('uses kit/Icon.vue with real Lucide tone icons (Info/TriangleAlert/CircleAlert)', () => {
    const importBlock = BANNER.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-vue-next';/)?.[1] ?? '';
    expect(importBlock).toMatch(/\bInfo\b/);
    expect(importBlock).toMatch(/\bTriangleAlert\b/);
    expect(importBlock).toMatch(/\bCircleAlert\b/);
  });

  it('collapse toggle uses kit/IconButton.vue with a real accessible label', () => {
    expect(BANNER).toMatch(/import\s+IconButton\s+from\s+'\.\/IconButton\.vue';/);
    expect(BANNER).toMatch(/<IconButton[^>]*:?label="[^"]+"/);
  });

  it('uses bs-banner class names, not the old ds-banner ones', () => {
    expect(BANNER).toMatch(/class="bs-banner"/);
    expect(BANNER).not.toMatch(/ds-banner/);
  });
});
