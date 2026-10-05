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
    expect(SIDEBAR).toMatch(/:aria-current="currentFor\(it\)"/);
    expect(SIDEBAR).toMatch(/if \(it\.id === props\.activeId\) return 'page';/);
  });

  it('gives every collapsed item an aria-label since no text remains visible', () => {
    expect(SIDEBAR).toMatch(/:aria-label="it\.label"/);
  });

  it('wraps the collapsed item in a right-placed label Tooltip', () => {
    expect(SIDEBAR).toMatch(
      /<Tooltip v-if="effectiveCollapsed" mode="label" placement="right" :text="it\.label">/,
    );
  });

  it('uses bs-side class names', () => {
    expect(SIDEBAR).toMatch(/class="bs-side"/);
    expect(SIDEBAR).toMatch(/bs-side__item/);
    expect(SIDEBAR).not.toMatch(/ds-side/);
  });

  it('manual collapse toggle (ds-spec.md §3): effective collapsed is prop OR manual', () => {
    expect(SIDEBAR).toMatch(
      /const effectiveCollapsed = computed\(\(\) => props\.collapsed \|\| manualCollapsed\.value\)/,
    );
  });

  it('only offers the toggle at >=1024px, where the viewport is not already forcing collapse', () => {
    expect(SIDEBAR).toMatch(/<IconButton\s+v-if="!collapsed && showCollapseToggle"/);
  });

  it("the off-canvas Sheet copy can opt out of the toggle: it has no icon-only state to toggle, and a focusable IconButton there would eat the Sheet's first Escape via its own focus-visible tooltip", () => {
    expect(SIDEBAR).toMatch(/showCollapseToggle\?:\s*boolean/);
    expect(SIDEBAR).toMatch(/showCollapseToggle:\s*true/);
  });

  it('flips icon and label between Collapse sidebar and Expand sidebar', () => {
    expect(SIDEBAR).toMatch(/:icon="effectiveCollapsed \? PanelLeftOpen : PanelLeftClose"/);
    expect(SIDEBAR).toMatch(/:label="effectiveCollapsed \? 'Expand sidebar' : 'Collapse sidebar'"/);
  });

  it('persists the manual choice to localStorage, wrapped in try/catch', () => {
    expect(SIDEBAR).toMatch(/try\s*\{\s*localStorage\.setItem/);
    expect(SIDEBAR).toMatch(/try\s*\{[^}]*localStorage\.getItem/);
    // Both reachable code paths land in a catch, not an unguarded throw.
    expect((SIDEBAR.match(/catch/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  // Operator decision 2026-10-05: Work's level-2 items (Kanban, Roadmap)
  // render on demand -- only while Work's own section is current -- rather
  // than on every page.
  describe('level-2 items under a parent (operator decision 2026-10-05)', () => {
    it('renders a child list only when the rail is not collapsed and the section is current', () => {
      expect(SIDEBAR).toMatch(
        /<ul\s+v-if="!effectiveCollapsed && it\.children\?\.length && currentFor\(it\)"\s+class="bs-side__sublist"/,
      );
    });

    it('gives each child its own aria-current and a select emit', () => {
      expect(SIDEBAR).toMatch(/:aria-current="child\.id === activeId \? 'page' : undefined"/);
      expect(SIDEBAR).toMatch(/@click="emit\('select', child\.id\)"/);
      expect(SIDEBAR).toMatch(/class="bs-side__subitem"/);
    });

    // Visual pass 2026-10-05: parent and child both at aria-current="page"
    // drew one fused highlight. The child is the page; the parent is only
    // the current section, so it reads "true" and gets no fill.
    it('the parent reads aria-current="true", not "page", while a child is active', () => {
      expect(SIDEBAR).toMatch(
        /function currentFor\(it: NavItem\)[\s\S]*?it\.children\?\.some\(\(c\) => c\.id === props\.activeId\)\)\s*return effectiveCollapsed\.value \? 'page' : 'true';/,
      );
    });
  });
});
