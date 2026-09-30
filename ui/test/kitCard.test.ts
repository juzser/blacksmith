// Card — real contract change from the old kit's boolean `padded`: new
// `padding: 'sm'|'md'|'lg'` (default 'md') mapped via --bs-space-* tokens,
// plus a new `interactive?` boolean (hover elevation via --bs-shadow-*,
// cursor: pointer, tabindex="0", :focus-visible ring matching
// .bs-iconbtn/.bs-btn's pattern). Slot structure (title/description props,
// action/footer named slots) is kept unchanged from the old kit. Same
// static source-text style as kitButton.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const CARD = readFileSync(join(KIT, 'Card.vue'), 'utf8');

describe('kit/Card.vue', () => {
  it('declares padding as sm|md|lg defaulting to md, dropping the old boolean padded prop', () => {
    expect(CARD).toMatch(/padding\?:\s*'sm'\s*\|\s*'md'\s*\|\s*'lg'/);
    expect(CARD).toMatch(/padding:\s*'md'/);
    expect(CARD).not.toMatch(/padded/);
  });

  it('declares interactive as an optional boolean, defaulting to false', () => {
    expect(CARD).toMatch(/interactive\?:\s*boolean/);
    expect(CARD).toMatch(/interactive:\s*false/);
  });

  it('keeps title/description props and action/footer named slots', () => {
    expect(CARD).toMatch(/title\?:\s*string/);
    expect(CARD).toMatch(/description\?:\s*string/);
    expect(CARD).toMatch(/<slot name="action"/);
    expect(CARD).toMatch(/<slot name="footer"/);
  });

  it('sets tabindex only when interactive', () => {
    expect(CARD).toMatch(/:tabindex="interactive[^"]*'0'/);
  });

  it('uses bs-card class names, not the old ds-card ones', () => {
    expect(CARD).toMatch(/class="bs-card"/);
    expect(CARD).not.toMatch(/ds-card/);
  });
});
