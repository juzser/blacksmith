/**
 * What a path claim cannot say, said here.
 *
 * `claims.ts` answers "did two tasks write the same file". That question has a
 * blind spot with a name: task A changes `parse()`'s signature in `src/a.ts`,
 * task B calls `parse()` from `src/b.ts`, the two claim lists are disjoint,
 * every gate is green, and integration is where the factory finds out. The
 * conflict was never in a file — it lived on the edge between two files, which
 * is exactly what `symbols.ts` reads.
 *
 * Two checks, and the difference between them is the difference between a risk
 * and a fact:
 *
 * - `waveImpact` runs BEFORE dispatch, over declarations. It can only see that
 *   two tasks in one wave sit on either end of a compile-time edge. That is a
 *   reason to order them, not evidence that anything is wrong, so it reports
 *   `coupled` and stops the wave from running them in parallel.
 * - `exportImpact` runs AFTER the work, over a diff. Here an export that was
 *   removed while a file outside the claims still imports it is not a risk —
 *   it is a break, and it is provable. A changed signature is weaker: this
 *   module reads text, not types, so it says `possible` and means it.
 *
 * Holes are reported, never fatal. The scanner has blind spots (a `.vue` file,
 * an unterminated literal), and failing a wave for the scanner's limits would
 * teach operators to reach for the override — which costs more than the check
 * was ever worth.
 */

import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { claimCoversPath, integrationBranchFor, type WaveTask } from './claims.js';
import { runGit } from './git.js';
import {
  DEFAULT_SOURCE_EXTENSIONS,
  parseModuleFacts,
  type SymbolGraph,
  type UnresolvedSpecifier,
} from './symbols.js';

// ---------------------------------------------------------------------------
// Pre-run: which tasks in this wave share a compile-time edge
// ---------------------------------------------------------------------------

/** Two tasks in one wave on either end of an import edge. */
export interface SymbolCrossing {
  /** The task whose claims cover the file that exports the symbols. */
  producer: string;
  /** The task whose claims cover the file that imports them. */
  consumer: string;
  exportedBy: string;
  importedBy: string;
  symbols: string[];
  /** True only when every edge between the two files is type-only. */
  typeOnly: boolean;
  /** True only when every edge between the two files is a dynamic import. */
  dynamic: boolean;
}

/** A file outside the wave that depends on a symbol the wave may change. */
export interface UnclaimedExposure {
  producer: string;
  exportedBy: string;
  importedBy: string;
  symbols: string[];
}

export interface WaveImpactReport {
  /** `coupled` outranks `unverifiable` outranks `clean`. */
  status: 'clean' | 'coupled' | 'unverifiable';
  /** False only for `coupled`: a hole is the scanner's limit, not the wave's fault. */
  ok: boolean;
  crossings: SymbolCrossing[];
  exposure: UnclaimedExposure[];
  /** Tasks whose claims match no file the graph knows — a new file, or a typo. */
  claimsWithoutFiles: string[];
  /** Claimed files the scanner could not read. */
  unanalyzed: string[];
  /** Imports out of claimed files that resolve to nothing in scope. */
  unresolved: UnresolvedSpecifier[];
  detail: string;
}

interface CrossingAccumulator {
  producer: string;
  consumer: string;
  exportedBy: string;
  importedBy: string;
  symbols: Set<string>;
  typeOnly: boolean;
  dynamic: boolean;
}

interface ExposureAccumulator {
  producer: string;
  exportedBy: string;
  importedBy: string;
  names: Set<string>;
}

/**
 * File -> the task that claims it. First claim wins: a file claimed twice is an
 * overlap, and `validateWave` already refuses that wave for its own reasons.
 */
function ownersOf(files: readonly string[], tasks: readonly WaveTask[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const task of tasks) {
    for (const file of files) {
      if (owner.has(file)) continue;
      if (task.claims.some((claim) => claimCoversPath(claim, file))) owner.set(file, task.task_id);
    }
  }
  return owner;
}

