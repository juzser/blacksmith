// Kanban column count pill fill (UI audit, fix round 1): tone="neutral"
// variant="subtle" paints the count with --bs-tone-neutral-subtle, which
// aliases --bs-surface-sunken — the same token .bs-kanban-col itself uses,
// so the "filled" pill was invisible against its own column. Source-text
// scrape, same style as uiPolishR2.test.ts: these are CSS rules, not
// component behaviour, so there is nothing to mount.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PRIMITIVES_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'bs-primitives.css'),
  'utf8',
);
const TOKENS_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'bs-tokens.css'),
  'utf8',
);

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  const match = css.match(re)?.[1];
  expect(match).toBeTruthy();
  return match ?? '';
}

function tokenValue(block: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const match = block.match(new RegExp(`${escaped}:\\s*([^;]+);`));
  expect(match).toBeTruthy();
  return (match?.[1] ?? '').trim();
}

describe('.bs-kanban-col__count fill (UI audit, fix round 1)', () => {
  const body = rule(PRIMITIVES_CSS, '.bs-kanban-col__count');
  // Strip /* ... */ comments first: the rule body intentionally documents
  // the rejected tokens (--bs-tone-neutral-subtle / --bs-surface-sunken) in
  // prose explaining why they are wrong, so only the live declarations
  // should be asserted on.
  const declarations = body.replace(/\/\*[\s\S]*?\*\//g, '');

  it('overrides the inline Tag background with a token that is not the column surface', () => {
    expect(declarations).toMatch(/background:\s*var\(--bs-border\)\s*!important;/);
    expect(declarations).not.toMatch(/--bs-tone-neutral-subtle/);
    expect(declarations).not.toMatch(/--bs-surface-sunken/);
  });

  it('--bs-border differs from --bs-surface-sunken (the column fill) in both themes', () => {
    const darkIdx = TOKENS_CSS.indexOf(':root.dark {');
    const light = TOKENS_CSS.slice(0, darkIdx);
    const dark = TOKENS_CSS.slice(darkIdx);
    for (const block of [light, dark]) {
      const border = tokenValue(block, '--bs-border');
      const sunken = tokenValue(block, '--bs-surface-sunken');
      expect(border).not.toBe(sunken);
    }
  });
});
