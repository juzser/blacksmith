import { execFileSync } from 'node:child_process';
import { SmithError } from './errors.js';

export class DiffstatError extends SmithError {}

/** One file's line accounting, straight out of `git diff --numstat`. */
export interface DiffFileStat {
  path: string;
  added: number;
  deleted: number;
  /** Binary files have no line counts; git prints `-` for both columns. */
  binary: boolean;
  /** Present only for renames, where git reports the source path too. */
  renamedFrom?: string;
}

export interface MeasuredDiffFile extends DiffFileStat {
  /** True when the file is a lockfile or generated output: reported, not counted. */
  excluded: boolean;
  /**
   * True when the file is a test or fixture (`isTestDiffPath`) and not excluded:
   * counted in `testLines`, never in `diffLines`.
   */
  test: boolean;
}

export interface DiffMeasurement {
  /** The ref the diff was taken against — explicit or derived from the branch. */
  baseRef: string;
  /**
   * added + deleted over the non-test, non-excluded files. This is the number a
   * diff cap is about: tests and fixtures never count against it.
   */
  diffLines: number;
  /** added + deleted over the test and fixture files, reported apart and never capped. */
  testLines: number;
  /** The paths counted as tests, so a wrong call is auditable. */
  testFiles: string[];
  /** added + deleted over the excluded files, so the omission is auditable. */
  excludedLines: number;
  /**
   * Capped paths (not test, not excluded) git gave no lines for. A binary file contributes 0 to
   * `diffLines`, and that 0 means "could not count", not "did not change" —
   * `judges.ts` was 14 KB of TypeScript git called binary for six days
   * (D-155). Excluded and test paths stay off this list: they are never
   * capped, so a binary screenshot baseline is not "could not count".
   */
  unmeasuredFiles: string[];
  files: MeasuredDiffFile[];
}

/**
 * `git diff --numstat -z` emits NUL-separated records, and a record is not
 * always one field:
 *
 *   ordinary:  "12\t3\tsrc/parse.ts\0"
 *   rename:    "1\t0\t\0src/old.ts\0src/new.ts\0"   <- empty path, then from, then to
 *   binary:    "-\t-\tassets/logo.png\0"
 *
 * Read naively, a rename looks like a nameless file followed by two more
 * records — which is how a diff reader ends up counting phantom files. Hence a
 * parser, and hence `-z`: the default format quotes and backslash-escapes any
 * path with a space or non-ASCII byte, so the path you compare is not the path
 * git changed.
 */
export function parseNumstat(output: string): DiffFileStat[] {
  const fields = output.split('\0');
  // A trailing NUL leaves one empty field behind; an empty diff is one empty field.
  if (fields[fields.length - 1] === '') fields.pop();

  const stats: DiffFileStat[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i] as string;
    const firstTab = record.indexOf('\t');
    const secondTab = firstTab === -1 ? -1 : record.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      throw new DiffstatError(
        'diffstat.unparseable-numstat',
        `Expected "<added>\\t<deleted>\\t<path>" from git diff --numstat -z, got ${JSON.stringify(record)}.`,
        { record },
      );
    }

    const addedRaw = record.slice(0, firstTab);
    const deletedRaw = record.slice(firstTab + 1, secondTab);
    const pathField = record.slice(secondTab + 1);
    const binary = addedRaw === '-' && deletedRaw === '-';
    const added = binary ? 0 : parseCount(addedRaw, record);
    const deleted = binary ? 0 : parseCount(deletedRaw, record);

    if (pathField === '') {
      const renamedFrom = fields[i + 1];
      const renamedTo = fields[i + 2];
      if (renamedFrom === undefined || renamedTo === undefined) {
        throw new DiffstatError(
          'diffstat.unparseable-numstat',
          `Rename record ${JSON.stringify(record)} is missing its source or destination path.`,
          { record },
        );
      }
      i += 2;
      stats.push({ path: renamedTo, added, deleted, binary, renamedFrom });
      continue;
    }

    stats.push({ path: pathField, added, deleted, binary });
  }
  return stats;
}

function parseCount(raw: string, record: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new DiffstatError(
      'diffstat.unparseable-numstat',
      `Expected a line count or "-" in ${JSON.stringify(record)}, got ${JSON.stringify(raw)}.`,
      { record, field: raw },
    );
  }
  return Number.parseInt(raw, 10);
}

/**
 * Lockfiles and generated output move by hundreds of lines for a one-line
 * source change. Counting them against a diff cap punishes the honest version
 * of the task, so they are listed but not totalled — the same carve-out
 * result.schema.json already claims for `diff_lines_changed`.
 */
const EXCLUDED_BASENAMES: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
]);

const EXCLUDED_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  'dist',
  'build',
  'coverage',
  'node_modules',
  '.next',
  '__generated__',
]);

