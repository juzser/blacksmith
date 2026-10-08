// BS_E2E_FONT=arial only reaches the pages of a spec whose `test` comes from
// ui/e2e/harness.ts. A spec that takes `test` from Playwright directly, or
// through a helper that re-exports it, would silently skip it, so this fails
// the moment one does.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { babelParse } from 'vue/compiler-sfc';
import { arialSwitchOn } from '../e2e/fontSwitch.js';

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e');

const PLAYWRIGHT = '@playwright/test';

type AnyNode = { type: string; [key: string]: unknown };

/** Every AST node under `root`, comments and locations skipped. */
function* walk(root: unknown): Generator<AnyNode> {
  if (Array.isArray(root)) {
    for (const child of root) yield* walk(child);
    return;
  }
  if (root === null || typeof root !== 'object') return;
  const node = root as AnyNode;
  if (typeof node.type === 'string') yield node;
  for (const [key, child] of Object.entries(node)) {
    if (key === 'loc' || key === 'extra' || key.endsWith('Comments')) continue;
    yield* walk(child);
  }
}

const isIdentifier = (node: unknown, name: string): boolean =>
  (node as AnyNode | null)?.type === 'Identifier' && (node as AnyNode).name === name;

/** `test` itself, or `default`, which @playwright/test also exports `test` as. */
const isTestName = (node: { name: string } | { value: string }): boolean => {
  const name = 'name' in node ? node.name : node.value;
  return name === 'test' || name === 'default';
};

/**
 * What a ui/e2e file (path relative to ui/e2e) does wrong with `test`.
 *
 * 1. No .ts file but harness.ts may take Playwright's `test` as a value: not
 *    by a named, renamed, default or dynamic import, not by a namespace import
 *    and not by re-exporting it (`export { test }`, `export *`). Types and
 *    `expect` stay allowed.
 * 2. A spec that calls `test(` or `test.` imports `test` from ./harness.js.
 *
 * Parsed, not grepped: quotes, line breaks and comments neither hide an
 * import nor fake one.
 */
function e2eTestImportProblems(file: string, src: string): string[] {
  const program = babelParse(src, { sourceType: 'module', plugins: ['typescript'] }).program;
  const problems: string[] = [];
  const flag = (line: number | undefined, how: string) =>
    problems.push(`${file}:${line ?? '?'}: takes test from ${PLAYWRIGHT} (${how})`);

  if (file !== 'harness.ts') {
    for (const stmt of program.body) {
      const line = stmt.loc?.start.line;
      if (stmt.type === 'ImportDeclaration') {
        if (stmt.source.value !== PLAYWRIGHT || stmt.importKind === 'type') continue;
        for (const spec of stmt.specifiers) {
          if (spec.type === 'ImportNamespaceSpecifier') flag(line, 'namespace import');
          else if (spec.type === 'ImportDefaultSpecifier') flag(line, 'default import');
          else if (spec.importKind !== 'type' && isTestName(spec.imported)) flag(line, 'import');
        }
      } else if (stmt.type === 'ExportAllDeclaration') {
        if (stmt.source.value === PLAYWRIGHT && stmt.exportKind !== 'type') flag(line, 'export *');
      } else if (stmt.type === 'ExportNamedDeclaration') {
        if (stmt.source?.value !== PLAYWRIGHT || stmt.exportKind === 'type') continue;
        for (const spec of stmt.specifiers) {
          if (spec.type === 'ExportNamespaceSpecifier') flag(line, 'export * as');
          else if (spec.type === 'ExportSpecifier' && spec.exportKind !== 'type') {
            if (isTestName(spec.local)) flag(line, 're-export');
          }
        }
      }
    }
    for (const node of walk(program.body)) {
      const [arg] = (node.arguments as AnyNode[] | undefined) ?? [];
      if (
        node.type === 'CallExpression' &&
        (node.callee as AnyNode).type === 'Import' &&
        arg?.type === 'StringLiteral' &&
        arg.value === PLAYWRIGHT
      ) {
        flag((node.loc as { start: { line: number } } | undefined)?.start.line, 'dynamic import');
      }
    }
  }

  if (file.endsWith('.spec.ts')) {
    const callsTest = [...walk(program.body)].some(
      (node) =>
        (node.type === 'CallExpression' && isIdentifier(node.callee, 'test')) ||
        (node.type === 'MemberExpression' && isIdentifier(node.object, 'test')),
    );
    const importsHarnessTest = program.body.some(
      (stmt) =>
        stmt.type === 'ImportDeclaration' &&
        stmt.source.value === './harness.js' &&
        stmt.importKind !== 'type' &&
        stmt.specifiers.some(
          (spec) =>
            spec.type === 'ImportSpecifier' &&
            spec.importKind !== 'type' &&
            isIdentifier(spec.imported, 'test') &&
            spec.local.name === 'test',
        ),
    );
    if (callsTest && !importsHarnessTest) {
      problems.push(`${file}: calls test but does not import it from ./harness.js`);
    }
  }
  return problems;
}

