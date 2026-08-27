import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectExportDiffs, diffExports, exportImpact, waveImpact } from '../src/impact.js';
import { buildSymbolGraph } from '../src/symbols.js';

function graphOf(files: Record<string, string>) {
  return buildSymbolGraph(new Map(Object.entries(files)));
}

describe('what the wave gate sees', () => {
  it('reports a crossing when one task owns a file another task imports from', () => {
    const graph = graphOf({
      'src/a.ts': 'export function parse(input: string): number { return 1; }',
      'src/b.ts': "import { parse } from './a.js';\nexport const n = parse('x');",
    });

    const report = waveImpact(graph, [
      { task_id: 't-a', claims: ['src/a.ts'] },
      { task_id: 't-b', claims: ['src/b.ts'] },
    ]);

    expect(report.status).toBe('coupled');
    expect(report.ok).toBe(false);
    expect(report.crossings).toEqual([
      {
        producer: 't-a',
        consumer: 't-b',
        exportedBy: 'src/a.ts',
        importedBy: 'src/b.ts',
        symbols: ['parse'],
        typeOnly: false,
        dynamic: false,
      },
    ]);
  });

  it('keeps a type-only crossing, because a signature change is what breaks it', () => {
    const graph = graphOf({
      'src/a.ts': 'export interface Spec { id: string; }',
      'src/b.ts': "import type { Spec } from './a.js';\nexport const s: Spec = { id: 'x' };",
    });

    const report = waveImpact(graph, [
      { task_id: 't-a', claims: ['src/a.ts'] },
      { task_id: 't-b', claims: ['src/b.ts'] },
    ]);

    expect(report.crossings).toHaveLength(1);
    expect(report.crossings[0]?.typeOnly).toBe(true);
    expect(report.status).toBe('coupled');
  });

  it('merges two imports of one file into a single crossing', () => {
    const graph = graphOf({
      'src/a.ts': 'export const one = 1;\nexport interface Two { x: number }',
      'src/b.ts':
        "import { one } from './a.js';\nimport type { Two } from './a.js';\nexport const b = one;",
    });

    const report = waveImpact(graph, [
      { task_id: 't-a', claims: ['src/a.ts'] },
      { task_id: 't-b', claims: ['src/b.ts'] },
    ]);

    expect(report.crossings).toHaveLength(1);
    expect(report.crossings[0]?.symbols).toEqual(['Two', 'one']);
    expect(report.crossings[0]?.typeOnly).toBe(false);
  });

  it('does not call a task coupled to itself', () => {
    const graph = graphOf({
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': "import { a } from './a.js';\nexport const b = a;",
    });

    const report = waveImpact(graph, [{ task_id: 't-a', claims: ['src/**'] }]);

    expect(report.crossings).toEqual([]);
    expect(report.status).toBe('clean');
    expect(report.ok).toBe(true);
  });

  it('calls a wave clean when its tasks share no compile-time edge', () => {
    const graph = graphOf({
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': 'export const b = 2;',
    });

    const report = waveImpact(graph, [
      { task_id: 't-a', claims: ['src/a.ts'] },
      { task_id: 't-b', claims: ['src/b.ts'] },
    ]);

    expect(report.status).toBe('clean');
    expect(report.crossings).toEqual([]);
    expect(report.exposure).toEqual([]);
  });

  it('reports both directions when two tasks import from each other', () => {
    const graph = graphOf({
      'src/a.ts': "import { b } from './b.js';\nexport const a = b;",
      'src/b.ts': "import type { A } from './a.js';\nexport const b = 1;\nexport type A = number;",
    });

    const report = waveImpact(graph, [
      { task_id: 't-a', claims: ['src/a.ts'] },
      { task_id: 't-b', claims: ['src/b.ts'] },
    ]);

    expect(report.crossings.map((c) => `${c.producer}->${c.consumer}`)).toEqual([
      't-a->t-b',
      't-b->t-a',
    ]);
  });
});

