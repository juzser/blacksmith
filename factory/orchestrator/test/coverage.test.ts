import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CoverageError,
  collectCoverageEvidence,
  coverageSubjects,
  DEFAULT_SUMMARY_PATH,
  parseCoverageSummary,
  readCoverageSummary,
} from '../src/coverage.js';

/** One istanbul-shaped metric block. `pct` is what a threshold compares. */
function metric(pct: number, total = 10): Record<string, number> {
  return { total, covered: Math.round((pct / 100) * total), skipped: 0, pct };
}

function fileEntry(pct: number): Record<string, unknown> {
  return {
    lines: metric(pct),
    statements: metric(pct),
    functions: metric(pct, 2),
    branches: metric(pct, 4),
  };
}

/**
 * The v8 `json-summary` reporter keys every file by ABSOLUTE path and puts the
 * aggregate under `total` — verified against a real `vitest run --coverage
 * --coverage.reporter=json-summary` run, not assumed.
 */
function summaryFixture(
  worktreeDir: string,
  files: Record<string, number>,
  totalPct = 90,
): Record<string, unknown> {
  const out: Record<string, unknown> = { total: fileEntry(totalPct) };
  for (const [rel, pct] of Object.entries(files)) {
    out[path.join(worktreeDir, rel)] = fileEntry(pct);
  }
  return out;
}

describe('coverage.ts — the summary itself (P9-25)', () => {
  let worktreeDir: string;

  beforeEach(async () => {
    worktreeDir = await mkdtemp(path.join(tmpdir(), 'smith-cov-'));
  });

  afterEach(async () => {
    await rm(worktreeDir, { recursive: true, force: true });
  });

  it('keeps the 100% file the text reporter hides, keyed worktree-relative', () => {
    // D-40 exactly: coerce.ts and parse.ts printed, index.ts and validate.ts
    // did not — because they were at 100% on every metric, which the v8 text
    // reporter suppresses. The summary has all four.
    const summary = parseCoverageSummary(
      summaryFixture(worktreeDir, {
        'src/coerce.ts': 93,
        'src/parse.ts': 88,
        'src/index.ts': 100,
        'src/validate.ts': 100,
      }),
      worktreeDir,
    );

    expect(Object.keys(summary.files).sort()).toEqual([
      'src/coerce.ts',
      'src/index.ts',
      'src/parse.ts',
      'src/validate.ts',
    ]);
    expect(summary.files['src/index.ts']?.lines.pct).toBe(100);
    expect(summary.total.lines.pct).toBe(90);
  });

  it('leaves a key outside the worktree absolute instead of mangling it', () => {
    const raw = summaryFixture(worktreeDir, { 'src/a.ts': 100 });
    raw['/elsewhere/vendor/b.ts'] = fileEntry(50);

    const summary = parseCoverageSummary(raw, worktreeDir);

    expect(summary.files['src/a.ts']).toBeDefined();
    expect(summary.files['/elsewhere/vendor/b.ts']).toBeDefined();
  });

  it('rejects a summary with no total rather than reading as empty-but-valid', () => {
    expect(() => parseCoverageSummary({ '/x/src/a.ts': fileEntry(100) }, worktreeDir)).toThrow(
      CoverageError,
    );
  });

  it('rejects a file entry missing a metric instead of defaulting it to zero', () => {
    const raw = summaryFixture(worktreeDir, {});
    raw[path.join(worktreeDir, 'src/a.ts')] = { lines: metric(100) };

    expect(() => parseCoverageSummary(raw, worktreeDir)).toThrow(CoverageError);
  });

  it('returns null when the summary file is absent', async () => {
    expect(await readCoverageSummary(worktreeDir)).toBeNull();
  });

  it('throws on a corrupt summary — absent and unreadable are not the same fact', async () => {
    await mkdir(path.join(worktreeDir, 'coverage'), { recursive: true });
    await writeFile(path.join(worktreeDir, DEFAULT_SUMMARY_PATH), '{ not json', 'utf8');

    await expect(readCoverageSummary(worktreeDir)).rejects.toThrow(CoverageError);
  });

  it('reads a real summary from the default reporter path', async () => {
    await mkdir(path.join(worktreeDir, 'coverage'), { recursive: true });
    await writeFile(
      path.join(worktreeDir, DEFAULT_SUMMARY_PATH),
      JSON.stringify(summaryFixture(worktreeDir, { 'src/index.ts': 100 })),
      'utf8',
    );

    const summary = await readCoverageSummary(worktreeDir);
    expect(summary?.files['src/index.ts']?.branches.pct).toBe(100);
  });
});

