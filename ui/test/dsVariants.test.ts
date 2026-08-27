// Every variant a design-system component *declares* must be one it can
// actually *render*. Nothing else in the repo checks this: ui/tsconfig.json
// does not type-check .vue files, biome.json's `files.includes` omits
// ui/src/**/*.vue, and CSS is checked by nothing at all — so a prop union and
// the stylesheet that serves it can drift apart in silence, and a component
// can offer a variant that renders as unstyled text.
//
// These tests derive both sides from source rather than restating either, so
// adding a variant to the union without a rule (or a rule without a union
// member) fails here instead of in front of an operator.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CSS = readFileSync(join(SRC, 'styles', 'ds-components.css'), 'utf8');
const LOZENGE = readFileSync(join(SRC, 'components', 'ds', 'Lozenge.vue'), 'utf8');
const BUTTON = readFileSync(join(SRC, 'components', 'ds', 'Button.vue'), 'utf8');
const TAXONOMY = readFileSync(join(SRC, 'lib', 'taxonomy.ts'), 'utf8');

/** The string literals of a `'a' | 'b'` union, in declaration order. */
function unionMembers(declaration: string): string[] {
  return [...declaration.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

/** `export type X = 'a' | 'b';` → its members. */
function exportedUnion(source: string, name: string): string[] {
  const m = source.match(new RegExp(`export type ${name} = ([^;]+);`));
  if (!m) throw new Error(`no exported type ${name}`);
  return unionMembers(m[1] as string);
}

/** `prop?: 'a' | 'b';` inside a defineProps block → its members. */
function propUnion(sfc: string, prop: string): string[] {
  const m = sfc.match(new RegExp(`\\n\\s*${prop}\\?:\\s*([^;]+);`));
  if (!m) throw new Error(`no prop ${prop}`);
  return unionMembers(m[1] as string);
}

/** The `--modifier` suffixes the stylesheet defines for a block. */
function cssModifiers(block: string): Set<string> {
  return new Set(
    [...CSS.matchAll(new RegExp(`\\.${block}--([a-z-]+)`, 'g'))].map((m) => m[1] as string),
  );
}

describe('Lozenge variants', () => {
  // The union lives in lib/taxonomy.ts, "the single place that mapping lives"
  // per that module's own header. A second copy inside the component is the
  // same fact written twice, and only one of the two copies has a consumer.
  it('takes its variant union from taxonomy.ts rather than re-declaring it', () => {
    expect(LOZENGE).toMatch(
      /import type \{[^}]*\bLozengeVariant\b[^}]*\} from '\.\.\/\.\.\/lib\/taxonomy\.js'/,
    );
    expect(LOZENGE).toMatch(/\n\s*variant\?: LozengeVariant;/);
  });

  // A Lozenge is styled through exactly two channels: the inline `style`
  // computed (which is also the only thing that applies `tone`) and a
  // `.ds-loz--x` rule. A variant served by neither renders as bare text
  // with its tone silently discarded.
  it('renders every declared variant through a style branch or a CSS rule', () => {
    const declared = exportedUnion(TAXONOMY, 'LozengeVariant');
    const styled = new Set(
      [...LOZENGE.matchAll(/props\.variant === '([^']+)'/g)].map((m) => m[1] as string),
    );
    const ruled = cssModifiers('ds-loz');
    const unrendered = declared.filter((v) => !styled.has(v) && !ruled.has(v));
    expect(unrendered).toEqual([]);
  });

  it('defines no .ds-loz-- rule for a variant the union does not declare', () => {
    const declared = new Set(exportedUnion(TAXONOMY, 'LozengeVariant'));
    expect([...cssModifiers('ds-loz')].filter((v) => !declared.has(v))).toEqual([]);
  });
});

describe('Button variants', () => {
  it('defines a CSS rule for every declared variant', () => {
    const ruled = cssModifiers('ds-btn');
    expect(propUnion(BUTTON, 'variant').filter((v) => !ruled.has(v))).toEqual([]);
  });

  // Sizes go through a lookup map, so the class name is not the size name —
  // `default` becomes `ds-btn--default-size`. Check the mapped class exists.
  it('maps every declared size to a class the stylesheet defines', () => {
    const mapped = new Map(
      [...BUTTON.matchAll(/'?([a-z-]+)'?: 'ds-btn--([a-z-]+)',/g)].map((m) => [m[1], m[2]]),
    );
    const ruled = cssModifiers('ds-btn');
    const broken = propUnion(BUTTON, 'size').filter((s) => {
      const cls = mapped.get(s);
      return cls === undefined || !ruled.has(cls);
    });
    expect(broken).toEqual([]);
  });
});
