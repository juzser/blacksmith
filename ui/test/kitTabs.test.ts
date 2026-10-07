// Static source-text check, same style as kitDialog.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TABS = readFileSync(join(KIT, 'Tabs.vue'), 'utf8');
const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib');
const ROVING_TABS = readFileSync(join(LIB, 'rovingTabs.ts'), 'utf8');

describe('kit/Tabs.vue', () => {
  it('exports a TabItem { id, label, count? } interface', () => {
    expect(TABS).toMatch(
      /export interface TabItem\s*\{\s*id:\s*string;\s*label:\s*string;[\s\S]*?count\?:\s*number;\s*\}/,
    );
  });

  it('declares modelValue/tabs/ariaLabel props and an update:modelValue emit', () => {
    expect(TABS).toMatch(/modelValue:\s*string/);
    expect(TABS).toMatch(/tabs:\s*TabItem\[\]/);
    expect(TABS).toMatch(/ariaLabel:\s*string/);
    expect(TABS).toMatch(/'update:modelValue':\s*\[id:\s*string\]/);
  });

  // DS8 PR2: LessonsPage's "Pending review (0)" / "Closed (28)" tabs need a
  // count next to the label, optional so every other Tabs caller (none of
  // which carries one) renders unchanged.
  it('renders the count next to the label when one is present', () => {
    expect(TABS).toMatch(/v-if="tab\.count !== undefined"/);
  });

  // Round 5 item 3: the Left/Right/Home/End key math now lives in
  // lib/rovingTabs.ts, shared with ActivityPage.vue's phone kind filter,
  // rather than duplicated in this component's own onKeydown.
  it('roves tabindex via the shared rovingTabs helper', () => {
    expect(TABS).toMatch(/nextRovingTabId/);
    expect(TABS).toMatch(/:tabindex="modelValue === tab\.id \? 0 : -1"/);
    expect(ROVING_TABS).toMatch(/ArrowRight/);
    expect(ROVING_TABS).toMatch(/ArrowLeft/);
    expect(ROVING_TABS).toMatch(/Home/);
    expect(ROVING_TABS).toMatch(/End/);
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

describe('kit/Tabs.vue outside-selection scroll', () => {
  // scrollIntoView scrolls every scrollable ancestor, the page included, so a
  // selection change while the strip is off-screen would jump the page.
  it('scrolls only its own list, never through scrollIntoView', () => {
    expect(TABS).not.toMatch(/scrollIntoView/);
    expect(TABS).toMatch(/ref="list"/);
  });
});