export function waveImpact(graph: SymbolGraph, tasks: readonly WaveTask[]): WaveImpactReport {
  // Unreadable files are absent from `modules` but still claimable, and a task
  // that claims one has matched a real file — it is the reading that failed.
  const known = [...graph.modules.keys(), ...graph.unanalyzed].sort();
  const owner = ownersOf(known, tasks);
  const claimed = new Set(owner.values());

  const crossings = new Map<string, CrossingAccumulator>();
  const exposure = new Map<string, ExposureAccumulator>();

  for (const [exportedBy, edges] of graph.dependents) {
    const producer = owner.get(exportedBy);
    if (producer === undefined) continue;
    for (const edge of edges) {
      const consumer = owner.get(edge.from);
      if (consumer === undefined) {
        const key = `${producer} ${exportedBy} ${edge.from}`;
        const seen = exposure.get(key);
        if (seen === undefined) {
          exposure.set(key, {
            producer,
            exportedBy,
            importedBy: edge.from,
            names: new Set(edge.names),
          });
        } else {
          for (const name of edge.names) seen.names.add(name);
        }
        continue;
      }
      if (consumer === producer) continue;
      const key = `${producer} ${consumer} ${exportedBy} ${edge.from}`;
      const seen = crossings.get(key);
      if (seen === undefined) {
        crossings.set(key, {
          producer,
          consumer,
          exportedBy,
          importedBy: edge.from,
          symbols: new Set(edge.names),
          typeOnly: edge.typeOnly,
          dynamic: edge.dynamic,
        });
      } else {
        for (const name of edge.names) seen.symbols.add(name);
        // One value import is enough to make the coupling a value coupling.
        seen.typeOnly = seen.typeOnly && edge.typeOnly;
        seen.dynamic = seen.dynamic && edge.dynamic;
      }
    }
  }

  const orderedCrossings: SymbolCrossing[] = [...crossings.values()]
    .map((c) => ({
      producer: c.producer,
      consumer: c.consumer,
      exportedBy: c.exportedBy,
      importedBy: c.importedBy,
      symbols: [...c.symbols].sort(),
      typeOnly: c.typeOnly,
      dynamic: c.dynamic,
    }))
    .sort(
      (a, b) =>
        a.producer.localeCompare(b.producer) ||
        a.consumer.localeCompare(b.consumer) ||
        a.exportedBy.localeCompare(b.exportedBy) ||
        a.importedBy.localeCompare(b.importedBy),
    );

  const orderedExposure: UnclaimedExposure[] = [...exposure.values()]
    .map((e) => ({
      producer: e.producer,
      exportedBy: e.exportedBy,
      importedBy: e.importedBy,
      symbols: [...e.names].sort(),
    }))
    .sort(
      (a, b) =>
        a.producer.localeCompare(b.producer) ||
        a.exportedBy.localeCompare(b.exportedBy) ||
        a.importedBy.localeCompare(b.importedBy),
    );

  const claimsWithoutFiles = tasks
    .filter((task) => !claimed.has(task.task_id))
    .map((task) => task.task_id);

  const unanalyzed = graph.unanalyzed.filter((file) => owner.has(file));
  const unresolved = graph.unresolved.filter((entry) => owner.has(entry.from));

  const hasHoles = unanalyzed.length > 0 || unresolved.length > 0;
  const status = orderedCrossings.length > 0 ? 'coupled' : hasHoles ? 'unverifiable' : 'clean';

  return {
    status,
    ok: status !== 'coupled',
    crossings: orderedCrossings,
    exposure: orderedExposure,
    claimsWithoutFiles,
    unanalyzed,
    unresolved,
    detail: describeWave(
      status,
      orderedCrossings,
      orderedExposure,
      unanalyzed.length + unresolved.length,
    ),
  };
}

