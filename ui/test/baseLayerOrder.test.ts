// DS9 part A review finding (S2): bs-base.css ports ds-tokens.css's
// `@layer base` element reset into the bs-* kit. Both files declare the
// same layer name, which CSS merges into one layer where the LATER
// source rule wins at equal specificity. main.css must import bs-base.css
// BEFORE ds-tokens.css so ds-tokens.css's base-layer rules keep winning
// while both kits coexist — once DS9 part B deletes ds-tokens.css,
// bs-base.css becomes the only base-layer source and its values take
// over automatically, with no further edit to main.css.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = join(HERE, '..', 'src', 'styles');

describe('bs-base.css stays inert until ds-tokens.css is gone', () => {
  const mainCss = readFileSync(join(STYLES, 'main.css'), 'utf8');

  it('imports bs-base.css before ds-tokens.css in main.css', () => {
    const bsBaseIndex = mainCss.indexOf('@import "./bs-base.css"');
    const dsTokensIndex = mainCss.indexOf('@import "./ds-tokens.css"');
    expect(bsBaseIndex).toBeGreaterThan(-1);
    expect(dsTokensIndex).toBeGreaterThan(-1);
    expect(bsBaseIndex).toBeLessThan(dsTokensIndex);
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
