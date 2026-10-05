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
 * - `bs-btn__label` — kit/Button.vue's label span. It inherits the button's
 *   own flex-row text styling and exists only so its `--hidden` modifier can
 *   toggle `visibility` while the loading spinner sits over it; the span
 *   itself carries no rule of its own.
 */
const WRAPPERS_WITHOUT_RULES = ['bs-btn__label'];

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
    expect(defined.has('bs-tag')).toBe(true);
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
