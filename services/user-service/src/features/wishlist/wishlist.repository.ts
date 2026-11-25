import type { Paginated } from '@farmx/common/types';
import { type Tx, advisoryXactLock, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { WishlistQuery, WishlistRow } from './wishlist.types.js';

const SELECT = { id: true, productId: true, createdAt: true } as const;

/** Only place that queries `wishlist_items`. Every query is scoped by `userId`. */
export class WishlistRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Serialises one user's adds so the size limit is exact. */
  lock(tx: Tx, userId: string): Promise<void> {
    return advisoryXactLock(tx, `user:wish:${userId}`);
  }

  find(tx: Tx, userId: string, productId: string): Promise<WishlistRow | null> {
    return tx.wishlistItem.findUnique({
      where: { userId_productId: { userId, productId } },
      select: SELECT,
    });
  }

  count(tx: Tx, userId: string): Promise<number> {
    return tx.wishlistItem.count({ where: { userId } });
  }

  create(tx: Tx, data: { id: string; userId: string; productId: string }): Promise<WishlistRow> {
    return tx.wishlistItem.create({ data, select: SELECT });
  }

  /** Newest first (uuid v7 ids are time-ordered), keyset pages. */
  async page(userId: string, query: WishlistQuery): Promise<Paginated<WishlistRow>> {
    const rows = await withPrismaErrors(() =>
      this.db.wishlistItem.findMany({
        where: { userId },
        orderBy: { id: 'desc' },
        select: SELECT,
        ...cursorArgs(query),
      }),
    );
    return toPage(rows, query.limit);
  }

  /** Newest first, at most `max` + 1 rows (the extra one only tells the caller it was cut). */
  async productIds(userId: string, max: number): Promise<string[]> {
    const rows = await withPrismaErrors(() =>
      this.db.wishlistItem.findMany({
        where: { userId },
        orderBy: { id: 'desc' },
        select: { productId: true },
        take: max + 1,
      }),
    );
    return rows.map((r) => r.productId);
  }

  async remove(userId: string, productId: string): Promise<void> {
    await withPrismaErrors(() => this.db.wishlistItem.deleteMany({ where: { userId, productId } }));
  }

  async clear(userId: string): Promise<number> {
    const { count } = await withPrismaErrors(() =>
      this.db.wishlistItem.deleteMany({ where: { userId } }),
    );
    return count;
  }
}
