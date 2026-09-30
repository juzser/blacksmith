import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TABBAR = readFileSync(join(KIT, 'MobileTabBar.vue'), 'utf8');

describe('kit/MobileTabBar.vue', () => {
  it('takes items/activeId props and emits select', () => {
    expect(TABBAR).toMatch(/items:\s*NavItem\[\]/);
    expect(TABBAR).toMatch(/defineEmits<\{\s*select:\s*\[id:\s*string\]\s*\}>/);
  });

  it('marks the active tab aria-current="page"', () => {
    expect(TABBAR).toMatch(/:aria-current="it\.id === activeId \? 'page' : undefined"/);
  });

  it('renders icon above label, not an accent colour', () => {
    expect(TABBAR).toMatch(/<Icon :icon="it\.icon" :size="20" \/>/);
    expect(TABBAR).toMatch(/<span class="bs-tabbar__label">{{ it\.label }}<\/span>/);
    expect(TABBAR).not.toMatch(/--bs-accent/);
  });
});
