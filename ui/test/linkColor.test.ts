// visual-qa phase B round 2: uiPolishR2.test.ts already locks .bs-btn--link
// and the bare `a`/`a:hover` rules in bs-primitives.css to the link tokens
// (ds-spec.md §1.1 lines 126/131), but only those two selectors in that one
// file. This is the general form the brief asks for: no link selector,
// anywhere in ui/src/**/*.css or a .vue <style> block, may colour itself
// from an accent token — accent is reserved for primary actions, not for
// text a reader clicks through.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

// The bs- kit's accent token — the colour the product's primary actions
// get, never a link.
const ACCENT_TOKEN = /var\(--bs-accent(?:-hover|-pressed)?\b/;

interface Rule {
  file: string;
  selector: string;
  body: string;
}

function allFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(full, suffix));
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

/** Flat `selector { body }` pairs. Nesting-free, same as this repo's CSS. */
function parseRules(css: string, file: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorList = match[1];
    const body = match[2];
    if (selectorList === undefined || body === undefined) continue;
    for (const selector of selectorList.split(',')) {
      rules.push({ file, selector: selector.trim(), body });
    }
  }
  return rules;
}

/** A selector that targets a link: the bare `a` tag, or any class/attribute
 * naming "link" (`.bs-btn--link`, `.ds-link`, `a.foo`, `a:hover`, ...). */
function isLinkSelector(selector: string): boolean {
  // Drop pseudo-classes/elements to look at the base selector alone.
  const base = selector.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '');
  if (/(?:^|[\s>+~])a(?:[.#[:]|$)/.test(base)) return true;
  return /link/i.test(base);
}

function collectRules(): Rule[] {
  const rules: Rule[] = [];
  const stylesDir = join(SRC, 'styles');
  for (const file of allFiles(stylesDir, '.css')) {
    rules.push(...parseRules(readFileSync(file, 'utf8'), file.slice(SRC.length + 1)));
  }
  for (const file of allFiles(SRC, '.vue')) {
    const src = readFileSync(file, 'utf8');
    for (const styleBlock of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      const css = styleBlock[1];
      if (css) rules.push(...parseRules(css, file.slice(SRC.length + 1)));
    }
  }
  return rules;
}

describe('no link rule anywhere colours itself from an accent token', () => {
  const rules = collectRules();
  const linkRules = rules.filter((r) => isLinkSelector(r.selector));

  it('finds link selectors at all, so a rename cannot make this vacuous', () => {
    expect(linkRules.length).toBeGreaterThan(0);
    expect(linkRules.some((r) => r.selector === 'a')).toBe(true);
  });

  it('has no link rule whose color comes from an accent token', () => {
    const offenders = linkRules
      .filter((r) => {
        const colorDecl = r.body.match(/(?:^|;)\s*color:\s*([^;]+)/);
        return (
          colorDecl !== undefined && colorDecl !== null && ACCENT_TOKEN.test(colorDecl[1] ?? '')
        );
      })
      .map((r) => `${r.file}: ${r.selector}`);
    expect(offenders).toEqual([]);
  });
});