describe('what the wave gate reports without failing', () => {
  it('names an importer outside the wave as exposure, not a violation', () => {
    const graph = graphOf({
      'src/a.ts': 'export const a = 1;',
      'src/far.ts': "import { a } from './a.js';\nexport const f = a;",
    });

    const report = waveImpact(graph, [{ task_id: 't-a', claims: ['src/a.ts'] }]);

    expect(report.exposure).toEqual([
      { producer: 't-a', exportedBy: 'src/a.ts', importedBy: 'src/far.ts', symbols: ['a'] },
    ]);
    expect(report.status).toBe('clean');
    expect(report.ok).toBe(true);
  });

  it('names a task whose claims match no file the graph knows', () => {
    const graph = graphOf({ 'src/a.ts': 'export const a = 1;' });

    const report = waveImpact(graph, [
      { task_id: 't-a', claims: ['src/a.ts'] },
      { task_id: 't-new', claims: ['src/not-yet-written.ts'] },
    ]);

    expect(report.claimsWithoutFiles).toEqual(['t-new']);
  });

  it('is unverifiable when a file it cannot read sits in the wave', () => {
    const graph = graphOf({
      'src/a.ts': "export const broken = 'unterminated;",
      'src/b.ts': 'export const b = 1;',
    });

    const report = waveImpact(graph, [
      { task_id: 't-a', claims: ['src/a.ts'] },
      { task_id: 't-b', claims: ['src/b.ts'] },
    ]);

    expect(report.status).toBe('unverifiable');
    expect(report.unanalyzed).toEqual(['src/a.ts']);
    expect(report.ok).toBe(true);
  });

  it('reports an unresolved import out of a claimed file as a hole', () => {
    const graph = graphOf({
      'src/a.ts': "import { x } from './gone.js';\nexport const a = x;",
    });

    const report = waveImpact(graph, [{ task_id: 't-a', claims: ['src/a.ts'] }]);

    expect(report.status).toBe('unverifiable');
    expect(report.unresolved).toEqual([{ from: 'src/a.ts', specifier: './gone.js' }]);
  });

  it('ignores a hole in a file no task in the wave claims', () => {
    const graph = graphOf({
      'src/a.ts': 'export const a = 1;',
      'src/other.ts': "export const broken = 'unterminated;",
    });

    const report = waveImpact(graph, [{ task_id: 't-a', claims: ['src/a.ts'] }]);

    expect(report.status).toBe('clean');
    expect(report.unanalyzed).toEqual([]);
  });

  it('lets coupling outrank a hole, because the crossing is the actionable fact', () => {
    const graph = graphOf({
      'src/a.ts': "export const broken = 'unterminated;",
      'src/b.ts': 'export const b = 1;',
      'src/c.ts': "import { b } from './b.js';\nexport const c = b;",
    });

    const report = waveImpact(graph, [
      { task_id: 't-a', claims: ['src/a.ts'] },
      { task_id: 't-b', claims: ['src/b.ts'] },
      { task_id: 't-c', claims: ['src/c.ts'] },
    ]);

    expect(report.status).toBe('coupled');
    expect(report.unanalyzed).toEqual(['src/a.ts']);
  });
});

describe('what an export diff proves', () => {
  it('names a removed export', () => {
    const diff = diffExports(
      'export const a = 1;\nexport const b = 2;',
      'export const a = 1;',
      'src/a.ts',
    );
    expect(diff.removed).toEqual(['b']);
    expect(diff.added).toEqual([]);
  });

  it('names an added export without calling it a break', () => {
    const diff = diffExports(
      'export const a = 1;',
      'export const a = 1;\nexport const b = 2;',
      'src/a.ts',
    );
    expect(diff.added).toEqual(['b']);
    expect(diff.removed).toEqual([]);
    expect(diff.signatureChanged).toEqual([]);
  });

  it('names a changed parameter list as a changed signature', () => {
    const diff = diffExports(
      'export function f(a: string): void { body(); }',
      'export function f(a: string, b: number): void { body(); }',
      'src/a.ts',
    );
    expect(diff.signatureChanged).toEqual(['f']);
  });

  it('does not call a changed body a changed signature', () => {
    const diff = diffExports(
      'export function f(a: string): void { one(); }',
      'export function f(a: string): void { two(); three(); }',
      'src/a.ts',
    );
    expect(diff.signatureChanged).toEqual([]);
  });

  it('names a changed return type as a changed signature', () => {
    const diff = diffExports(
      'export function f(): string { return x; }',
      'export function f(): number { return x; }',
      'src/a.ts',
    );
    expect(diff.signatureChanged).toEqual(['f']);
  });

  it('refuses to answer when either side is unreadable', () => {
    const diff = diffExports("export const a = 'unterminated;", 'export const a = 1;', 'src/a.ts');
    expect(diff.unverifiable).toBe(true);
    expect(diff.removed).toEqual([]);
  });
});

