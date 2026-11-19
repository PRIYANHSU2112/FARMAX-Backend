import { randomUUID } from 'node:crypto';

import type { Paginated } from '@farmx/common/types';
import { toPage } from '@farmx/database';

import type { ExampleListQuery, ExampleRecord } from './example.types.js';

/**
 * The ONLY place a feature reads/writes data (clean separation).
 *
 * In-memory so the template adds no table to the shared database. For a real feature:
 * 1. add the model to packages/database/prisma/schema/<service>/<feature>.prisma, then
 *    `pnpm db:migrate --name <change>`;
 * 2. inject the shared client and query only your own models, e.g.
 *
 *    import { withPrismaErrors } from '@farmx/database';
 *    import type { Cradle } from '@fastify/awilix';
 *
 *    export class ExampleRepository {
 *      private readonly db: Cradle['db'];
 *      constructor({ db }: Pick<Cradle, 'db'>) { this.db = db; }
 *      findById(id: string) {
 *        return withPrismaErrors(() => this.db.example.findUnique({ where: { id } }));
 *      }
 *    }
 *    (pass `tx` from runInTransaction instead of `this.db` to join a transaction.)
 */
export class ExampleRepository {
  private readonly rows = new Map<string, ExampleRecord>();

  findById(id: string): Promise<ExampleRecord | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  /** Newest first, cursor-paginated like the Prisma repositories. */
  list(query: ExampleListQuery): Promise<Paginated<ExampleRecord>> {
    const q = query.q?.toLowerCase();
    const sorted = [...this.rows.values()]
      .filter((row) => q === undefined || row.name.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    const start =
      query.cursor === undefined ? 0 : sorted.findIndex((row) => row.id === query.cursor) + 1;
    return Promise.resolve(toPage(sorted.slice(start, start + query.limit + 1), query.limit));
  }

  create(data: { name: string; ownerId: string | null }): Promise<ExampleRecord> {
    const now = new Date();
    const row: ExampleRecord = { id: randomUUID(), ...data, createdAt: now, updatedAt: now };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }
}
