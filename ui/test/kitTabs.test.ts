// Static source-text check, same style as kitDialog.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TABS = readFileSync(join(KIT, 'Tabs.vue'), 'utf8');

describe('kit/Tabs.vue', () => {
  it('exports a TabItem { id, label } interface', () => {
    expect(TABS).toMatch(/export interface TabItem\s*\{\s*id:\s*string;\s*label:\s*string;\s*\}/);
  });

  it('declares modelValue/tabs/ariaLabel props and an update:modelValue emit', () => {
    expect(TABS).toMatch(/modelValue:\s*string/);
    expect(TABS).toMatch(/tabs:\s*TabItem\[\]/);
    expect(TABS).toMatch(/ariaLabel:\s*string/);
    expect(TABS).toMatch(/'update:modelValue':\s*\[id:\s*string\]/);
  });

  it('roves tabindex and handles ArrowLeft/ArrowRight/Home/End', () => {
    expect(TABS).toMatch(/ArrowRight/);
    expect(TABS).toMatch(/ArrowLeft/);
    expect(TABS).toMatch(/Home/);
    expect(TABS).toMatch(/End/);
    expect(TABS).toMatch(/:tabindex="modelValue === tab\.id \? 0 : -1"/);
  });

  it('wires role=tablist/tab/tabpanel and aria-selected/aria-controls/aria-labelledby, panel uses v-show', () => {
    expect(TABS).toMatch(/role="tablist"/);
    expect(TABS).toMatch(/role="tab"/);
    expect(TABS).toMatch(/role="tabpanel"/);
    expect(TABS).toMatch(/:aria-selected="modelValue === tab\.id"/);
    expect(TABS).toMatch(/:aria-controls="`panel-\$\{tab\.id\}`"/);
    expect(TABS).toMatch(/:aria-labelledby="`tab-\$\{tab\.id\}`"/);
    expect(TABS).toMatch(/v-show="modelValue === tab\.id"/);
    expect(TABS).not.toMatch(/v-if="modelValue === tab\.id"/);
  });
});
