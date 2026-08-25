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
}

export interface DiffMeasurement {
  /** The ref the diff was taken against — explicit or derived from the branch. */
  baseRef: string;
  /** added + deleted over the counted files. This is the number a diff cap is about. */
  diffLines: number;
  /** added + deleted over the excluded files, so the omission is auditable. */
  excludedLines: number;
  /**
   * Counted paths git gave no lines for. A binary file contributes 0 to
   * `diffLines`, and that 0 means "could not count", not "did not change" —
   * `judges.ts` was 14 KB of TypeScript git called binary for six days
   * (D-155). Excluded paths stay off this list: they were never counted, and
   * `excludedLines` already accounts for them.
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
 * integration branch it was cut from (`smith/<epic>/<task-id>` ->
 * `smith/<epic>/integration`, the same convention `collectCommittedChanges`
 * relies on), or against an explicit `baseRef`.
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

  const files: MeasuredDiffFile[] = parseNumstat(output).map((stat) => ({
    ...stat,
    excluded: isExcludedDiffPath(stat.path),
  }));

  let diffLines = 0;
  let excludedLines = 0;
  const unmeasuredFiles: string[] = [];
  for (const file of files) {
    if (file.excluded) excludedLines += file.added + file.deleted;
    else {
      diffLines += file.added + file.deleted;
      if (file.binary) unmeasuredFiles.push(file.path);
    }
  }

  return { baseRef, diffLines, excludedLines, unmeasuredFiles, files };
}

const TASK_BRANCH_PATTERN = /^smith\/(?<epic>[^/]+)\/(?<task>[^/]+)$/;

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

  const epic = TASK_BRANCH_PATTERN.exec(branch)?.groups?.epic;
  if (epic === undefined) {
    throw new DiffstatError(
      'diffstat.cannot-derive-base-ref',
      `Branch "${branch}" does not follow smith/<epic>/<task-id>, so there is no integration branch to diff against. Pass an explicit baseRef.`,
      { branch, worktreeDir },
    );
  }
  return `smith/${epic}/integration`;
}
