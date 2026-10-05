import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'components',
    'kit',
    'SegmentedControl.vue',
  ),
  'utf8',
);
const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'bs-primitives.css'),
  'utf8',
);

describe('SegmentedControl.vue', () => {
  it('takes a flat items prop of {to, label}, no modelValue/active prop', () => {
    expect(SRC).toMatch(/items:\s*SegmentedControlItem\[\]/);
    expect(SRC).not.toMatch(/modelValue|activeValue/);
  });

  it('renders plain RouterLinks and relies on vue-router for aria-current', () => {
    const template = SRC.slice(SRC.indexOf('<template>'));
    expect(template).toMatch(/<RouterLink[\s\S]*class="bs-segctl__item"[\s\S]*:to="item\.to"/);
    expect(template).not.toMatch(/aria-current=/);
    expect(template).not.toMatch(/tabindex/);
  });
});

describe('.bs-segctl CSS (uiux spec §1)', () => {
  it('has no accent token on the selected item', () => {
    const match = CSS.match(/\.bs-segctl__item\[aria-current='page'\][\s\S]*?\}/);
    expect(match).not.toBeNull();
    expect(match?.[0]).not.toMatch(/--bs-accent/);
    expect(match?.[0]).toMatch(/--bs-surface-selected/);
  });

  it('hides the control at the mobile breakpoint', () => {
    expect(CSS).toMatch(/@media \(max-width: 640px\) \{\s*\.bs-segctl \{\s*display: none;/);
  });

  // Fix round (operator report 2026-10-05): the switch rendered at the
  // --bs-touch (44px) floor, much taller than the toolbar's other small
  // controls (Button sm / Select). ds-spec.md §3.1 scopes the 44px touch
  // floor to <=640px, and .bs-segctl already hides there (above), so
  // dropping it on desktop/tablet is not a touch-target regression.
  it('does not carry the --bs-touch floor on the control or its items', () => {
    const controlMatch = CSS.match(/\.bs-segctl \{[\s\S]*?\}/);
    const itemMatch = CSS.match(/\.bs-segctl__item \{[\s\S]*?\}/);
    expect(controlMatch?.[0]).not.toMatch(/--bs-touch/);
    expect(itemMatch?.[0]).not.toMatch(/--bs-touch/);
  });

  it('sizes items off the mock (ds-review.html .seg): xs text, compact padding', () => {
    const itemMatch = CSS.match(/\.bs-segctl__item \{[\s\S]*?\}/);
    expect(itemMatch?.[0]).toMatch(/font-size: var\(--bs-text-xs\)/);
    expect(itemMatch?.[0]).toMatch(/padding: 2px var\(--bs-space-2\)/);
  });

  it('uses the kit default focus-visible ring, not a component-scoped override', () => {
    const match = CSS.match(/\.bs-segctl__item:focus-visible \{[\s\S]*?\}/);
    expect(match?.[0]).toMatch(
      /box-shadow: 0 0 0 2px color-mix\(in srgb, var\(--bs-focus-ring\) 50%, transparent\);/,
    );
  });
});
