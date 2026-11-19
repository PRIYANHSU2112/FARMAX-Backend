import { existsSync } from 'node:fs';

import { defineConfig } from 'prisma/config';

// The ONE Prisma config for the shared FarmX database. Prisma 7 does not read .env files, so the
// root .env is loaded here (gitignored). loadEnvFile never overrides variables already set in the
// shell, so CI/production values always win.
if (existsSync('../../.env')) process.loadEnvFile('../../.env');

// DATABASE_URL is only needed for migrate/studio; `prisma generate` works without it.
export default defineConfig({
  schema: 'prisma/schema',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
