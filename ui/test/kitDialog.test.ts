// Dialog's a11y contract (ds-spec.md §2.1, WAI-ARIA Dialog pattern): focus
// trap + Esc + inert background + focus restore all live in useModalFocus.ts
// (unit tested separately, DOM-free) — this file is a static source-text
// check, same style as kitTag.test.ts/kitIconButton.test.ts:
// ui/vitest.config.ts is DOM-free by design, and DS0 adds no page call site
// for Dialog (§5), so mounting behaviour is Playwright's job later.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const DIALOG = readFileSync(join(KIT, 'Dialog.vue'), 'utf8');

describe('kit/Dialog.vue', () => {
  it('declares open/title/size/role/description props with the right defaults', () => {
    expect(DIALOG).toMatch(/open:\s*boolean;/);
    expect(DIALOG).toMatch(/title:\s*string;/);
    expect(DIALOG).toMatch(/size\?:\s*'default'\s*\|\s*'sm';/);
    expect(DIALOG).toMatch(/role\?:\s*'dialog'\s*\|\s*'alertdialog';/);
    expect(DIALOG).toMatch(/description\?:\s*string;/);
    const match = DIALOG.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/size:\s*'default'/);
    expect(match?.[1]).toMatch(/role:\s*'dialog'/);
  });

  it('emits close and delegates focus-trap/Esc/inert-background to useModalFocus', () => {
    expect(DIALOG).toMatch(/defineEmits<\{\s*close:\s*\[\];?\s*\}>/);
    expect(DIALOG).toMatch(/useModalFocus\(/);
    expect(DIALOG).toMatch(/from '\.\.\/\.\.\/composables\/useModalFocus\.js'/);
  });

  it('renders via Teleport with the WAI-ARIA dialog role/aria-modal/aria-label/aria-describedby wiring', () => {
    expect(DIALOG).toMatch(/<Teleport to="body">/);
    expect(DIALOG).toMatch(/:role="role"/);
    expect(DIALOG).toMatch(/aria-modal="true"/);
    expect(DIALOG).toMatch(/:aria-label="title"/);
    expect(DIALOG).toMatch(/:aria-describedby="description \? descId : undefined"/);
  });

  it('closes via an IconButton labelled "Close dialog", not a raw <button>+<Icon> pair', () => {
    expect(DIALOG).toMatch(/<IconButton[\s\S]*?label="Close dialog"/);
    expect(DIALOG).not.toMatch(/<Icon\s+name=/);
  });
});
