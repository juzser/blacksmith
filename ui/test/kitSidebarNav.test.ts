import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const SIDEBAR = readFileSync(join(KIT, 'SidebarNav.vue'), 'utf8');

describe('kit/SidebarNav.vue', () => {
  it('takes items/activeId/collapsed props and emits select', () => {
    expect(SIDEBAR).toMatch(/items:\s*NavItem\[\]/);
    expect(SIDEBAR).toMatch(/activeId\?:\s*string/);
    expect(SIDEBAR).toMatch(/collapsed\?:\s*boolean/);
    expect(SIDEBAR).toMatch(/defineEmits<\{\s*select:\s*\[id:\s*string\]\s*\}>/);
  });

  it('marks the active item aria-current="page"', () => {
    expect(SIDEBAR).toMatch(/:aria-current="it\.id === activeId \? 'page' : undefined"/);
  });

  it('gives every collapsed item an aria-label since no text remains visible', () => {
    expect(SIDEBAR).toMatch(/:aria-label="it\.label"/);
  });

  it('wraps the collapsed item in a right-placed label Tooltip', () => {
    expect(SIDEBAR).toMatch(
      /<Tooltip v-if="collapsed" mode="label" placement="right" :text="it\.label">/,
    );
  });

  it('uses bs-side class names', () => {
    expect(SIDEBAR).toMatch(/class="bs-side"/);
    expect(SIDEBAR).toMatch(/bs-side__item/);
    expect(SIDEBAR).not.toMatch(/ds-side/);
  });
});
