import { defineConfig } from 'vitest/config';

/** `pnpm bench:invoices`: load benchmarks (real HTTP + Postgres); never part of `pnpm test`. */
export default defineConfig({
  test: {
    include: ['tests/perf/**/*.perf.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
