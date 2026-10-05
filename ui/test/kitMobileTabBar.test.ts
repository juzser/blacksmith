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
    expect(TABBAR).toMatch(/:aria-current="isActive\(it\) \? 'page' : undefined"/);
  });

  // App.vue's activeId resolves to a level-2 child's own id when on its exact
  // route (Work -> Kanban/Roadmap, operator decision 2026-10-05), so Work's
  // single phone tab must still light up for either of its children's ids,
  // not only its own -- MobileTabBar never renders the children themselves.
  it("stays active for its own id or a child's id, since it never renders children", () => {
    expect(TABBAR).toMatch(
      /function isActive\(it: NavItem\): boolean \{[\s\S]*?it\.children\?\.some/,
    );
  });

  it('renders icon above label, not an accent colour', () => {
    expect(TABBAR).toMatch(/<Icon :icon="it\.icon" :size="20" \/>/);
    expect(TABBAR).not.toMatch(/--bs-accent/);
  });

  it('prefers shortLabel over label, not CSS truncation (ds-spec.md §3)', () => {
    expect(TABBAR).toMatch(
      /<span class="bs-tabbar__label">{{ it\.shortLabel \?\? it\.label }}<\/span>/,
    );
  });
});