describe('coverage.ts — subjects of a criterion (P9-25)', () => {
  const worktreeDir = '/wt';

  function summary(files: Record<string, number>) {
    return parseCoverageSummary(summaryFixture(worktreeDir, files), worktreeDir);
  }

  it('reports a claimed file that is in the summary with its own four numbers', () => {
    const subjects = coverageSubjects(summary({ 'src/index.ts': 100 }), ['src/index.ts']);

    expect(subjects).toHaveLength(1);
    expect(subjects[0]?.status).toBe('measured');
    expect(subjects[0]?.coverage?.functions.pct).toBe(100);
  });

  it('reports unmeasured when siblings were instrumented and the named file was not', () => {
    // The D-40 fear, made loud: the criterion names src/index.ts, the coverage
    // config reaches src/, and yet no number exists for it.
    const subjects = coverageSubjects(summary({ 'src/parse.ts': 88 }), ['src/index.ts']);

    expect(subjects[0]?.status).toBe('unmeasured');
    expect(subjects[0]?.coverage).toBeNull();
    expect(subjects[0]?.detail).toContain('src/index.ts');
  });

  it('reports not-instrumented for a claim nothing in its directory covers', () => {
    const subjects = coverageSubjects(summary({ 'src/index.ts': 100 }), [
      'test/index.test.ts',
      'package.json',
    ]);

    expect(subjects.map((s) => s.status)).toEqual(['not-instrumented', 'not-instrumented']);
  });

  it('skips glob claims — a glob names a region, and a region has no single number', () => {
    const subjects = coverageSubjects(summary({ 'src/index.ts': 100 }), [
      'src/**/*.ts',
      'src/index.ts',
      'src/{a,b}.ts',
      'src/?.ts',
    ]);

    expect(subjects.map((s) => s.path)).toEqual(['src/index.ts']);
  });

  it('does not double-report a file two claims both name', () => {
    const subjects = coverageSubjects(summary({ 'src/parse.ts': 88 }), [
      'src/parse.ts',
      'src/parse.ts',
    ]);

    expect(subjects).toHaveLength(1);
  });
});

describe('coverage.ts — evidence for the gate (P9-25)', () => {
  let worktreeDir: string;

  beforeEach(async () => {
    worktreeDir = await mkdtemp(path.join(tmpdir(), 'smith-cov-ev-'));
  });

  afterEach(async () => {
    await rm(worktreeDir, { recursive: true, force: true });
  });

  async function writeSummary(files: Record<string, number>): Promise<void> {
    await mkdir(path.join(worktreeDir, 'coverage'), { recursive: true });
    await writeFile(
      path.join(worktreeDir, DEFAULT_SUMMARY_PATH),
      JSON.stringify(summaryFixture(worktreeDir, files)),
      'utf8',
    );
  }

  it('is incomplete, and says which reporter is missing, when no summary was written', async () => {
    const evidence = await collectCoverageEvidence({ worktreeDir, claims: ['src/index.ts'] });

    expect(evidence.present).toBe(false);
    expect(evidence.complete).toBe(false);
    expect(evidence.total).toBeNull();
    expect(evidence.detail).toContain('json-summary');
  });

  it('is complete when every named file has a number', async () => {
    await writeSummary({ 'src/index.ts': 100, 'src/parse.ts': 88 });

    const evidence = await collectCoverageEvidence({
      worktreeDir,
      claims: ['src/index.ts', 'test/index.test.ts'],
    });

    expect(evidence.present).toBe(true);
    expect(evidence.complete).toBe(true);
    expect(evidence.filesMeasured).toBe(2);
    expect(evidence.subjects.find((s) => s.path === 'src/index.ts')?.status).toBe('measured');
  });

  it('is incomplete when the file the criterion names has no number', async () => {
    await writeSummary({ 'src/parse.ts': 88 });

    const evidence = await collectCoverageEvidence({ worktreeDir, claims: ['src/index.ts'] });

    expect(evidence.complete).toBe(false);
    expect(evidence.detail).toContain('src/index.ts');
  });

  it('is complete with no claims at all — a total is still evidence of something', async () => {
    await writeSummary({ 'src/index.ts': 100 });

    const evidence = await collectCoverageEvidence({ worktreeDir, claims: [] });

    expect(evidence.complete).toBe(true);
    expect(evidence.subjects).toEqual([]);
    expect(evidence.total?.lines.pct).toBe(90);
  });
});
