import type { Logger } from '@farmx/common/logger';
import { type Redis, supportKeys } from '@farmx/infra/redis';

/**
 * Cache generations: every cached config / content key embeds its generation, so invalidation is
 * one INCR after commit, never a key scan. A failed bump is logged; TTLs bound staleness.
 *   config  ← settings, calendars, holidays, topics, priority rules, SLA policies
 *   content ← FAQ categories / items, legal documents
 */
export class CacheGen {
  constructor(private readonly deps: { redis: Redis; logger: Logger }) {}

  config(): Promise<string> {
    return this.read(supportKeys.configGen());
  }

  content(): Promise<string> {
    return this.read(supportKeys.contentGen());
  }

  bumpConfig(): Promise<void> {
    return this.bump(supportKeys.configGen());
  }

  bumpContent(): Promise<void> {
    return this.bump(supportKeys.contentGen());
  }

  private async read(key: string): Promise<string> {
    try {
      return (await this.deps.redis.get(key)) ?? '0';
    } catch {
      return 'nocache';
    }
  }

  private async bump(key: string): Promise<void> {
    try {
      await this.deps.redis.incr(key);
    } catch (err) {
      this.deps.logger.warn({ err, key }, 'cache generation bump failed (TTL bounds staleness)');
    }
  }
}

/**
 * Two-level snapshot: an in-process copy (re-validated against the Redis generation at most every
 * `localTtlMs`), then the shared Redis copy (`cache.getOrSet` with stampede protection), then the
 * loader. Hot paths (ticket create, every message) pay no DB read and usually no Redis read.
 */
export class Snapshot<T> {
  private local: { gen: string; checkedAt: number; value: T } | undefined;

  constructor(
    private readonly opts: {
      gen: () => Promise<string>;
      load: (gen: string) => Promise<T>;
      localTtlMs?: number;
    },
  ) {}

  async get(): Promise<T> {
    const now = Date.now();
    const local = this.local;
    if (local !== undefined && now - local.checkedAt < (this.opts.localTtlMs ?? 5_000))
      return local.value;
    const gen = await this.opts.gen();
    if (local?.gen === gen && gen !== 'nocache') {
      local.checkedAt = now;
      return local.value;
    }
    const value = await this.opts.load(gen);
    this.local = { gen, checkedAt: now, value };
    return value;
  }

  /** Drops the local copy (after this replica's own write). */
  reset(): void {
    this.local = undefined;
  }
}
