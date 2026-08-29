// Reads the built ESM graph as text, for the tests that assert what an entry
// point does *not* load.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ModuleGraph {
  /** Absolute paths of every local module reachable by static import. */
  files: Set<string>;
  /** Every bare (package) specifier those modules import, `node:` aside. */
  bare: Set<string>;
}

/**
 * Walks the built ESM graph from `entry`, following relative specifiers only.
 *
 * Static rather than timed on purpose. The property under test is "this entry
 * point does not load the database layer", and a wall-clock assertion would
 * express that as "it is fast", which is a different claim that a loaded CI box
 * can falsify without anything being wrong. Reading the graph answers the
 * actual question and cannot flake.
 *
 * `await import('…')` is a cut point here, and deliberately so: the matcher
 * looks for `from '…'`, which is the form tsc emits for a static import and
 * never for a dynamic one. A module reached only by a dynamic import is a
 * module the entry point does not pay for at boot, which is exactly the
 * distinction the callers are asserting.
 */
export function moduleGraphFrom(entry: string): ModuleGraph {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file) || !existsSync(file)) continue;
    files.add(file);
    const src = readFileSync(file, 'utf8');
    // Matches `from '…'` in both static imports and re-exports, which is every
    // form tsc emits for this codebase.
    for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1] as string;
      if (spec.startsWith('.')) {
        queue.push(path.resolve(path.dirname(file), spec));
      } else if (!spec.startsWith('node:')) {
        bare.add(spec);
      }
    }
  }
  return { files, bare };
}

/** The package specifiers half of {@link moduleGraphFrom}. */
export function bareSpecifiersFrom(entry: string): Set<string> {
  return moduleGraphFrom(entry).bare;
}
