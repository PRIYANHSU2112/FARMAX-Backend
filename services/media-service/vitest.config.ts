import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/unit: mocked, no I/O. tests/integration: app.inject (real Postgres/Redis later).
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    // Integration tests build the whole app; under `pnpm check` (lint + typecheck + build + ffmpeg in
    // parallel) the 5 s default is too tight.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
