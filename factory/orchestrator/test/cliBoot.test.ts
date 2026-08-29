import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { moduleGraphFrom } from './helpers/moduleGraph.js';

// `dist/cli.js` is what the `smith` binary runs, so its module graph is the
// price of admission for every single invocation — `smith --help` included.
// It used to import the whole orchestrator at module scope, and nine of those
// top-level imports reached `db/schema.js`, which pulls in drizzle-orm. The
// nine formed a clean cliff when each was imported in isolation, because they
// are exactly the modules that reach the database layer, and nothing else
// came close. Measured on the machine this was written on, warm page cache,
// median of five: `smith --help` went 0.314s -> 0.106s and `smith policy
// check` 0.339s -> 0.124s, against an empty-node baseline of 0.027s. `smith
// daemon status` stayed at ~0.31s, which is the point rather than a
// shortfall — it needs the database layer, so it still loads it.
//
// A CLI does one thing per invocation, so it should load one thing per
// invocation. Those nine are now `await import()` inside the branches that
// need them, and this file pins that: the database layer must stay out of the
// boot graph, or the cost comes back the next time someone adds a convenient
// top-level import.
//
// Graph, not stopwatch — see the note on `moduleGraphFrom`. That the commands
// behind those dynamic imports still work is pinned elsewhere, by the
// integration tests in `cli.test.ts` that run each of them for real.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const DIST = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist');
const CLI_PATH = path.join(DIST, 'cli.js');

describe('dist/cli.js — what every `smith` invocation pays to boot', () => {
  it('is built', () => {
    // A missing entry point would make the assertions below vacuously true.
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it('does not load the database layer at boot', () => {
    const { files, bare } = moduleGraphFrom(CLI_PATH);
    // Named directly, because it is the module the cost hangs off: every one
    // of the nine was heavy for the single reason that it reached this file.
    expect([...files].filter((f) => f.endsWith(path.join('db', 'schema.js')))).toEqual([]);
    // And the general form, so the next database-shaped dependency is caught
    // even if it arrives by some other route.
    expect([...bare].filter((s) => s.includes('drizzle'))).toEqual([]);
    expect([...bare].filter((s) => s.includes('sqlite'))).toEqual([]);
  });
});