describe('what the post-run export impact proves', () => {
  const graph = graphOf({
    'src/a.ts': 'export const kept = 1;\nexport const gone = 2;',
    'src/mine.ts': "import { gone } from './a.js';\nexport const m = gone;",
    'src/theirs.ts': "import { gone } from './a.js';\nexport const t = gone;",
  });

  it('calls a removed export used outside the claims a proven break', () => {
    const report = exportImpact(
      graph,
      [
        {
          file: 'src/a.ts',
          removed: ['gone'],
          added: [],
          signatureChanged: [],
          unverifiable: false,
        },
      ],
      ['src/a.ts', 'src/mine.ts'],
    );

    expect(report.ok).toBe(false);
    expect(report.breaks).toEqual([
      {
        severity: 'proven',
        reason: 'removed',
        exportedBy: 'src/a.ts',
        importedBy: 'src/theirs.ts',
        symbols: ['gone'],
      },
    ]);
  });

  it('says nothing about an importer the task itself claims', () => {
    const report = exportImpact(
      graph,
      [
        {
          file: 'src/a.ts',
          removed: ['gone'],
          added: [],
          signatureChanged: [],
          unverifiable: false,
        },
      ],
      ['src/**'],
    );

    expect(report.breaks).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('calls a changed signature possible rather than proven', () => {
    const report = exportImpact(
      graph,
      [
        {
          file: 'src/a.ts',
          removed: [],
          added: [],
          signatureChanged: ['gone'],
          unverifiable: false,
        },
      ],
      ['src/a.ts', 'src/mine.ts'],
    );

    expect(report.breaks).toEqual([
      {
        severity: 'possible',
        reason: 'signature-changed',
        exportedBy: 'src/a.ts',
        importedBy: 'src/theirs.ts',
        symbols: ['gone'],
      },
    ]);
    expect(report.ok).toBe(true);
  });

  it('counts a namespace importer as consuming every removed symbol', () => {
    const starGraph = graphOf({
      'src/a.ts': 'export const gone = 1;',
      'src/theirs.ts': "import * as all from './a.js';\nexport const t = all;",
    });

    const report = exportImpact(
      starGraph,
      [
        {
          file: 'src/a.ts',
          removed: ['gone'],
          added: [],
          signatureChanged: [],
          unverifiable: false,
        },
      ],
      ['src/a.ts'],
    );

    expect(report.breaks).toHaveLength(1);
    expect(report.breaks[0]?.severity).toBe('proven');
  });

  it('does not invent a break from an unverifiable diff', () => {
    const report = exportImpact(
      graph,
      [{ file: 'src/a.ts', removed: [], added: [], signatureChanged: [], unverifiable: true }],
      ['src/a.ts'],
    );

    expect(report.breaks).toEqual([]);
    expect(report.detail).toContain('src/a.ts');
  });
});

describe('collecting export diffs from a worktree', () => {
  let repoDir: string;

  function git(args: string[]) {
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  }

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), 'smith-impact-repo-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await writeFile(
      path.join(repoDir, 'src', 'a.ts'),
      'export const kept = 1;\nexport const gone = 2;\n',
    );
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
    git(['branch', 'smith/epic-1/integration']);
    git(['checkout', '-q', '-b', 'smith/epic-1/task-1', 'smith/epic-1/integration']);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('diffs a committed change against the integration branch', async () => {
    await writeFile(path.join(repoDir, 'src', 'a.ts'), 'export const kept = 1;\n');
    git(['commit', '-q', '-am', 'drop gone']);

    expect(collectExportDiffs(repoDir, ['src/a.ts'])).toEqual([
      { file: 'src/a.ts', removed: ['gone'], added: [], signatureChanged: [], unverifiable: false },
    ]);
  });

  it('treats a file added on the branch as all-new exports, not removals', async () => {
    await writeFile(path.join(repoDir, 'src', 'b.ts'), 'export const b = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'add b']);

    expect(collectExportDiffs(repoDir, ['src/b.ts'])).toEqual([
      { file: 'src/b.ts', removed: [], added: ['b'], signatureChanged: [], unverifiable: false },
    ]);
  });

  it('treats a deleted file as every export removed', async () => {
    git(['rm', '-q', 'src/a.ts']);
    git(['commit', '-q', '-m', 'delete a']);

    expect(collectExportDiffs(repoDir, ['src/a.ts'])).toEqual([
      {
        file: 'src/a.ts',
        removed: ['kept', 'gone'],
        added: [],
        signatureChanged: [],
        unverifiable: false,
      },
    ]);
  });

  it('skips a changed file that is not source this graph speaks for', async () => {
    await writeFile(path.join(repoDir, 'README.md'), '# hi\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'docs']);

    expect(collectExportDiffs(repoDir, ['README.md'])).toEqual([]);
  });
});
