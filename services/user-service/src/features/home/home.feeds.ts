import { userKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { FarmFacts, FeedKey, FeedResult, HomeContext } from './home.types.js';

/**
 * The allowlist. `available: false` = no service provides this data yet (⏳ Future): the key
 * answers NOT_AVAILABLE and makes no call. Flip it to true when the backend exists.
 */
export const FEED_DEFS: Readonly<Record<FeedKey, { available: boolean; requiresLogin: boolean }>> =
  {
    /** order-service `GET /orders?tab=active&limit=1`. */
    ORDER_LIVE: { available: true, requiresLogin: true },
    /** farm-service `GET /farms/content/feed?sort=latest` (customer route). */
    NEWS_LATEST: { available: true, requiresLogin: true },
    /** The caller's farm (already loaded for region/depot); stage / week / shed are null. */
    FLOCK_CONTEXT: { available: true, requiresLogin: true },
    /** ⏳ call-service has no bookings yet. */
    APPOINTMENT_NEXT: { available: false, requiresLogin: true },
    /** ⏳ order-service has no "buy again" endpoint yet. */
    BUY_AGAIN: { available: false, requiresLogin: true },
    /** ⏳ call-service has no general "vets online / from ₹" endpoint (recommended needs a product). */
    VET_AVAILABILITY: { available: false, requiresLogin: false },
    /** ⏳ no requirement calendar / vaccination schedule backend yet. */
    REQUIREMENT_DUE: { available: false, requiresLogin: true },
  };

const FEED_TIMEOUT_MS = 400;
const ORDER_TTL_SECONDS = 30;
const NEWS_TTL_SECONDS = 60;
const NEWS_LIMIT = 3;

/** FLOCK_CONTEXT payload. Fields with no data source yet are null (⏳ Future). */
export const flockContext = (farm: FarmFacts) => ({
  farmId: farm.farmId,
  farmName: farm.farmName,
  farmCategory: farm.category,
  farmTypes: farm.productionTypes,
  birdCount: farm.totalBirdCapacity,
  region: farm.territoryCode,
  stage: null,
  ageWeeks: null,
  shed: null,
  productsForStage: null,
});

/**
 * Live data for widgets, by allowlisted key only. Each key is resolved in parallel with its own
 * timeout; one slow service makes only that key UNAVAILABLE. The caller's own token is
 * forwarded (the owning service checks access itself).
 */
export class HomeFeedsService {
  constructor(
    private readonly deps: Pick<Cradle, 'orderClient' | 'farmClient' | 'redis' | 'logger'>,
  ) {}

  feeds(keys: readonly FeedKey[], ctx: HomeContext): Promise<FeedResult[]> {
    return Promise.all([...new Set(keys)].map((key) => this.one(key, ctx)));
  }

  private async one(key: FeedKey, ctx: HomeContext): Promise<FeedResult> {
    const def = FEED_DEFS[key];
    if (!def.available) return { key, status: 'NOT_AVAILABLE', data: null };
    if (def.requiresLogin && (ctx.userId === null || ctx.bearer === null))
      return { key, status: 'AUTH_REQUIRED', data: null };
    const userId = ctx.userId ?? 'guest';
    const bearer = ctx.bearer ?? '';
    try {
      switch (key) {
        case 'FLOCK_CONTEXT':
          return ctx.farm === null
            ? { key, status: 'EMPTY', data: null }
            : { key, status: 'OK', data: flockContext(ctx.farm) };
        case 'ORDER_LIVE': {
          const order = await this.cached(key, userId, ORDER_TTL_SECONDS, () =>
            this.deps.orderClient.latestActiveOrder(bearer, FEED_TIMEOUT_MS),
          );
          return order === null
            ? { key, status: 'EMPTY', data: null }
            : { key, status: 'OK', data: order };
        }
        case 'NEWS_LATEST': {
          const items = await this.cached(key, userId, NEWS_TTL_SECONDS, () =>
            this.deps.farmClient.latestNews(bearer, NEWS_LIMIT, FEED_TIMEOUT_MS),
          );
          return items.length === 0
            ? { key, status: 'EMPTY', data: { items: [] } }
            : { key, status: 'OK', data: { items } };
        }
        default:
          return { key, status: 'NOT_AVAILABLE', data: null };
      }
    } catch (err) {
      this.deps.logger.warn({ err, feed: key }, 'home feed unavailable');
      return { key, status: 'UNAVAILABLE', data: null };
    }
  }

  /** Per-user short cache (the data is personal). Redis down → straight to the source. */
  private async cached<T>(
    key: FeedKey,
    scope: string,
    ttl: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const redisKey = userKeys.homeFeed(key, scope);
    const redis = this.deps.redis;
    const hit = await redis.get(redisKey).catch(() => null);
    if (hit !== null) return (JSON.parse(hit) as { v: T }).v;
    const value = await load();
    await redis.set(redisKey, JSON.stringify({ v: value }), 'EX', ttl).catch(() => undefined);
    return value;
  }
}
