import { defineConfig } from 'vitest/config';

// Separate from the root vitest.config.ts (factory/orchestrator/test/**)
// because ui/server's app.ts imports factory/orchestrator/dist/ (the BUILT
// output — see app.ts's header comment), so these tests require `pnpm build`
// to have run first. package.json's "test:server" script does that.
export default defineConfig({
  test: {
    include: ['ui/server/test/**/*.test.ts'],
  },
});
