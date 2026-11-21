import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/unit: mocked, no I/O. tests/integration: app.inject (real Postgres/Redis later).
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    // Integration files share one Postgres (expiry / publisher jobs are global): run files serially.
    fileParallelism: false,
  },
});
