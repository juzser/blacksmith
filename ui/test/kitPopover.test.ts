// Static source-text check, same style as kitDialog.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const POPOVER = readFileSync(join(KIT, 'Popover.vue'), 'utf8');

describe('kit/Popover.vue', () => {
  it('declares a required open prop and a required label prop', () => {
    expect(POPOVER).toMatch(/open:\s*boolean;/);
    expect(POPOVER).toMatch(/label:\s*string;/);
  });

  it('emits close', () => {
    expect(POPOVER).toMatch(/defineEmits<\{\s*close:\s*\[\];?\s*\}>/);
  });

  it('wires a manual keydown listener rather than useModalFocus (no focus trap on a popover)', () => {
    expect(POPOVER).toMatch(/document\.addEventListener\('keydown',/);
    expect(POPOVER).toMatch(/onBeforeUnmount/);
    expect(POPOVER).not.toMatch(/useModalFocus\(/);
  });

  it('panel carries role=dialog aria-modal=false and the label', () => {
    expect(POPOVER).toMatch(/role="dialog"/);
    expect(POPOVER).toMatch(/aria-modal="false"/);
    expect(POPOVER).toMatch(/:aria-label="label"/);
  });
});
