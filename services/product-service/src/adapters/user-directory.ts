import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';
import { type Redis, productKeys } from '@farmx/infra/redis';

import type { ProductConfig } from '../config/index.js';

const NAME_TTL_SECONDS = 86_400;
const FALLBACK = 'FarmX Customer';

/**
 * Reviewer display names: auth-service `/internal/users/:id/contact` → masked ("Ramesh K."),
 * cached 24 h in redis-cache. Only the masked name is kept; any failure → "FarmX Customer"
 * (not cached, so the next review retries).
 */
export class UserDirectoryClient {
  constructor(
    private readonly deps: {
      config: ProductConfig;
      logger: Logger;
      redis: () => Redis;
      mask: (fullName: string | null) => string;
    },
  ) {}

  async maskedName(userId: string): Promise<string> {
    const { redis, logger, config, mask } = this.deps;
    const key = productKeys.reviewAuthor(userId);
    try {
      const cached = await redis().get(key);
      if (cached !== null) return cached;
    } catch (err) {
      logger.warn({ err }, 'review author cache unavailable');
    }
    if (config.INTERNAL_SERVICE_TOKEN === undefined) return FALLBACK;
    try {
      const res = await fetch(`${config.AUTH_SERVICE_URL}/internal/users/${userId}/contact`, {
        headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
        signal: AbortSignal.timeout(1_500),
      });
      if (!res.ok) return FALLBACK;
      const body = (await res.json()) as { data?: { fullName?: string | null } };
      const name = mask(body.data?.fullName ?? null);
      await redis()
        .set(key, name, 'EX', NAME_TTL_SECONDS)
        .catch(() => undefined);
      return name;
    } catch (err) {
      logger.warn({ err }, 'auth-service name lookup failed; using fallback');
      return FALLBACK;
    }
  }
}
