// DS9 part A review finding (S2): bs-base.css ports ds-tokens.css's
// `@layer base` element reset into the bs-* kit, so when DS9 part B
// deletes the old `ds-` kit the cascade keeps working with no edit to
// main.css. This pins that post-deletion truth: no `ds-` import remains,
// and bs-base.css is the one file importing a base-layer reset.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = join(HERE, '..', 'src', 'styles');

describe('bs-base.css is the only base-layer source', () => {
  const mainCss = readFileSync(join(STYLES, 'main.css'), 'utf8');

  it('imports bs-base.css and no ds-* stylesheet in main.css', () => {
    const bsBaseIndex = mainCss.indexOf('@import "./bs-base.css"');
    expect(bsBaseIndex).toBeGreaterThan(-1);
    expect(mainCss).not.toMatch(/@import\s+["']\.\/ds-/);
  });

  it('bs-tokens.css no longer carries an @layer base element reset', () => {
    const bsTokens = readFileSync(join(STYLES, 'bs-tokens.css'), 'utf8');
    expect(bsTokens).not.toMatch(/@layer\s+base/);
  });

  it('bs-base.css is the one file carrying the ported @layer base reset', () => {
    const bsBase = readFileSync(join(STYLES, 'bs-base.css'), 'utf8');
    expect(bsBase).toMatch(/@layer\s+base/);
    expect(bsBase).toMatch(/background:\s*var\(--bs-surface\)/);
  });
});
