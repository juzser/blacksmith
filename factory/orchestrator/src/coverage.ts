import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SmithError } from './errors.js';

export class CoverageError extends SmithError {}

/**
 * Where the `json-summary` reporter writes, relative to the worktree:
 * vitest's default `coverage.reportsDirectory` is `./coverage`, and the
 * reporter's filename is fixed.
 */
export const DEFAULT_SUMMARY_PATH = 'coverage/coverage-summary.json';

/** One istanbul-shaped metric block. `pct` is the number a threshold compares. */
export interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

export interface FileCoverage {
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
}

export interface CoverageSummary {
  total: FileCoverage;
  /**
   * Worktree-relative path -> its four metrics, for EVERY instrumented file.
   * This is the whole reason the summary exists rather than the text table:
   * the v8 text reporter suppresses rows for files at 100% on every metric, so
   * the file a criterion names disappears from the transcript exactly when it
   * is doing best (D-40).
   */
  files: Record<string, FileCoverage>;
}

/**
 * `measured` — the summary has a per-file number for it.
 * `unmeasured` — it has none, and yet the coverage config reaches its
 *   directory (a sibling was instrumented). The criterion names a file the
 *   run did not measure, so the run cannot answer the criterion.
 * `not-instrumented` — it has none and nothing in its directory does either:
 *   the file is outside the coverage include glob, which is a fact about the
 *   config, not a hole in the evidence. `package.json` and `test/*.test.ts`
 *   land here.
 */
export type CoverageSubjectStatus = 'measured' | 'unmeasured' | 'not-instrumented';

export interface CoverageSubject {
  /** Worktree-relative, exactly as the claim spelled it. */
  path: string;
  status: CoverageSubjectStatus;
  coverage: FileCoverage | null;
  detail: string;
}

export interface CoverageEvidence {
  /** Worktree-relative path the summary was looked for at. */
  summaryPath: string;
  present: boolean;
  total: FileCoverage | null;
  /** How many files the run instrumented — the denominator D-40 had to infer. */
  filesMeasured: number;
  subjects: CoverageSubject[];
  /**
   * False when the run produced no summary at all, or when some file a
   * criterion names has no number in it. Evidence that omits the subject of
   * the criterion is not evidence.
   */
  complete: boolean;
  detail: string;
}

const METRIC_KEYS = ['lines', 'statements', 'functions', 'branches'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMetric(value: unknown, where: string): CoverageMetric {
  if (!isRecord(value)) {
    throw new CoverageError('coverage.malformed-summary', `${where} is not an object`);
  }
  const nums: Record<string, number> = {};
  for (const key of ['total', 'covered', 'skipped', 'pct']) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new CoverageError(
        'coverage.malformed-summary',
        `${where}.${key} is not a finite number`,
      );
    }
    nums[key] = n;
  }
  return nums as unknown as CoverageMetric;
}

function parseFileCoverage(value: unknown, where: string): FileCoverage {
  if (!isRecord(value)) {
    throw new CoverageError('coverage.malformed-summary', `${where} is not an object`);
  }
  const out: Record<string, CoverageMetric> = {};
  for (const key of METRIC_KEYS) {
    // Every metric is required. Defaulting a missing one to zero would invent
    // a number, and defaulting it to 100 would invent a pass; both are worse
    // than refusing to read the file.
    out[key] = parseMetric(value[key], `${where}.${key}`);
  }
  return out as unknown as FileCoverage;
}

/**
 * Turn one file key into a worktree-relative POSIX path. The reporter emits
 * absolute paths; a key that resolves outside the worktree is left exactly as
 * it came, because a `../../..` path would be a worse label than the truth.
 */
function relativizeKey(key: string, worktreeDir: string): string {
  if (!path.isAbsolute(key)) return key.split(path.sep).join('/');
  const rel = path.relative(worktreeDir, key);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return key;
  return rel.split(path.sep).join('/');
}

/**
 * Parse a `coverage-summary.json` document. Strict on shape: a summary that
 * cannot be read must raise, never come back as an empty-but-valid one — an
 * empty summary reads as "nothing was instrumented", which is a claim, and the
 * wrong one.
 */
export function parseCoverageSummary(raw: unknown, worktreeDir: string): CoverageSummary {
  if (!isRecord(raw)) {
    throw new CoverageError('coverage.malformed-summary', 'coverage summary is not an object');
  }
  if (!('total' in raw)) {
    throw new CoverageError(
      'coverage.malformed-summary',
      'coverage summary has no "total" key — it is not a json-summary report',
    );
  }
  const total = parseFileCoverage(raw.total, 'total');
  const files: Record<string, FileCoverage> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'total') continue;
    files[relativizeKey(key, worktreeDir)] = parseFileCoverage(value, key);
  }
  return { total, files };
}

