// Separator — direct port of ds/Separator.vue onto bs-* class names (no
// contract change: orientation horizontal|vertical, role="separator",
// aria-orientation). Same static source-text style as kitButton.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const SEPARATOR = readFileSync(join(KIT, 'Separator.vue'), 'utf8');

describe('kit/Separator.vue', () => {
  it('declares orientation as horizontal|vertical, defaulting to horizontal', () => {
    expect(SEPARATOR).toMatch(/orientation\?:\s*'horizontal'\s*\|\s*'vertical'/);
    const match = SEPARATOR.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/orientation:\s*'horizontal'/);
  });

  it('renders role="separator" with a matching aria-orientation', () => {
    expect(SEPARATOR).toMatch(/role="separator"/);
    expect(SEPARATOR).toMatch(/:aria-orientation="orientation"/);
  });

  it('uses bs-sep class names, not the old ds-sep ones', () => {
    expect(SEPARATOR).toMatch(/class="bs-sep"/);
    expect(SEPARATOR).toMatch(/bs-sep--h/);
    expect(SEPARATOR).toMatch(/bs-sep--v/);
    expect(SEPARATOR).not.toMatch(/ds-sep/);
  });
});
