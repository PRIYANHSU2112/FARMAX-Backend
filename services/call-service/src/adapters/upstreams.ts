import {
  AppError,
  ErrorCode,
  NotFoundError,
  ServiceUnavailableError,
} from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';
import { type Cache, callKeys } from '@farmx/infra/redis';

import type { CallConfig } from '../config/index.js';

/**
 * Service-to-service reads (`/internal/*`, shared token, never through the gateway).
 * Called ONLY before a DB transaction opens (D-53: no network inside transactions).
 * Timeout 2 s, one retry on a network error / 5xx; 404 → null; other 4xx → passed through.
 */
class InternalHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly name: string,
    private readonly deps: { config: Readonly<CallConfig>; logger: Logger },
  ) {}

  async get<T>(path: string): Promise<T | null> {
    const token = this.deps.config.INTERNAL_SERVICE_TOKEN;
    if (token === undefined)
      throw new ServiceUnavailableError(`${this.name} is not configured (INTERNAL_SERVICE_TOKEN)`);
    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          headers: { [INTERNAL_TOKEN_HEADER]: token },
          signal: AbortSignal.timeout(2_000),
        });
      } catch (err) {
        if (attempt < 2) continue;
        this.deps.logger.warn({ err, service: this.name, path }, 'internal call failed');
        throw new ServiceUnavailableError(`${this.name} is unavailable; try again`, { cause: err });
      }
      if (res.status === 404) return null;
      const body = (await res.json().catch(() => ({}))) as {
        data?: T;
        error?: { code?: string; message?: string };
      };
      if (res.ok) return body.data ?? null;
      if (res.status >= 500 && attempt < 2) continue;
      if (res.status >= 500 || res.status === 429)
        throw new ServiceUnavailableError(`${this.name} is unavailable; try again`);
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        body.error?.message ?? `${this.name} refused the request`,
        400,
      );
    }
  }
}

// ── product-service ──

/** The fields of product-service's storefront card that call-service uses. */
export interface ProductCard {
  id: string;
  name: string;
  slug: string;
  categoryId: string;
  brand: { id: string; name: string };
  imageUrl: string | null;
  isColdChain: boolean;
  isPrescriptionRequired: boolean;
  /** Published, active, not deleted, category visible. */
  available: boolean;
}

export class ProductClient {
  private readonly http: InternalHttp;

  constructor(private readonly deps: { config: Readonly<CallConfig>; logger: Logger; cache: Cache }) {
    this.http = new InternalHttp(deps.config.PRODUCT_SERVICE_URL, 'product-service', deps);
  }

  /** Storefront card (cached 60 s). Throws 404 when unknown or not sellable. */
  async card(productId: string): Promise<ProductCard> {
    const cards = await this.deps.cache.getOrSet(
      callKeys.productCard(productId),
      60,
      async () =>
        (await this.http.get<ProductCard[]>(
          `/internal/products/cards?ids=${encodeURIComponent(productId)}`,
        )) ?? [],
    );
    const card = cards.find((c) => c.id === productId);
    if (!card?.available) throw new NotFoundError('Product');
    return card;
  }
}

// ── catalog-service ──

export class CatalogClient {
  private readonly http: InternalHttp;

  constructor(private readonly deps: { config: Readonly<CallConfig>; logger: Logger; cache: Cache }) {
    this.http = new InternalHttp(deps.config.CATALOG_SERVICE_URL, 'catalog-service', deps);
  }

  /**
   * Root → self category ids (cached 10 min). Degrades to `[categoryId]` when catalog is down:
   * matching then only misses experts tagged with a parent category.
   */
  async pathIds(categoryId: string): Promise<string[]> {
    try {
      const context = await this.deps.cache.getOrSet(
        callKeys.categoryPath(categoryId),
        600,
        () =>
          this.http.get<{ pathIds: string[] }>(
            `/internal/catalog/categories/${encodeURIComponent(categoryId)}/context`,
          ),
      );
      return context?.pathIds.length ? context.pathIds : [categoryId];
    } catch (err) {
      this.deps.logger.warn({ err, categoryId }, 'category path unavailable; exact match only');
      return [categoryId];
    }
  }
}

// ── farm-service ──

/** The fields of farm-service's FarmView that call-service uses (never sent to clients raw). */
export interface FarmView {
  id: string;
  farmCode: string | null;
  name: string;
  category: string;
  status: string;
  productionTypes: string[];
  totalBirdCapacity: number | null;
  owner: { userId: string; fullName: string };
  location: { territoryCode: string | null; districtName: string | null; village: string | null } | null;
}

export class FarmClient {
  private readonly http: InternalHttp;

  constructor(private readonly deps: { config: Readonly<CallConfig>; logger: Logger; cache: Cache }) {
    this.http = new InternalHttp(deps.config.FARM_SERVICE_URL, 'farm-service', deps);
  }

  /**
   * The caller's ACTIVE farm (cached 60 s). Someone else's farm answers 404, exactly like a
   * missing one (existence is never revealed).
   */
  async ownedActive(farmId: string, userId: string): Promise<FarmView> {
    const farm = await this.deps.cache.getOrSet(callKeys.farm(farmId), 60, () =>
      this.http.get<FarmView>(`/internal/farms/${encodeURIComponent(farmId)}`),
    );
    if (farm?.owner.userId !== userId) throw new NotFoundError('Farm');
    if (farm.status !== 'ACTIVE')
      throw new AppError(ErrorCode.CONFLICT, 'Farm is not active', 409, {
        details: { reason: 'FARM_NOT_ACTIVE' },
      });
    return farm;
  }
}

// ── auth-service ──

export class AuthDirectory {
  private readonly http: InternalHttp;

  constructor(deps: { config: Readonly<CallConfig>; logger: Logger }) {
    this.http = new InternalHttp(deps.config.AUTH_SERVICE_URL, 'auth-service', deps);
  }

  /** True when the auth user exists (expert onboarding). */
  async userExists(userId: string): Promise<boolean> {
    return (await this.http.get<object>(`/internal/users/${encodeURIComponent(userId)}/contact`)) !== null;
  }
}
