import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['factory/orchestrator/test/**/*.test.ts'],
    // Builds dist/ once for the whole run — see the file's note for why this
    // is not a per-file beforeAll any more.
    globalSetup: ['factory/orchestrator/test/globalSetup.ts'],
    // Refuses an unsupported Node before any test runs — see the file's note.
    setupFiles: ['factory/orchestrator/test/setup.ts'],
    // A hang-detector, not a performance budget.
    //
    // vitest's 5s default is sized for in-process unit tests. Much of this
    // suite is not that: `cli.test.ts` and `guardHook.test.ts` drive the built
    // binary through `spawnSync`, and a single `node dist/cli.js` boot costs
    // ~1.4s before the code under test runs — the same figure
    // `policyHookEntry.test.ts` measured, and it is module loading, not the
    // command. `drizzle-orm/better-sqlite3` alone is ~0.9s of it. A test that
    // spawns twenty-three times therefore spends ~35s on node startup and
    // nothing has gone wrong.
    //
    // The suite already knew this. Twenty-six tests and hooks carried
    // hand-written 20-40s overrides, several naming the cause outright ("ten
    // sequential CLI process spawns — over vitest's 5s default on a CI
    // runner"). Those were twenty-six correct diagnoses of one global
    // misconfiguration, and the spawning tests that never got one failed
    // `scripts/check.sh` on a clean checkout for a contributor who had changed
    // nothing. The budget belongs here, once, with its reason.
    //
    // 120s is deliberately loose. The worst case measured ~44s under 8-way
    // concurrency on a loaded 10-core box, so this clears it ~2.7x and holds
    // on a CI runner slower than any machine used to pick the number. Sizing
    // it tighter would turn it back into a wall-clock assertion about speed —
    // which is a different claim, and one `policyHookEntry.test.ts` declines
    // to make for exactly this reason: "a loaded CI box can falsify [it]
    // without anything being wrong." A genuine hang still surfaces in two
    // minutes.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      // Blacksmith had the same gap it ships to its scaffolds: no per-file
      // machine-readable coverage, so `smith coverage check` had nothing to
      // read here either (D-40/P9-25).
      reporter: ['text', 'text-summary', 'json-summary'],
      include: ['factory/orchestrator/src/**/*.ts'],
      exclude: ['factory/orchestrator/src/cli.ts', 'factory/orchestrator/src/types/**'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
