import type { Logger } from '@farmx/common/logger';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';
import { createPrisma } from './helpers/create-prisma.js';

/**
 * `@farmx/database/client` — the shared Prisma client. Only repositories, the DI container and
 * scripts may import this entry point (ESLint `no-restricted-imports`).
 */
export * from './generated/prisma/client.js';

export interface DatabaseOptions {
  /** The single shared DATABASE_URL. */
  url: string;
  logger: Logger;
  /**
   * pg pool size for this process. Budget: Σ(processes × poolSize) across all services must stay
   * under 80% of Postgres `max_connections`.
   */
  poolSize?: number;
  /** Queries slower than this are logged as warnings. Default 200 ms. */
  slowQueryMs?: number;
}

/** Builds a NEW client + pool. Prefer `getDatabase()`; use this only when you need isolation. */
export const createDatabaseClient = (options: DatabaseOptions) =>
  createPrisma(
    (log) =>
      new PrismaClient({
        adapter: new PrismaPg({ connectionString: options.url, max: options.poolSize ?? 10 }),
        log,
      }),
    {
      logger: options.logger,
      ...(options.slowQueryMs === undefined ? {} : { slowQueryMs: options.slowQueryMs }),
    },
  );

export type Database = ReturnType<typeof createDatabaseClient>;

let instance: { db: Database; url: string } | undefined;

/**
 * Safe pooling: ONE client and ONE connection pool per process. Every caller (DI container,
 * scripts, workers) gets the same instance, so connections are never multiplied by accident.
 */
export function getDatabase(options: DatabaseOptions): Database {
  if (instance !== undefined) {
    if (instance.url !== options.url) {
      throw new Error('getDatabase: already initialised with a different DATABASE_URL');
    }
    return instance.db;
  }
  const db = createDatabaseClient(options);
  instance = { db, url: options.url };
  return db;
}

/** Closes the singleton pool (graceful shutdown, end of a script or test). Safe to call twice. */
export async function closeDatabase(): Promise<void> {
  const current = instance;
  instance = undefined;
  if (current !== undefined) await current.db.$disconnect();
}
