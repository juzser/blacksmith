import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const SHEET = readFileSync(join(KIT, 'Sheet.vue'), 'utf8');

describe('kit/Sheet.vue', () => {
  it('reuses useModalFocus for the D-238 focus contract', () => {
    expect(SHEET).toMatch(/useModalFocus\(/);
  });

  it('declares aria-modal and a labelled dialog role', () => {
    expect(SHEET).toMatch(/role="dialog"/);
    expect(SHEET).toMatch(/aria-modal="true"/);
    expect(SHEET).toMatch(/aria-label="Navigation"/);
  });

  it('closes via a labelled IconButton, not a bare icon-only button', () => {
    expect(SHEET).toMatch(/<IconButton[^>]*:icon="X"[^>]*label="Close navigation"/);
  });

  it('uses bs-sheet class names, not the old app-sheet ones', () => {
    expect(SHEET).toMatch(/class="bs-sheet-overlay"/);
    expect(SHEET).toMatch(/class="bs-sheet"/);
    expect(SHEET).not.toMatch(/app-sheet/);
  });
});