/** Whether a changed path is generated noise rather than authored work. */
export function isExcludedDiffPath(filePath: string): boolean {
  const segments = filePath.split('/').filter((s) => s.length > 0);
  const basename = segments[segments.length - 1];
  if (basename !== undefined && EXCLUDED_BASENAMES.has(basename)) return true;
  return segments.slice(0, -1).some((segment) => EXCLUDED_DIR_SEGMENTS.has(segment));
}

/**
 * Test and fixture files. A cap that counts them pushes a coder toward fewer
 * tests, so they are measured apart (`testLines`, `testFiles`) and never
 * capped. Real code slipping out of the cap is the worse error, so every
 * ambiguous name is narrowed; the gate lists the paths it called tests so a
 * wrong call is auditable (D-157's way).
 *
 * Blacksmith builds projects in any stack, so the rule is by convention:
 *
 * - Directories that only ever hold test support, at any depth: `__tests__`,
 *   `__fixtures__`, `__snapshots__`, `__screenshots__`, `__mocks__`,
 *   `testdata`.
 * - `test`, `tests` (any case, so Swift's `Tests/` counts) and `e2e` are also
 *   ordinary feature names (`src/features/test/`, `src/crypto/e2e/`), so they
 *   count only when no earlier segment is a production source root (`src`,
 *   `app`, `lib`, `main`, `source`, `sources`). The one exception is `test`
 *   directly after `src` — the Maven/Gradle test root (`src/test/java/...`).
 * - `fixtures` is also a seed-data name (`db/fixtures/`), so it counts only
 *   under a test directory (an earlier `test`/`tests`/`e2e`/`spec`/`specs`/
 *   `__tests__` segment).
 * - Basenames: `.test.` / `.spec.` / `.cy.` on a code extension only (an
 *   `openapi.spec.yaml` is a document); `_test.` only for the languages that
 *   use it (go, py, exs, dart, c, cc, cpp) plus `_unittest.cc|cpp`;
 *   `test_*.py`, `conftest.py`, `tests.py`, `*_spec.rb`, Jasmine `*Spec.js|ts`;
 *   and the JVM/.NET/Swift/PHP names (`*Test|Tests|Spec.java|kt|scala|groovy|cs`,
 *   `*Test(s).swift`, `*Test.php`), which only count when no segment is `main`
 *   (Maven/Gradle production layout: `src/main/java/.../ABTest.java` is code).
 *
 * A `spec` or `specs` directory is deliberately NOT a test directory: here and
 * in many projects it holds plans and documents. It matters only as the
 * "under a test directory" condition for `fixtures`.
 */
const DATA_EXTENSIONS: ReadonlySet<string> = new Set([
  'yaml',
  'yml',
  'json',
  'toml',
  'xml',
  'md',
  'txt',
  'csv',
]);
const UNAMBIGUOUS_TEST_DIRS: ReadonlySet<string> = new Set([
  '__tests__',
  '__fixtures__',
  '__snapshots__',
  '__screenshots__',
  '__mocks__',
  'testdata',
]);
const AMBIGUOUS_TEST_DIRS: ReadonlySet<string> = new Set(['test', 'tests', 'e2e']);
const PRODUCTION_ROOTS: ReadonlySet<string> = new Set([
  'src',
  'app',
  'lib',
  'main',
  'source',
  'sources',
]);
const FIXTURE_PARENT_DIRS: ReadonlySet<string> = new Set([
  'test',
  'tests',
  'e2e',
  'spec',
  'specs',
  '__tests__',
]);
const ALWAYS_TEST_BASENAMES: readonly RegExp[] = [
  /_test\.(go|py|exs|dart|c|cc|cpp)$/,
  /_unittest\.(cc|cpp)$/,
  /^test_.+\.py$/,
  /^conftest\.py$/,
  /^tests\.py$/,
  /_spec\.rb$/,
  /Spec\.(js|ts)$/,
];
const NON_PRODUCTION_LAYOUT_BASENAMES: readonly RegExp[] = [
  /(Test|Tests|Spec)\.(java|kt|scala|groovy|cs)$/,
  /Tests?\.swift$/,
  /Test\.php$/,
];

