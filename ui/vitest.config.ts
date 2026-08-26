import { defineConfig } from 'vitest/config';

// Pure-logic unit tests for ui/src (taxonomy tone mapping, api client
// parsing, kanban status folding) — separate from ui/server/vitest.config.ts
// (no dist/ build dependency here) and from the root config (orchestrator
// only). Component/page behavior is verified by ui/e2e/*.spec.ts
// (Playwright) per the phase-6a brief.
export default defineConfig({
  test: {
    include: ['ui/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      // Scoped to the layer this suite is *for*. Everything left out is
      // covered by Playwright instead, and counting it here would only
      // produce a number that measures the wrong suite:
      //   - src/*.ts (main, router, nav, icons) is app wiring;
      //   - src/composables/* needs a DOM this config deliberately lacks
      //     (environment: 'node');
      //   - src/lib/api.ts is the fetch client, exercised against a real
      //     server by ui/e2e.
      // .vue files are absent for a harder reason: no tool in this repo
      // type-checks or covers an SFC — see CONTRIBUTING.md § What the gate
      // does not cover.
      include: ['ui/src/lib/**/*.ts'],
      exclude: ['ui/src/lib/api.ts'],
      // Floors sit under today's numbers (93/84/97/94) with room to breathe:
      // the gate is here to catch a regression, not to punish a refactor.
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
