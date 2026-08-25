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
  },
});
