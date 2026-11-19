import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { moduleBoundaries } from './rules/module-boundaries.js';

/**
 * Shared flat config for the whole monorepo.
 * @param {{ tsconfigRootDir: string }} options
 */
export function createConfig({ tsconfigRootDir }) {
  return defineConfig(
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        '**/.turbo/**',
        '**/src/generated/**',
        '**/prisma/migrations/**',
      ],
    },

    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,

    {
      languageOptions: {
        globals: globals.node,
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      plugins: { 'import-x': importX },
      settings: {
        'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
      },
      rules: {
        'no-console': 'error',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        // Fastify handlers/hooks are `async` by convention (promise style instead of `done`)
        // even without an await. Promise bugs are still caught by the two rules above.
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        'import-x/no-cycle': 'error',
        'import-x/no-duplicates': 'error',
        'import-x/no-self-import': 'error',
      },
    },

    // Services are isolated; features talk only through features/<name>/index.ts.
    {
      files: ['services/*/**/*.ts'],
      plugins: { farmx: { rules: { 'module-boundaries': moduleBoundaries } } },
      rules: { 'farmx/module-boundaries': 'error' },
    },

    // Clean separation: only repositories (and the DI container) may use the database client.
    // Services, controllers and routes use @farmx/database (helpers, Tx type) — never the client.
    // scripts/ and tests/ are outside src/ and therefore not restricted.
    {
      files: ['services/*/src/**/*.ts'],
      ignores: ['**/*.repository.ts', '**/container.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '@prisma/client',
                  '@prisma/adapter-pg',
                  '@farmx/database/client',
                  '**/generated/prisma',
                  '**/generated/prisma/*',
                ],
                message:
                  'Only *.repository.ts files (and container.ts) may use the database client.',
              },
            ],
          },
        ],
      },
    },

    // Tests may be looser.
    {
      files: ['**/__tests__/**/*.ts', '**/tests/**/*.ts', '**/*.test.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/unbound-method': 'off',
        '@typescript-eslint/no-empty-function': 'off',
      },
    },

    // Plain JS config files: no type-aware rules.
    {
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
    },

    prettier,
  );
}
