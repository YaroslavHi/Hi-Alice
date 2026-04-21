import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals:     true,
    environment: 'node',
    setupFiles:  ['./vitest.setup.ts'],
    coverage: {
      provider:  'v8',
      reporter:  ['text', 'lcov'],
      include:   ['src/**/*.ts'],
      exclude:   ['src/index.ts', 'src/types/**', 'src/__tests__/**'],
    },
    isolate:     true,
    testTimeout: 30_000,
  },
});
