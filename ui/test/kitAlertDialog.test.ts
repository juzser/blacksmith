// Static source-text check, same style as kitDialog.test.ts — see that
// file's header comment for why (ui/vitest.config.ts is DOM-free, no page
// call site yet).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const ALERT_DIALOG = readFileSync(join(KIT, 'AlertDialog.vue'), 'utf8');

describe('kit/AlertDialog.vue', () => {
  it('declares open/title/confirmLabel/description props, no size or role prop of its own', () => {
    expect(ALERT_DIALOG).toMatch(/open:\s*boolean;/);
    expect(ALERT_DIALOG).toMatch(/title:\s*string;/);
    expect(ALERT_DIALOG).toMatch(/confirmLabel:\s*string;/);
    expect(ALERT_DIALOG).toMatch(/description\?:\s*string/);
  });

  it('wraps Dialog, forcing size="sm" and role="alertdialog"', () => {
    expect(ALERT_DIALOG).toMatch(/import Dialog from '\.\/Dialog\.vue';/);
    expect(ALERT_DIALOG).toMatch(/<Dialog[\s\S]*?size="sm"/);
    expect(ALERT_DIALOG).toMatch(/<Dialog[\s\S]*?role="alertdialog"/);
    expect(ALERT_DIALOG).toMatch(/<Dialog[\s\S]*?:description="description"/);
  });

  it('renders a secondary Cancel and a danger confirm button, both size sm', () => {
    expect(ALERT_DIALOG).toMatch(/<Button variant="secondary" size="sm" @click="emit\('close'\)">/);
    expect(ALERT_DIALOG).toMatch(/<Button variant="danger" size="sm" @click="emit\('confirm'\)">/);
  });

  it('emits close and confirm', () => {
    expect(ALERT_DIALOG).toMatch(/defineEmits<\{\s*close:\s*\[\];\s*confirm:\s*\[\];?\s*\}>/);
  });
});
