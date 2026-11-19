import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { isUniqueViolation } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { ProductCard } from '../../adapters/product-client.js';
import { uuidv7 } from '../../adapters/uuid.js';
import type { WishlistItemView, WishlistQuery, WishlistRow } from './wishlist.types.js';

type Deps = Pick<
  Cradle,
  'wishlistRepository' | 'productClient' | 'runInTransaction' | 'config' | 'logger'
>;

// ── Pure helpers (exported for unit tests) ──

export const hydrate = (
  rows: readonly WishlistRow[],
  cards: ReadonlyMap<string, ProductCard>,
): WishlistItemView[] =>
  rows.map((row) => {
    const product = cards.get(row.productId) ?? null;
    return {
      id: row.id,
      productId: row.productId,
      addedAt: row.createdAt,
      available: product?.available ?? false,
      product,
    };
  });

/**
 * Wishlist. Adds are validated against product-service (must exist and be available), are
 * idempotent (unique userId+productId) and capped per user under a per-user lock. Reads hydrate
 * one page with ONE batched, Redis-cached product lookup; if product-service is down the page
 * still loads with `product: null`.
 */
export class WishlistService {
  constructor(private readonly deps: Deps) {}

  async list(userId: string, query: WishlistQuery): Promise<Paginated<WishlistItemView>> {
    const page = await this.deps.wishlistRepository.page(userId, query);
    const cards = await this.cardsOrEmpty(page.items.map((r) => r.productId));
    return { ...page, items: hydrate(page.items, cards) };
  }

  productIds(userId: string): Promise<string[]> {
    return this.deps.wishlistRepository.productIds(userId);
  }

  /** `created: false` when it was already saved (idempotent). */
  async add(
    userId: string,
    productId: string,
  ): Promise<{ created: boolean; item: WishlistItemView }> {
    const card = (await this.deps.productClient.cards([productId])).get(productId);
    if (card === undefined)
      throw new NotFoundError('Product', { details: { reason: 'PRODUCT_NOT_FOUND' } });
    if (!card.available)
      throw new ValidationError(
        [{ path: 'body.productId', message: 'product is not available' }],
        'Product is not available',
      );

    const repo = this.deps.wishlistRepository;
    const max = this.deps.config.MAX_WISHLIST_ITEMS;
    try {
      const { created, row } = await this.deps.runInTransaction(async (tx) => {
        await repo.lock(tx, userId);
        const existing = await repo.find(tx, userId, productId);
        if (existing !== null) return { created: false, row: existing };
        if ((await repo.count(tx, userId)) >= max)
          throw new ConflictError(`Your wishlist can hold at most ${String(max)} products`, {
            details: { reason: 'WISHLIST_FULL', max },
          });
        return { created: true, row: await repo.create(tx, { id: uuidv7(), userId, productId }) };
      });
      const [item] = hydrate([row], new Map([[productId, card]]));
      if (item === undefined) throw new Error('unreachable');
      return { created, item };
    } catch (error) {
      // The lock makes this near impossible; still map a unique race to "already saved".
      if (isUniqueViolation(error)) return this.add(userId, productId);
      throw error;
    }
  }

  remove(userId: string, productId: string): Promise<void> {
    return this.deps.wishlistRepository.remove(userId, productId);
  }

  async clear(userId: string): Promise<void> {
    await this.deps.wishlistRepository.clear(userId);
  }

  private async cardsOrEmpty(ids: string[]): Promise<ReadonlyMap<string, ProductCard>> {
    try {
      return await this.deps.productClient.cards(ids);
    } catch (err) {
      if (!(err instanceof ServiceUnavailableError)) throw err;
      this.deps.logger.warn({ err }, 'wishlist served without product data');
      return new Map();
    }
  }
}