describe('BS_E2E_FONT switch', () => {
  it('is off when unset, on for arial, and rejects anything else, empty included', () => {
    expect(arialSwitchOn({})).toBe(false);
    expect(arialSwitchOn({ BS_E2E_FONT: 'arial' })).toBe(true);
    expect(() => arialSwitchOn({ BS_E2E_FONT: '' })).toThrow(
      'BS_E2E_FONT must be unset or "arial", got ""',
    );
    expect(() => arialSwitchOn({ BS_E2E_FONT: 'Arial' })).toThrow(/BS_E2E_FONT/);
    expect(() => arialSwitchOn({ BS_E2E_FONT: 'helvetica' })).toThrow(/"helvetica"/);
  });
});

describe('e2eTestImportProblems', () => {
  const caught: Array<[label: string, file: string, src: string]> = [
    ['a double-quoted import', 'a.spec.ts', 'import { test } from "@playwright/test";\n'],
    [
      'a namespace import',
      'a.spec.ts',
      "import * as pw from '@playwright/test';\npw.test('x', () => {});\n",
    ],
    ['a default import', 'a.spec.ts', "import pw from '@playwright/test';\npw('x', () => {});\n"],
    [
      'a renamed import in a multi-line brace list',
      'a.spec.ts',
      "import {\n  expect,\n  test as pwTest,\n} from '@playwright/test';\n",
    ],
    ['a re-export from a helper', 'shared.ts', "export { test } from '@playwright/test';\n"],
    ['a renamed re-export', 'shared.ts', "export { test as base } from '@playwright/test';\n"],
    ['an export-star', 'shared.ts', "export * from '@playwright/test';\n"],
    ['a namespace re-export', 'shared.ts', "export * as pw from '@playwright/test';\n"],
    [
      'a dynamic import',
      'a.spec.ts',
      "const { test } = await import('@playwright/test');\ntest('x', () => {});\n",
    ],
    [
      'a spec calling test() without the harness import',
      'a.spec.ts',
      "import { test } from './shared.js';\ntest('x', () => {});\n",
    ],
    [
      'a spec calling test.describe() without the harness import',
      'a.spec.ts',
      "test.describe('x', () => {});\n",
    ],
  ];

  const allowed: Array<[label: string, file: string, src: string]> = [
    ['a type-only import', 'a.ts', "import type { Page } from '@playwright/test';\n"],
    [
      'expect with type entries in braces',
      'helpers.ts',
      "import { expect, type Locator, type Page } from '@playwright/test';\n",
    ],
    [
      'an inline type import',
      'a.spec.ts',
      "const f = (page: import('@playwright/test').Page) => page.url();\n",
    ],
    [
      'comments that mention the import',
      'a.spec.ts',
      [
        "import { expect, test } from './harness.js';",
        "// import { test } from '@playwright/test';",
        '/*',
        "import { test } from '@playwright/test';",
        '*/',
        "test('x', () => {});",
        '',
      ].join('\n'),
    ],
    [
      "harness.ts's own `test as base` import",
      'harness.ts',
      "import { test as base } from '@playwright/test';\nexport const test = base.extend({});\n",
    ],
    [
      'a spec that takes test from the harness',
      'a.spec.ts',
      "import { expect, test } from './harness.js';\ntest.describe('x', () => {\n  test('y', () => {});\n});\n",
    ],
  ];

  it.each(caught)('catches %s', (_label, file, src) => {
    expect(e2eTestImportProblems(file, src)).not.toEqual([]);
  });

  it.each(allowed)('allows %s', (_label, file, src) => {
    expect(e2eTestImportProblems(file, src)).toEqual([]);
  });

  it('finds no file in ui/e2e that takes `test` around the harness', async () => {
    const files = (await readdir(e2eDir, { recursive: true })).filter((f) => f.endsWith('.ts'));
    expect(files.filter((f) => f.endsWith('.spec.ts')).length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const file of files) {
      const src = await readFile(path.join(e2eDir, file), 'utf8');
      problems.push(...e2eTestImportProblems(file, src));
    }
    expect(problems, 'import { test } from "./harness.js" instead').toEqual([]);
  });
});
