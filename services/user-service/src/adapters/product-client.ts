import { ServiceUnavailableError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';
import { type Redis, userKeys } from '@farmx/infra/redis';

import type { UserConfig } from '../config/index.js';
import { getJson } from './http.js';

/**
 * product-service storefront card (owned there; passed through unchanged) plus `available`
 * (published, active, not deleted, category visible).
 */
export interface ProductCard {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  available: boolean;
  [field: string]: unknown;
}

const CARD_TTL_SECONDS = 120;
/** Cached marker for an id product-service does not know (avoids re-asking for 120 s). */
const MISSING = '0';
const TIMEOUT_MS = 2_000;

/**
 * Batch product lookups for the wishlist: one Redis MGET, then ONE internal HTTP call for the
 * misses (`GET /internal/products/cards?ids=…`), results cached 120 s. Unknown ids are absent
 * from the returned map. Throws 503 when product-service is unreachable or not configured.
 */
export class ProductClient {
  constructor(private readonly deps: { config: UserConfig; logger: Logger; redis: () => Redis }) {}

  async cards(
    ids: readonly string[],
    timeoutMs: number = TIMEOUT_MS,
  ): Promise<Map<string, ProductCard>> {
    const unique = [...new Set(ids)];
    const result = new Map<string, ProductCard>();
    if (unique.length === 0) return result;

    const misses = await this.fromCache(unique, result);
    if (misses.length === 0) return result;

    const fetched = await this.fetchCards(misses, timeoutMs);
    for (const card of fetched) result.set(card.id, card);
    await this.store(misses, fetched);
    return result;
  }

  /** Fills `result` from Redis; returns the ids still unknown. Redis down → everything misses. */
  private async fromCache(ids: string[], result: Map<string, ProductCard>): Promise<string[]> {
    let values: (string | null)[];
    try {
      values = await this.deps.redis().mget(...ids.map((id) => userKeys.productCard(id)));
    } catch (err) {
      this.deps.logger.warn({ err }, 'product card cache unavailable');
      return ids;
    }
    const misses: string[] = [];
    ids.forEach((id, i) => {
      const raw = values[i];
      if (raw === null || raw === undefined) misses.push(id);
      else if (raw !== MISSING) result.set(id, JSON.parse(raw) as ProductCard);
    });
    return misses;
  }

  private async store(asked: string[], fetched: ProductCard[]): Promise<void> {
    const found = new Map(fetched.map((card) => [card.id, card]));
    const pipeline = this.deps.redis().pipeline();
    for (const id of asked) {
      const card = found.get(id);
      pipeline.set(
        userKeys.productCard(id),
        card === undefined ? MISSING : JSON.stringify(card),
        'EX',
        CARD_TTL_SECONDS,
      );
    }
    await pipeline.exec().catch((err: unknown) => {
      this.deps.logger.warn({ err }, 'product card cache write failed');
    });
  }

  /**
   * One page of the PUBLIC storefront list (`GET /catalog/products`), the same cards the catalog
   * listing pages show. `query` is a saved, validated filter set (home DYNAMIC_QUERY).
   */
  async list(
    query: Readonly<Record<string, string | number | boolean | readonly string[]>>,
    timeoutMs: number,
  ): Promise<{ items: ProductCard[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) for (const v of value as readonly string[]) params.append(key, v);
      else params.append(key, String(value));
    }
    const body = await getJson<{ data?: ProductCard[]; meta?: { nextCursor?: string | null } }>(
      `${this.deps.config.PRODUCT_SERVICE_URL}/catalog/products?${params.toString()}`,
      { timeoutMs },
    );
    return { items: body.data ?? [], nextCursor: body.meta?.nextCursor ?? null };
  }

  /** Active disease ids (Shop by Problem), for the home ref check. */
  async diseaseIds(timeoutMs: number): Promise<Set<string>> {
    const body = await getJson<{ data?: { id: string }[] }>(
      `${this.deps.config.PRODUCT_SERVICE_URL}/catalog/diseases`,
      { timeoutMs },
    );
    return new Set((body.data ?? []).map((d) => d.id));
  }

  /** Active FLOCK_STAGE lookup codes, for the home ref check. */
  async flockStageCodes(timeoutMs: number): Promise<Set<string>> {
    const body = await getJson<{ data?: { code: string }[] }>(
      `${this.deps.config.PRODUCT_SERVICE_URL}/catalog/lookups?group=FLOCK_STAGE`,
      { timeoutMs },
    );
    return new Set((body.data ?? []).map((l) => l.code));
  }

  private async fetchCards(ids: string[], timeoutMs: number): Promise<ProductCard[]> {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined)
      throw new ServiceUnavailableError('Product lookup is not configured');
    const query = ids.map((id) => `ids=${id}`).join('&');
    let res: Response;
    try {
      res = await fetch(`${config.PRODUCT_SERVICE_URL}/internal/products/cards?${query}`, {
        headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      logger.error({ err }, 'product-service unreachable');
      throw new ServiceUnavailableError('Product service unavailable');
    }
    if (!res.ok) {
      logger.error({ status: res.status }, 'product-service card lookup failed');
      throw new ServiceUnavailableError('Product service unavailable');
    }
    const body = (await res.json()) as { data?: ProductCard[] };
    return body.data ?? [];
  }
}
