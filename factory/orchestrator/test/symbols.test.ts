import { describe, expect, it } from 'vitest';
import {
  buildSymbolGraph,
  maskLiterals,
  parseModuleFacts,
  resolveSpecifier,
} from '../src/symbols.js';

/** The common case, so each test below states only what it is about. */
function facts(source: string, file = 'src/a.ts') {
  return parseModuleFacts(source, file);
}

describe('what the scanner reads', () => {
  it('records the name the target exports, not the name the importer chose', () => {
    const m = facts("import { a as c, b } from './x.js';");
    expect(m.imports).toEqual([
      { specifier: './x.js', resolved: null, names: ['a', 'b'], typeOnly: false, dynamic: false },
    ]);
  });

  it('names a default import "default" and a namespace import "*"', () => {
    expect(facts("import d from './x.js';").imports[0]?.names).toEqual(['default']);
    expect(facts("import * as ns from './x.js';").imports[0]?.names).toEqual(['*']);
    expect(facts("import d, { a } from './x.js';").imports[0]?.names).toEqual(['default', 'a']);
    expect(facts("import d, * as ns from './x.js';").imports[0]?.names).toEqual(['default', '*']);
  });

  it('keeps a side-effect import as an edge that carries no symbol', () => {
    expect(facts("import './register.js';").imports).toEqual([
      { specifier: './register.js', resolved: null, names: [], typeOnly: false, dynamic: false },
    ]);
  });

  it('keeps type-only edges, because a signature change is exactly what breaks them', () => {
    const whole = facts("import type { A } from './x.js';");
    expect(whole.imports[0]).toMatchObject({ names: ['A'], typeOnly: true });
    const inline = facts("import { type A, b } from './x.js';");
    expect(inline.imports[0]).toMatchObject({ names: ['A', 'b'], typeOnly: false });
  });

  it('reads a re-export as both an edge and an export', () => {
    const m = facts("export { a, b as c } from './x.js';");
    expect(m.imports[0]).toMatchObject({ specifier: './x.js', names: ['a', 'b'] });
    expect(m.exports).toEqual(['a', 'c']);
  });

  it('reads a star re-export as the widest edge there is', () => {
    expect(facts("export * from './x.js';").imports[0]?.names).toEqual(['*']);
    expect(facts("export * from './x.js';").exports).toEqual(['*']);
    expect(facts("export * as ns from './x.js';").exports).toEqual(['ns']);
  });

  it('reads a local re-export list without inventing an edge', () => {
    const m = facts('const a = 1;\nexport { a, a as b };');
    expect(m.imports).toEqual([]);
    expect(m.exports).toEqual(['a', 'b']);
  });

  it.each([
    ['export const x = 1;', ['x']],
    ['export const a = 1, b = 2;', ['a', 'b']],
    ['export let y = 1;', ['y']],
    ['export var z = 1;', ['z']],
    ['export function f() {}', ['f']],
    ['export async function g() {}', ['g']],
    ['export class C {}', ['C']],
    ['export abstract class D {}', ['D']],
    ['export interface I {}', ['I']],
    ['export type T = string;', ['T']],
    ['export enum E {}', ['E']],
    ['export declare const q: number;', ['q']],
    ['export default function () {}', ['default']],
    ['export default 41 + 1;', ['default']],
  ])('reads %s', (source, expected) => {
    expect(facts(source).exports).toEqual(expected);
  });

  it('reads a dynamic import as an edge, since it is one', () => {
    const m = facts("async function go() { await import('./late.js'); }");
    expect(m.imports).toEqual([
      { specifier: './late.js', resolved: null, names: ['*'], typeOnly: false, dynamic: true },
    ]);
  });

  it('reports a dynamic import it cannot read rather than dropping it', () => {
    const m = facts('async function go(p) { await import(p); }');
    expect(m.imports).toEqual([]);
    expect(m.opaqueImports).toEqual(['import(p)']);
  });

  it('reports an export whose name it could not extract rather than reporting none', () => {
    const m = facts('export const { a, b } = split();');
    expect(m.exports).toEqual([]);
    expect(m.unreadExports).toEqual(['export const {']);
  });
});

describe('what the scanner refuses to be fooled by', () => {
  it.each([
    ['a line comment', "// import { a } from './fake.js';\nexport const x = 1;", ['x']],
    ['a block comment', "/*\nimport { a } from './fake.js';\n*/\nexport const x = 1;", ['x']],
    ['a string', 'export const s = "import { a } from \'./fake.js\';";', ['s']],
    ['a template literal', "export const s = `import { a } from './fake.js';`;", ['s']],
  ])('ignores an import inside %s', (_name, source, exported) => {
    const m = facts(source);
    expect(m.imports).toEqual([]);
    expect(m.exports).toEqual(exported);
  });

  it('does not read a regex literal as the start of a comment or a string', () => {
    const m = facts(
      "import { a } from './x.js';\nexport const r = /['\"]\\/no/g;\nexport const y = 2;",
    );
    expect(m.imports[0]?.specifier).toBe('./x.js');
    expect(m.exports).toEqual(['r', 'y']);
  });

  it('ignores the word export where it is not a statement', () => {
    const m = facts('const o = { export: 1, import: 2 };\nexport const x = o;');
    expect(m.exports).toEqual(['x']);
  });

  it('masks literal interiors in place, so offsets and line numbers survive', () => {
    const source = "import { a } from './x.js'; // note\nexport const s = 'hi';\n";
    const { masked, unterminated } = maskLiterals(source);
    expect(masked).toHaveLength(source.length);
    expect(masked.split('\n')).toHaveLength(source.split('\n').length);
    expect(masked).toContain("from '      '");
    expect(masked).not.toContain('note');
    expect(unterminated).toBe(false);
  });

  it('says so when a literal never closes, instead of reading the rest as code', () => {
    expect(maskLiterals("const s = 'oops;\n").unterminated).toBe(true);
    expect(maskLiterals('/* never closed\n').unterminated).toBe(true);
  });
});

