import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/unit: mocked, no I/O. tests/integration: app.inject (real Postgres/Redis later).
    include: ['tests/**/*.test.ts'],
    // Building the app (Swagger + every route) can take a few seconds on a cold, busy runner.
    testTimeout: 20_000,
    passWithNoTests: true,
  },
});
