/**
 * Running every test on every merge is honest and slow. This narrows it.
 *
 * The serial merge queue rebases each task onto the integration branch and
 * runs the operator's whole test command before merging. That is correct and
 * it is quadratic: N tasks, each paying for the full cumulative suite. The
 * graph `symbols.ts` already builds answers a cheaper question — which tests
 * can even reach this change — by walking `dependents` (imported file -> its
 * importers) out from the changed files until the frontier stops growing.
 *
 * The whole value of a test gate is that it fails when the code is wrong, so
 * every ambiguity here resolves to running everything:
 *
 * - a changed file the scanner cannot read, or has never seen, or that is not
 *   source at all (a `.yml`, a lockfile, a fixture) can affect anything;
 * - a change no test reaches is more likely a stale graph than a change with
 *   no coverage, and guessing wrong means merging untested code;
 * - a module with a computed `import()` or an import that never resolved is
 *   treated as reached by every change, because the scanner cannot prove it
 *   is not. That keeps one opaque module from collapsing the whole selection
 *   to `full`, while still never dropping the test that module lives in.
 *
 * Two things this deliberately does NOT do. It never narrows a typecheck —
 * `tsc -p` is a whole-program question and a subset of files is a different,
 * weaker question. And it never invents the command: the operator supplies a
 * template with a `{files}` placeholder, and a template without one is an
 * error rather than a silent full run reported as a selective one.
 */

import { extname } from 'node:path';
import { SmithError } from './errors.js';
import { DEFAULT_SOURCE_EXTENSIONS, type SymbolGraph } from './symbols.js';

export class TestSelectError extends SmithError {}

/** `foo.test.ts`, `foo.spec.tsx`, `foo.test.mjs` — the conventional shapes. */
const DEFAULT_TEST_PATTERN = /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/;

export interface TestSelectOptions {
  /** Override what counts as a test file. Default: the `.test.`/`.spec.` shapes. */
  isTestFile?: (file: string) => boolean;
}

export type TestSelectStatus = 'selected' | 'full';

export interface TestSelection {
  /** `selected` means `tests` is a strict, non-empty subset of `allTests`. */
  status: TestSelectStatus;
  /** The tests to run. Equal to `allTests` whenever status is `full`. */
  tests: string[];
  /** Every test file the graph knows about. */
  allTests: string[];
  /** Operator-readable, one line per thing that shaped the answer. */
  reasons: string[];
}

function isTest(file: string, options: TestSelectOptions): boolean {
  return options.isTestFile ? options.isTestFile(file) : DEFAULT_TEST_PATTERN.test(file);
}

/** Modules the scanner admits it cannot fully see through. */
function alwaysReached(graph: SymbolGraph): Set<string> {
  const opaque = new Set<string>();
  for (const [file, facts] of graph.modules) {
    if (facts.opaqueImports.length > 0) opaque.add(file);
  }
  for (const { from } of graph.unresolved) opaque.add(from);
  return opaque;
}

/**
 * Which tests can reach `changedFiles`, or `full` with the reason it gave up.
 * Pure: the graph and the change set come from the caller.
 */
export function selectTests(
  graph: SymbolGraph,
  changedFiles: readonly string[],
  options: TestSelectOptions = {},
): TestSelection {
  const allTests = [...graph.modules.keys()].filter((file) => isTest(file, options)).sort();
  const full = (reason: string): TestSelection => ({
    status: 'full',
    tests: allTests,
    allTests,
    reasons: [reason],
  });

  if (allTests.length === 0) return full('the symbol graph knows no test files');
  if (changedFiles.length === 0) return full('no changed files were reported');

  const sourceExtensions = new Set<string>(DEFAULT_SOURCE_EXTENSIONS);
  const unanalyzed = new Set(graph.unanalyzed);
  for (const file of changedFiles) {
    if (!sourceExtensions.has(extname(file))) {
      return full(`${file} is not an analyzable source file, so it could affect any test`);
    }
    if (unanalyzed.has(file)) {
      return full(`${file} is a file the scanner refused to read`);
    }
    if (!graph.modules.has(file)) {
      return full(`${file} is not in the symbol graph`);
    }
  }

  const reasons: string[] = [];
  const opaque = alwaysReached(graph);
  if (opaque.size > 0) {
    reasons.push(
      `${opaque.size} module(s) with a computed import or an unresolved specifier are treated as reached`,
    );
  }

  const reached = new Set<string>();
  const frontier = [...changedFiles, ...opaque];
  while (frontier.length > 0) {
    const file = frontier.pop();
    if (file === undefined || reached.has(file)) continue;
    reached.add(file);
    for (const edge of graph.dependents.get(file) ?? []) {
      if (!reached.has(edge.from)) frontier.push(edge.from);
    }
  }

  const tests = [...reached].filter((file) => isTest(file, options)).sort();
  if (tests.length === 0) {
    return full('no test reaches the change, which is more likely a stale graph than a gap');
  }
  if (tests.length >= allTests.length) {
    return full('every test is reachable from the change');
  }

  reasons.unshift(`${tests.length} of ${allTests.length} tests can reach the change`);
  return { status: 'selected', tests, allTests, reasons };
}

/** POSIX single-quoting: the only string a shell will not reinterpret. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

const FILES_PLACEHOLDER = '{files}';

/**
 * Reject a template with no placeholder. Called once at the CLI boundary so an
 * unusable template fails before any git runs, and again at render time: that
 * would run the full suite while the report said `selected`, which is the one
 * failure mode this module must not have.
 */
export function assertSelectableTestCmd(template: string): void {
  if (!template.includes(FILES_PLACEHOLDER)) {
    throw new TestSelectError(
      'test-select.no-files-placeholder',
      `select test command has no ${FILES_PLACEHOLDER} placeholder: ${template}`,
      { template },
    );
  }
}

/** Substitute a selection into the operator's template. */
export function renderSelectedTestCmd(template: string, tests: readonly string[]): string {
  assertSelectableTestCmd(template);
  if (tests.length === 0) {
    throw new TestSelectError(
      'test-select.empty-selection',
      'refusing to render a test command for an empty selection',
      { template },
    );
  }
  return template.replaceAll(FILES_PLACEHOLDER, tests.map(shellQuote).join(' '));
}