describe('resolution', () => {
  const inScope = new Set([
    'src/x.ts',
    'src/dir/index.ts',
    'lib/y.ts',
    'src/w.tsx',
    'src/legacy.js',
  ]);

  it.each([
    ['a NodeNext .js specifier onto its .ts source', 'src/a.ts', './x.js', 'src/x.ts'],
    ['an extensionless specifier', 'src/a.ts', './x', 'src/x.ts'],
    ['a parent-relative specifier', 'src/a.ts', '../lib/y.js', 'lib/y.ts'],
    ['a directory onto its index', 'src/a.ts', './dir', 'src/dir/index.ts'],
    ['a directory .js specifier onto its index', 'src/a.ts', './dir/index.js', 'src/dir/index.ts'],
    ['a .tsx source', 'src/a.ts', './w.js', 'src/w.tsx'],
    ['a real .js file when no .ts shadows it', 'src/a.ts', './legacy.js', 'src/legacy.js'],
  ])('resolves %s', (_name, from, specifier, expected) => {
    expect(resolveSpecifier(from, specifier, inScope)).toBe(expected);
  });

  it('follows an import of build output back to the source that emits it', () => {
    const built = new Set(['factory/orchestrator/src/paths.ts']);
    expect(
      resolveSpecifier(
        'ui/server/src/app.ts',
        '../../../factory/orchestrator/dist/paths.js',
        built,
      ),
    ).toBe('factory/orchestrator/src/paths.ts');
  });

  it('leaves a bare specifier alone, because a package is not this repo', () => {
    expect(resolveSpecifier('src/a.ts', 'picomatch', inScope)).toBeNull();
    expect(resolveSpecifier('src/a.ts', 'node:path', inScope)).toBeNull();
  });

  it('does not resolve a relative specifier that names nothing in scope', () => {
    expect(resolveSpecifier('src/a.ts', './missing.js', inScope)).toBeNull();
  });
});

describe('the graph', () => {
  const sources = new Map([
    ['src/a.ts', "import { helper } from './b.js';\nexport const a = helper;"],
    ['src/b.ts', 'export function helper() {}\nexport const unused = 1;'],
    ['src/c.ts', "import type { A } from './a.js';\nexport type C = A;"],
    ['src/d.ts', "import { nope } from 'some-package';\nexport const d = nope;"],
  ]);

  it('indexes who depends on whom, which is the direction the question runs', () => {
    const graph = buildSymbolGraph(sources);
    expect(graph.dependents.get('src/b.ts')).toEqual([
      { from: 'src/a.ts', names: ['helper'], typeOnly: false, specifier: './b.js', dynamic: false },
    ]);
    expect(graph.dependents.get('src/a.ts')).toEqual([
      { from: 'src/c.ts', names: ['A'], typeOnly: true, specifier: './a.js', dynamic: false },
    ]);
    expect(graph.dependents.get('src/c.ts')).toBeUndefined();
  });

  it('keeps the module facts it read', () => {
    const graph = buildSymbolGraph(sources);
    expect(graph.modules.get('src/b.ts')?.exports).toEqual(['helper', 'unused']);
  });

  it('does not call a package edge unresolved, and does call a repo edge that misses one', () => {
    const graph = buildSymbolGraph(
      new Map([['src/d.ts', "import { a } from './gone.js';\nimport { b } from 'pkg';"]]),
    );
    expect(graph.unresolved).toEqual([{ from: 'src/d.ts', specifier: './gone.js' }]);
  });

  it('does not call an asset import unresolved, because assets carry no symbols', () => {
    const graph = buildSymbolGraph(
      new Map([['src/a.ts', "import './styles/main.css';\nimport App from './App.vue';"]]),
    );
    expect(graph.unresolved).toEqual([{ from: 'src/a.ts', specifier: './App.vue' }]);
  });

  it('names the files it could not read rather than reporting them edgeless', () => {
    const graph = buildSymbolGraph(new Map([['src/bad.ts', "const s = 'never closed;\n"]]));
    expect(graph.unanalyzed).toEqual(['src/bad.ts']);
    expect(graph.modules.has('src/bad.ts')).toBe(false);
  });
});
