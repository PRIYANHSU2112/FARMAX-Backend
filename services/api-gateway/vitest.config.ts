import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/unit: mocked, no I/O. tests/integration: app.inject / real services.
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
  },
});