/** Whether a changed path is a test or fixture. Excluded paths win over this in `measureDiff`. */
export function isTestDiffPath(filePath: string): boolean {
  const segments = filePath.split('/').filter((s) => s.length > 0);
  const basename = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  const lower = dirs.map((d) => d.toLowerCase());

  if (basename !== undefined) {
    const dotted = /\.(test|spec|cy)\.([^.]+)$/.exec(basename);
    if (dotted !== null && !DATA_EXTENSIONS.has((dotted[2] as string).toLowerCase())) return true;
    if (ALWAYS_TEST_BASENAMES.some((re) => re.test(basename))) return true;
    if (!dirs.includes('main') && NON_PRODUCTION_LAYOUT_BASENAMES.some((re) => re.test(basename))) {
      return true;
    }
  }

  return dirs.some((dir, i) => {
    if (UNAMBIGUOUS_TEST_DIRS.has(dir)) return true;
    const name = lower[i] as string;
    if (AMBIGUOUS_TEST_DIRS.has(name)) {
      if (name === 'test' && lower[i - 1] === 'src') return true;
      return !lower.slice(0, i).some((earlier) => PRODUCTION_ROOTS.has(earlier));
    }
    if (name === 'fixtures') return lower.slice(0, i).some((e) => FIXTURE_PARENT_DIRS.has(e));
    return false;
  });
}

export interface MeasureDiffOptions {
  /**
   * Diff against this ref instead of deriving one. The merge queue knows the
   * exact base SHA it admitted; the gate usually does not, and falls back to
   * the branch convention.
   */
  baseRef?: string;
}

/** A numstat over a whole epic can be large; 1 MiB (execFileSync's default) is not enough. */
const GIT_OUTPUT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * The declared diff cap is only worth writing down if something measures the
 * real diff. This does: committed work on a task branch, against the
 * integration branch it was cut from (`<prefix>/<epic>/<task-id>` ->
 * `<prefix>/<epic>/integration`, the same convention `collectCommittedChanges`
 * relies on — `<prefix>` is `bs` or the legacy `smith`, echoed back from the
 * task branch itself), or against an explicit `baseRef`.
 *
 * It throws rather than returning zero when it cannot measure. A zero that
 * means "no diff" and a zero that means "I could not look" are the same number
 * to a budget check, and only one of them should pass. The same zero can also
 * arrive one file at a time — git counts no lines in a binary file — so those
 * paths come back in `unmeasuredFiles` instead of vanishing into the total.
 */
export function measureDiff(
  worktreeDir: string,
  options: MeasureDiffOptions = {},
): DiffMeasurement {
  const baseRef = options.baseRef ?? deriveBaseRef(worktreeDir);

  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
      cwd: worktreeDir,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    throw new DiffstatError(
      'diffstat.cannot-resolve-base-ref',
      `Base ref "${baseRef}" does not resolve to a commit in ${worktreeDir}.`,
      { baseRef, worktreeDir },
    );
  }

  const output = execFileSync('git', ['diff', '--numstat', '-z', `${baseRef}...HEAD`], {
    cwd: worktreeDir,
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  });

  const files: MeasuredDiffFile[] = parseNumstat(output).map((stat) => {
    const excluded = isExcludedDiffPath(stat.path);
    return { ...stat, excluded, test: !excluded && isTestDiffPath(stat.path) };
  });

  let diffLines = 0;
  let testLines = 0;
  let excludedLines = 0;
  const testFiles: string[] = [];
  const unmeasuredFiles: string[] = [];
  for (const file of files) {
    const lines = file.added + file.deleted;
    if (file.excluded) excludedLines += lines;
    else if (file.test) {
      testLines += lines;
      testFiles.push(file.path);
    } else {
      diffLines += lines;
      if (file.binary) unmeasuredFiles.push(file.path);
    }
  }

  return { baseRef, diffLines, testLines, testFiles, excludedLines, unmeasuredFiles, files };
}

// Operator decision 2 (bs-rename): a task branch is cut under whichever
// prefix its integration branch already used — bs/ for a new epic, smith/
// for one that still integrates there — so the base ref this derives must
// echo the same prefix back, not hardcode the new one.
const TASK_BRANCH_PATTERN = /^(?<prefix>smith|bs)\/(?<epic>[^/]+)\/(?<task>[^/]+)$/;

function deriveBaseRef(worktreeDir: string): string {
  let branch: string;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreeDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    // A raw shell error would reach the caller as an untyped string and read
    // like a bug in the gate. It is not: it is the ordinary answer for a
    // directory git has never heard of, and it deserves a code like any other.
    throw new DiffstatError(
      'diffstat.not-a-git-worktree',
      `Cannot read the current branch in ${worktreeDir} — it is not a git worktree, or git refused to answer.`,
      { worktreeDir, cause: err instanceof Error ? err.message : String(err) },
    );
  }

  const groups = TASK_BRANCH_PATTERN.exec(branch)?.groups;
  const epic = groups?.epic;
  const prefix = groups?.prefix;
  if (epic === undefined || prefix === undefined) {
    throw new DiffstatError(
      'diffstat.cannot-derive-base-ref',
      `Branch "${branch}" does not follow <smith|bs>/<epic>/<task-id>, so there is no integration branch to diff against. Pass an explicit baseRef.`,
      { branch, worktreeDir },
    );
  }
  return `${prefix}/${epic}/integration`;
}
