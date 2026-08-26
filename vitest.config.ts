import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['factory/orchestrator/test/**/*.test.ts'],
    // Refuses an unsupported Node before any test runs — see the file's note.
    setupFiles: ['factory/orchestrator/test/setup.ts'],
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
