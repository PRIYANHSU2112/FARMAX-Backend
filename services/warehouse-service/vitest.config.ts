import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/unit: mocked, no I/O. tests/integration: real Postgres + Redis when
    // WAREHOUSE_IT_DATABASE_URL is set (files run one at a time: shared database).
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
