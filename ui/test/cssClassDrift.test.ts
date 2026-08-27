// A class in a template that matches no rule is silent. Nothing in this repo
// checks CSS: ui/tsconfig.json doesn't type-check .vue files, biome.json's
// files.includes omits ui/src/**/*.vue, and there is no component-test
// harness — so a class name can be invented, misspelled, or outlive the rule
// it was written for and the only symptom is an element that quietly renders
// with the browser's defaults. FilterChips' "Clear" button was exactly that
// (D-229): `class="ds-chips__clear"` never matched anything, so Tailwind
// preflight governed it and the control rendered as bare inherited text in a
// row of pill-shaped chips. This is the gate that would have caught it.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const STYLES = join(SRC, 'styles');

/**
 * Root elements whose every child carries the layout, so the wrapper itself
 * legitimately has no rule. Each one was read before being listed here; a
 * name may only join this list with the same evidence.
 *
 * - `cmd-hint` — CommandHint.vue's root. `__list`, `__item`, `__cmd`,
 *   `__desc` and `__note` are all styled; the root only stacks two blocks.
 * - `ds-sh__left` — SectionHeading.vue. Exists to make the title and the
 *   description one flex item, so `.ds-sh`'s space-between pushes the
 *   action slot to the far edge. Grouping is the whole job.
 * - `live-agent-group` — LiveAgentGroupRow.vue's root. `-row` and `-detail`
 *   are both styled, and the detail is already inside `.live-agents-col`'s
 *   flex column (ds-components.css notes this at the `-detail` rule).
 */
const WRAPPERS_WITHOUT_RULES = ['cmd-hint', 'ds-sh__left', 'live-agent-group'];

function vueFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...vueFiles(full));
    else if (entry.name.endsWith('.vue')) out.push(full);
  }
  return out;
}

/** Every class name any rule in the app's three stylesheets selects on. */
function definedClasses(): Set<string> {
  let css = '';
  for (const name of readdirSync(STYLES).sort()) {
    if (name.endsWith('.css')) css += readFileSync(join(STYLES, name), 'utf8');
  }
  // Comments in this file describe rules that were deliberately deleted, by
  // name. Reading them as definitions would let a deleted rule keep vouching
  // for the class that used it.
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set(Array.from(css.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g), (m) => m[1] as string));
}

/**
 * Static `class="…"` only. `:class` bindings are out of scope on purpose: a
 * string literal inside one is as likely to be a comparison operand
 * (`mode === 'sm'`) as a class name, and telling the two apart needs a real
 * expression parser. The lookbehind is what keeps `:class="…"` out — without
 * it the pattern matches the binding too and every operand becomes a false
 * orphan.
 */
function staticClassSites(): Array<{ file: string; token: string }> {
  const sites: Array<{ file: string; token: string }> = [];
  for (const file of vueFiles(SRC)) {
    // Same reason the stylesheet pass drops its comments: a comment that
    // quotes the class it is explaining -- which the fix for D-229 does,
    // right where the orphan used to be -- is documentation, not markup.
    const src = readFileSync(file, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of src.matchAll(/(?<![:\w-])class="([^"]*)"/g)) {
      for (const token of (match[1] as string).split(/\s+/)) {
        if (token) sites.push({ file: file.slice(SRC.length + 1), token });
      }
    }
  }
  return sites;
}

describe('every class a template writes resolves to a rule', () => {
  const defined = definedClasses();
  const sites = staticClassSites();

  it('finds the rules and the call sites at all, so a rename cannot make this vacuous', () => {
    expect(defined.size).toBeGreaterThan(100);
    expect(sites.length).toBeGreaterThan(100);
    expect(defined.has('ds-chip')).toBe(true);
  });

  it('has no orphan class', () => {
    const orphans = sites
      .filter((s) => !defined.has(s.token) && !WRAPPERS_WITHOUT_RULES.includes(s.token))
      .map((s) => `${s.file}: ${s.token}`);
    expect(Array.from(new Set(orphans)).sort()).toEqual([]);
  });

  it('keeps no stale wrapper exemption', () => {
    // An exemption that stops being true — the wrapper gained a rule, or the
    // element is gone — has to be deleted, or the list becomes a place for
    // real orphans to hide.
    const used = new Set(sites.map((s) => s.token));
    for (const name of WRAPPERS_WITHOUT_RULES) {
      expect({ name, used: used.has(name), styled: defined.has(name) }).toEqual({
        name,
        used: true,
        styled: false,
      });
    }
  });
});

describe('FilterChips clears through the Button primitive', () => {
  // The "Clear" affordance is spec'd as a ghost Button (design-spec.md §5.2),
  // and TimelinePage — the one call site — already renders exactly that for
  // its own "Clear filters". A bare <button> here reached the operator with
  // no border, no padding, no pointer cursor and the inherited body font,
  // sitting in a row of small subtle pills (D-229).
  const src = readFileSync(join(SRC, 'components', 'ds', 'FilterChips.vue'), 'utf8');

  it('renders a Button, not a bare element with an invented class', () => {
    expect(src).toContain("import Button from './Button.vue'");
    // `[^>]*` would stop at the `>` inside `v-if="modelValue.length > 0"`.
    expect(src).toMatch(/<Button[\s\S]{0,160}?@click="emit\('clear'\)"/);
    expect(src).not.toMatch(/<button[\s\S]{0,160}?@click="emit\('clear'\)"/);
  });
});
