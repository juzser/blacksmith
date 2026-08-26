import { defineConfig } from 'vitest/config';

// Separate from the root vitest.config.ts (factory/orchestrator/test/**)
// because ui/server's app.ts imports factory/orchestrator/dist/ (the BUILT
// output — see app.ts's header comment), so these tests require `pnpm build`
// to have run first. package.json's "test:server" script does that.
export default defineConfig({
  test: {
    include: ['ui/server/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      // app.ts is the whole route surface and the only thing these tests
      // build a fixture server for. index.ts (listen/bootstrap) and paths.ts
      // (two path joins) run only in a real `smith ui serve`.
      include: ['ui/server/src/app.ts'],
      // Branches sit lower than statements because v8 counts every `??`
      // default in query parsing as a branch, and the untaken half is the
      // malformed-query path. Floors are under today's numbers
      // (92/67/94/95).
      thresholds: {
        statements: 85,
        branches: 60,
        functions: 85,
        lines: 85,
      },
    },
  },
});
