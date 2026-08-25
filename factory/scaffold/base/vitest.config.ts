import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // `json-summary` is not decoration: the text reporter suppresses rows for
      // files at 100% on every metric, so the file an acceptance criterion
      // names vanishes from the transcript exactly when it is doing best. The
      // gate reads coverage/coverage-summary.json instead (D-40/P9-25).
      reporter: ['text', 'text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      // `src/main.ts` is the Vite mount entrypoint the `--ui` variant writes:
      // three lines that call `createApp(App).mount('#app')`, with nothing a
      // node-environment test could assert that a browser wouldn't. Counted, it
      // drags a freshly scaffolded UI project to 50% lines and the floor below
      // fails the project on its very first run — measured, not predicted.
      // Ambient declarations have no statements to cover at all.
      exclude: ['src/main.ts', 'src/**/*.d.ts'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
