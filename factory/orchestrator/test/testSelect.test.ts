import { describe, expect, it } from 'vitest';
import { buildSymbolGraph } from '../src/symbols.js';
import { renderSelectedTestCmd, selectTests, TestSelectError } from '../src/testSelect.js';

function graphOf(files: Record<string, string>) {
  return buildSymbolGraph(new Map(Object.entries(files)));
}

/** A small tree: two features, one shared helper, one test per feature. */
const TREE = {
  'src/shared.ts': 'export const shared = 1;',
  'src/alpha.ts': "import { shared } from './shared.js';\nexport const alpha = shared + 1;",
  'src/beta.ts': 'export const beta = 2;',
  'test/alpha.test.ts': "import { alpha } from '../src/alpha.js';\nexport const a = alpha;",
  'test/beta.test.ts': "import { beta } from '../src/beta.js';\nexport const b = beta;",
};

describe('picking the tests a change can reach', () => {
  it('runs only the test that imports the changed file', () => {
    const selection = selectTests(graphOf(TREE), ['src/beta.ts']);

    expect(selection.status).toBe('selected');
    expect(selection.tests).toEqual(['test/beta.test.ts']);
    expect(selection.allTests).toEqual(['test/alpha.test.ts', 'test/beta.test.ts']);
  });

  it('follows the dependency chain, not just direct importers', () => {
    // Nothing imports shared.ts except alpha.ts, and only alpha's test imports alpha.
    const selection = selectTests(graphOf(TREE), ['src/shared.ts']);

    expect(selection.status).toBe('selected');
    expect(selection.tests).toEqual(['test/alpha.test.ts']);
  });

  it('includes a changed test file itself, even when nothing imports it', () => {
    const selection = selectTests(graphOf(TREE), ['test/beta.test.ts']);

    expect(selection.tests).toEqual(['test/beta.test.ts']);
  });

  it('reports full when the change reaches every test anyway', () => {
    const selection = selectTests(graphOf(TREE), ['src/alpha.ts', 'src/beta.ts']);

    expect(selection.status).toBe('full');
    expect(selection.tests).toEqual(['test/alpha.test.ts', 'test/beta.test.ts']);
    expect(selection.reasons.join(' ')).toMatch(/every test/);
  });
});

describe('what makes it give up and run everything', () => {
  it('falls back when the change is not an analyzable source file', () => {
    const selection = selectTests(graphOf(TREE), ['src/beta.ts', 'package.json']);

    expect(selection.status).toBe('full');
    expect(selection.tests).toEqual(selection.allTests);
    expect(selection.reasons.join(' ')).toContain('package.json');
  });

  it('falls back when a changed file is one the scanner refused to read', () => {
    const graph = graphOf({
      ...TREE,
      // An unterminated template literal is what the scanner marks unanalyzed.
      'src/broken.ts': 'export const x = `unterminated',
    });
    expect(graph.unanalyzed).toContain('src/broken.ts');

    const selection = selectTests(graph, ['src/broken.ts']);

    expect(selection.status).toBe('full');
    expect(selection.reasons.join(' ')).toContain('src/broken.ts');
  });

  it('falls back when the changed file is not in the graph at all', () => {
    const selection = selectTests(graphOf(TREE), ['src/deleted.ts']);

    expect(selection.status).toBe('full');
    expect(selection.reasons.join(' ')).toContain('src/deleted.ts');
  });

  it('falls back when no test reaches the change, because that smells stale', () => {
    const selection = selectTests(graphOf({ ...TREE, 'src/orphan.ts': 'export const o = 1;' }), [
      'src/orphan.ts',
    ]);

    expect(selection.status).toBe('full');
    expect(selection.reasons.join(' ')).toMatch(/no test/);
  });

  it('falls back when the graph knows no tests at all', () => {
    const selection = selectTests(graphOf({ 'src/a.ts': 'export const a = 1;' }), ['src/a.ts']);

    expect(selection.status).toBe('full');
    expect(selection.allTests).toEqual([]);
    expect(selection.reasons.join(' ')).toMatch(/no test files/);
  });

  it('takes an empty change set as a reason to run everything', () => {
    const selection = selectTests(graphOf(TREE), []);

    expect(selection.status).toBe('full');
    expect(selection.tests).toEqual(selection.allTests);
  });
});

