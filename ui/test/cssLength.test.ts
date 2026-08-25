// Skeleton takes `height` as a template attribute, and a static attribute is
// always a string: `height="240"` reaches the component as '240', never as
// 240. Its `typeof height === 'number'` branch was therefore unreachable from
// every call site in the app, and `height: '240'` is not a CSS length — the
// browser dropped the declaration and every loading skeleton in the product
// rendered at zero height (D-223).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cssLength } from '../src/lib/cssLength.js';

describe('lib/cssLength.ts', () => {
  it('reads a bare number as pixels', () => {
    expect(cssLength(240)).toBe('240px');
  });

  it('reads a numeric string as pixels, because that is what an attribute gives', () => {
    expect(cssLength('240')).toBe('240px');
    expect(cssLength('12.5')).toBe('12.5px');
  });

  it('leaves a length that already carries a unit alone', () => {
    expect(cssLength('28px')).toBe('28px');
    expect(cssLength('40%')).toBe('40%');
    expect(cssLength('var(--ds-space-4)')).toBe('var(--ds-space-4)');
  });

  it('returns undefined for nothing, so the declaration is simply not written', () => {
    expect(cssLength(undefined)).toBeUndefined();
    expect(cssLength('')).toBeUndefined();
    expect(cssLength('   ')).toBeUndefined();
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

function vueFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...vueFiles(full));
    else if (entry.name.endsWith('.vue')) out.push(full);
  }
  return out;
}

describe('every Skeleton in the app asks for a size the browser will honour', () => {
  // .vue templates are read by neither tsc nor biome here, so a size passed
  // in one has no gate on it. This is that gate.
  const A_REAL_LENGTH = /(px|%|r?em|v[hw]|ch|var\(|calc\()/;
  const sites: Array<{ file: string; attr: string; value: string }> = [];
  for (const file of vueFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const tag of src.match(/<Skeleton\b[^>]*\/?>/g) ?? []) {
      for (const [, attr, value] of tag.matchAll(/\s(width|height|radius)="([^"]*)"/g)) {
        // Both groups are unconditional in the pattern, so a match always
        // carries them. The guard is for the type checker, not the regex.
        if (attr === undefined || value === undefined) continue;
        sites.push({ file: file.slice(SRC.length + 1), attr, value });
      }
    }
  }

  it('finds the call sites at all, so a rename cannot make this test vacuous', () => {
    expect(sites.length).toBeGreaterThan(10);
  });

  for (const { file, attr, value } of sites) {
    it(`${file} ${attr}="${value}" resolves to a length`, () => {
      expect(cssLength(value)).toMatch(A_REAL_LENGTH);
    });
  }
});

describe('Skeleton.vue writes its style through the helper', () => {
  it('does not re-implement the coercion in the template', () => {
    const src = readFileSync(join(SRC, 'components', 'hds', 'Skeleton.vue'), 'utf8');
    expect(src).toContain('cssLength');
    expect(src).not.toContain("typeof height === 'number'");
  });
});
