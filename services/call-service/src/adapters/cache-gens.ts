import type { Logger } from '@farmx/common/logger';
import { type Redis, callKeys } from '@farmx/infra/redis';

/**
 * Availability cache generations (D-53). Every availability / pool / recommended key embeds
 * `poolGen` (and slot pages also `dayGen(date)`), so invalidation is one INCR, never a key scan.
 *   poolGen  ← expert profile / skills / channels / territories / languages / cap / active /
 *              bookable, availability rules, breaks, time-off, holidays, settings, channel options
 *   dayGen   ← any hold / booking change touching that IST date (step 3+)
 * Bumps run AFTER commit. A failed bump is logged, never thrown: short TTLs bound staleness and the
 * hold insert (exclusion constraint) stays the source of truth.
 */
export class CacheGens {
  constructor(private readonly deps: { redis: Redis; logger: Logger }) {}

  async poolGen(): Promise<string> {
    return (await this.read(callKeys.poolGen())) ?? '0';
  }

  async dayGen(date: string): Promise<string> {
    return (await this.read(callKeys.dayGen(date))) ?? '0';
  }

  async bumpPool(): Promise<void> {
    try {
      await this.deps.redis.incr(callKeys.poolGen());
    } catch (err) {
      this.deps.logger.warn({ err }, 'poolGen bump failed (TTL bounds staleness)');
    }
  }

  /** `dates` = IST calendar dates `YYYY-MM-DD`; generations expire 2 days after their last bump. */
  async bumpDays(dates: Iterable<string>): Promise<void> {
    const unique = [...new Set(dates)];
    if (unique.length === 0) return;
    try {
      const pipeline = this.deps.redis.multi();
      for (const date of unique) {
        pipeline.incr(callKeys.dayGen(date));
        pipeline.expire(callKeys.dayGen(date), 172_800);
      }
      await pipeline.exec();
    } catch (err) {
      this.deps.logger.warn({ err, dates: unique }, 'dayGen bump failed (TTL bounds staleness)');
    }
  }

  private async read(key: string): Promise<string | null> {
    try {
      return await this.deps.redis.get(key);
    } catch (err) {
      this.deps.logger.warn({ err, key }, 'cache generation read failed');
      return null;
    }
  }
}