describe('the holes the scanner admits to', () => {
  it('keeps a test with a computed dynamic import, which could reach anything', () => {
    const graph = graphOf({
      ...TREE,
      'test/loader.test.ts': 'export async function load(p: string) { await import(p); }',
    });
    expect(graph.modules.get('test/loader.test.ts')?.opaqueImports.length).toBeGreaterThan(0);

    const selection = selectTests(graph, ['src/beta.ts']);

    expect(selection.status).toBe('selected');
    expect(selection.tests).toEqual(['test/beta.test.ts', 'test/loader.test.ts']);
  });

  it('keeps a test whose import specifier never resolved', () => {
    const graph = graphOf({
      ...TREE,
      'test/alias.test.ts': "import { thing } from '../src/missing.js';\nexport const t = thing;",
    });
    expect(graph.unresolved.some((u) => u.from === 'test/alias.test.ts')).toBe(true);

    const selection = selectTests(graph, ['src/beta.ts']);

    expect(selection.tests).toContain('test/alias.test.ts');
  });

  it('walks on through an opaque module to the tests that import it', () => {
    const graph = graphOf({
      'src/registry.ts': 'export async function load(p: string) { await import(p); }',
      'src/beta.ts': 'export const beta = 2;',
      'test/registry.test.ts': "import { load } from '../src/registry.js';\nexport const l = load;",
      'test/other.test.ts': 'export const o = 1;',
    });

    const selection = selectTests(graph, ['src/beta.ts']);

    expect(selection.status).toBe('selected');
    expect(selection.tests).toEqual(['test/registry.test.ts']);
  });
});

describe('naming what counts as a test', () => {
  it('accepts an operator-supplied predicate', () => {
    const graph = graphOf({
      'src/a.ts': 'export const a = 1;',
      'checks/a.check.ts': "import { a } from '../src/a.js';\nexport const c = a;",
      'checks/b.check.ts': 'export const b = 2;',
    });

    const selection = selectTests(graph, ['src/a.ts'], {
      isTestFile: (file) => file.endsWith('.check.ts'),
    });

    expect(selection.status).toBe('selected');
    expect(selection.tests).toEqual(['checks/a.check.ts']);
  });

  it('recognises the usual spec and test suffixes', () => {
    const graph = graphOf({
      'src/a.ts': 'export const a = 1;',
      'src/a.spec.tsx': "import { a } from './a.js';\nexport const s = a;",
      'src/a.test.mts': "import { a } from './a.js';\nexport const t = a;",
      'src/unrelated.spec.js': 'export const u = 1;',
    });

    const selection = selectTests(graph, ['src/a.ts']);

    expect(selection.tests).toEqual(['src/a.spec.tsx', 'src/a.test.mts']);
  });
});

describe('turning a selection into a command', () => {
  it('substitutes the files into the operator template', () => {
    const cmd = renderSelectedTestCmd('pnpm vitest run {files}', [
      'test/a.test.ts',
      'test/b.test.ts',
    ]);

    expect(cmd).toBe("pnpm vitest run 'test/a.test.ts' 'test/b.test.ts'");
  });

  it('quotes a path that would otherwise break the shell', () => {
    const cmd = renderSelectedTestCmd('vitest run {files}', ["test/it's here.test.ts"]);

    expect(cmd).toBe("vitest run 'test/it'\\''s here.test.ts'");
  });

  it('refuses a template with no placeholder, rather than silently running everything', () => {
    expect(() => renderSelectedTestCmd('pnpm test', ['test/a.test.ts'])).toThrow(TestSelectError);
    try {
      renderSelectedTestCmd('pnpm test', ['test/a.test.ts']);
    } catch (err) {
      expect((err as TestSelectError).code).toBe('test-select.no-files-placeholder');
    }
  });

  it('refuses to render an empty selection', () => {
    expect(() => renderSelectedTestCmd('vitest run {files}', [])).toThrow(TestSelectError);
  });
});