/**
 * Read the summary a coverage run left behind. `null` means the file is not
 * there; anything else that goes wrong throws, because "absent" and
 * "unreadable" are different facts and only one of them is fixed by adding a
 * reporter.
 */
export async function readCoverageSummary(
  worktreeDir: string,
  summaryPath: string = DEFAULT_SUMMARY_PATH,
): Promise<CoverageSummary | null> {
  const abs = path.resolve(worktreeDir, summaryPath);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CoverageError(
      'coverage.unreadable-summary',
      `could not read ${summaryPath}: ${(err as Error).message}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CoverageError(
      'coverage.malformed-summary',
      `${summaryPath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  return parseCoverageSummary(raw, worktreeDir);
}

const GLOB_CHARS = /[*?[\]{}!()]/;

/** A claim that names one file, not a region. */
function isLiteralClaim(claim: string): boolean {
  return !GLOB_CHARS.test(claim);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/**
 * Answer, for each file a task's criteria actually name, whether the coverage
 * run produced a number for it. Glob claims are skipped: `src/**` names a
 * region, and a region has no single number to report — a per-file criterion
 * has to name a per-file path.
 */
export function coverageSubjects(
  summary: CoverageSummary,
  claims: readonly string[],
): CoverageSubject[] {
  const instrumentedDirs = new Set(Object.keys(summary.files).map(dirOf));
  const seen = new Set<string>();
  const subjects: CoverageSubject[] = [];

  for (const claim of claims) {
    if (!isLiteralClaim(claim) || seen.has(claim)) continue;
    seen.add(claim);

    const coverage = summary.files[claim];
    if (coverage !== undefined) {
      subjects.push({
        path: claim,
        status: 'measured',
        coverage,
        detail: `${claim}: ${coverage.lines.pct}% lines, ${coverage.statements.pct}% statements, ${coverage.functions.pct}% functions, ${coverage.branches.pct}% branches.`,
      });
      continue;
    }
    if (instrumentedDirs.has(dirOf(claim))) {
      subjects.push({
        path: claim,
        status: 'unmeasured',
        coverage: null,
        detail: `${claim} has no row in the coverage summary, yet other files in ${dirOf(claim) || '.'} do — the run did not measure the file the criterion names.`,
      });
      continue;
    }
    subjects.push({
      path: claim,
      status: 'not-instrumented',
      coverage: null,
      detail: `${claim} is outside the coverage include glob — nothing in ${dirOf(claim) || '.'} was instrumented.`,
    });
  }

  return subjects;
}

export interface CollectCoverageEvidenceInput {
  worktreeDir: string;
  /** The gated task's claims. Globs among them are ignored; see coverageSubjects. */
  claims: readonly string[];
  summaryPath?: string;
}

/**
 * The record a gate attaches instead of a scraped table: the per-file numbers
 * as the reporter wrote them, plus an explicit verdict on whether they cover
 * the files this task's criteria are about.
 */
export async function collectCoverageEvidence(
  input: CollectCoverageEvidenceInput,
): Promise<CoverageEvidence> {
  const summaryPath = input.summaryPath ?? DEFAULT_SUMMARY_PATH;
  const summary = await readCoverageSummary(input.worktreeDir, summaryPath);

  if (summary === null) {
    return {
      summaryPath,
      present: false,
      total: null,
      filesMeasured: 0,
      subjects: [],
      complete: false,
      detail: `no ${summaryPath} after the coverage check — add "json-summary" to coverage.reporter in vitest.config.ts, because the text table hides every file at 100%.`,
    };
  }

  const subjects = coverageSubjects(summary, input.claims);
  const missing = subjects.filter((s) => s.status === 'unmeasured');
  const filesMeasured = Object.keys(summary.files).length;

  return {
    summaryPath,
    present: true,
    total: summary.total,
    filesMeasured,
    subjects,
    complete: missing.length === 0,
    detail:
      missing.length === 0
        ? `${filesMeasured} files measured; ${subjects.filter((s) => s.status === 'measured').length} of ${subjects.length} named files have a per-file number.`
        : `no per-file number for ${missing.map((s) => s.path).join(', ')} — the criterion names a file the coverage run did not measure.`,
  };
}