function describeWave(
  status: WaveImpactReport['status'],
  crossings: readonly SymbolCrossing[],
  exposure: readonly UnclaimedExposure[],
  holes: number,
): string {
  const parts: string[] = [];
  if (status === 'coupled') {
    const pairs = new Set(crossings.map((c) => `${c.producer}/${c.consumer}`));
    parts.push(
      `${crossings.length} symbol crossing(s) across ${pairs.size} task pair(s): run them in order, not in parallel.`,
    );
  } else if (status === 'unverifiable') {
    parts.push(
      'No crossing found, but the graph has holes over this wave - treat the result as partial.',
    );
  } else {
    parts.push('No task in this wave imports a symbol another task in this wave exports.');
  }
  if (exposure.length > 0) {
    parts.push(`${exposure.length} file(s) outside the wave import from claimed files.`);
  }
  if (holes > 0) parts.push(`${holes} unreadable or unresolved edge(s) over claimed files.`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Post-run: which exported surfaces actually moved
// ---------------------------------------------------------------------------

export interface ExportDiff {
  file: string;
  /** Exported before, gone after. Any importer of these names is broken. */
  removed: string[];
  added: string[];
  /** Still exported, but the declaration text differs — a text-level claim. */
  signatureChanged: string[];
  /** Either side was unreadable, so none of the above is a statement. */
  unverifiable: boolean;
}

/**
 * The classifier half (P9-3): two texts in, a diff out. Knows nothing about
 * git, which is what lets the wave gate, the merge queue and a test all ask it
 * the same question.
 */
export function diffExports(before: string, after: string, file: string): ExportDiff {
  const b = parseModuleFacts(before, file);
  const a = parseModuleFacts(after, file);
  if (b.unterminated || a.unterminated) {
    return { file, removed: [], added: [], signatureChanged: [], unverifiable: true };
  }
  const afterNames = new Set(a.exports);
  const beforeNames = new Set(b.exports);
  return {
    file,
    removed: b.exports.filter((name) => !afterNames.has(name)),
    added: a.exports.filter((name) => !beforeNames.has(name)),
    signatureChanged: b.exports.filter(
      (name) =>
        afterNames.has(name) && b.exportSignatures.get(name) !== a.exportSignatures.get(name),
    ),
    unverifiable: false,
  };
}

export interface ExportBreak {
  /** `proven`: the symbol is gone. `possible`: its text changed shape. */
  severity: 'proven' | 'possible';
  reason: 'removed' | 'signature-changed';
  exportedBy: string;
  importedBy: string;
  symbols: string[];
}

export interface ExportImpactReport {
  /** False when anything is proven broken. A `possible` break is a warning. */
  ok: boolean;
  breaks: ExportBreak[];
  detail: string;
}

/** A namespace import consumes whatever the module exports, named or not. */
function consumes(names: readonly string[], symbol: string): boolean {
  return names.includes('*') || names.includes(symbol);
}

/**
 * Whose files broke. `claims` is the acting task's own claim list: an importer
 * the task already owns is not a break, because the same task is free to fix
 * it in the same diff — and usually has.
 */
export function exportImpact(
  graph: SymbolGraph,
  diffs: readonly ExportDiff[],
  claims: readonly string[],
): ExportImpactReport {
  const breaks: ExportBreak[] = [];
  const unverifiable: string[] = [];

  for (const diff of diffs) {
    if (diff.unverifiable) {
      unverifiable.push(diff.file);
      continue;
    }
    if (diff.removed.length === 0 && diff.signatureChanged.length === 0) continue;
    for (const edge of graph.dependents.get(diff.file) ?? []) {
      if (claims.some((claim) => claimCoversPath(claim, edge.from))) continue;
      const gone = diff.removed.filter((symbol) => consumes(edge.names, symbol));
      const moved = diff.signatureChanged.filter((symbol) => consumes(edge.names, symbol));
      if (gone.length > 0) {
        breaks.push({
          severity: 'proven',
          reason: 'removed',
          exportedBy: diff.file,
          importedBy: edge.from,
          symbols: gone,
        });
      }
      if (moved.length > 0) {
        breaks.push({
          severity: 'possible',
          reason: 'signature-changed',
          exportedBy: diff.file,
          importedBy: edge.from,
          symbols: moved,
        });
      }
    }
  }

  breaks.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'proven' ? -1 : 1) ||
      a.exportedBy.localeCompare(b.exportedBy) ||
      a.importedBy.localeCompare(b.importedBy),
  );

  const proven = breaks.filter((entry) => entry.severity === 'proven').length;
  const possible = breaks.length - proven;
  const parts: string[] = [];
  if (proven > 0) parts.push(`${proven} importer(s) outside the claims lost a symbol they use.`);
  if (possible > 0) {
    parts.push(`${possible} importer(s) use a symbol whose declaration changed shape.`);
  }
  if (proven === 0 && possible === 0) {
    parts.push('No importer outside the claims depends on what moved.');
  }
  if (unverifiable.length > 0) parts.push(`Unreadable, so unchecked: ${unverifiable.join(', ')}.`);

  return { ok: proven === 0, breaks, detail: parts.join(' ') };
}

/**
 * The collector half (P9-3): read both sides of each changed file out of git.
 *
 * `ls-tree` before `show` on purpose — a file added on this branch is absent
 * from the integration branch, and asking `show` for it would raise an error
 * that means "new file", which is not an error at all.
 */
export function collectExportDiffs(
  worktreeDir: string,
  changedFiles: readonly string[],
): ExportDiff[] {
  const integrationBranch = integrationBranchFor(worktreeDir);
  const diffs: ExportDiff[] = [];

  for (const file of changedFiles) {
    if (!DEFAULT_SOURCE_EXTENSIONS.includes(extname(file))) continue;

    const listed = runGit(worktreeDir, [
      'ls-tree',
      '-r',
      '--name-only',
      integrationBranch,
      '--',
      file,
    ]);
    const before =
      listed === '' ? '' : runGit(worktreeDir, ['show', `${integrationBranch}:${file}`]);

    const absolute = join(worktreeDir, file);
    const after = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
    if (before === '' && after === '') continue;

    const diff = diffExports(before, after, file);
    const moved =
      diff.removed.length > 0 || diff.added.length > 0 || diff.signatureChanged.length > 0;
    if (diff.unverifiable || moved) diffs.push(diff);
  }
  return diffs;
}
