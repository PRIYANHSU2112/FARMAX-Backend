import { randomUUID } from 'node:crypto';

import { farmKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { CounterDelta } from './content.repository.js';

type Counter = 'views' | 'yes' | 'no' | 'saves' | 'shares';

const VIEW_DEDUPE_SEC = 86_400;

/**
 * Engagement counters buffered in Redis (HINCRBY on one hash) and flushed to Postgres by the
 * content-tick job in ONE batched UPDATE: a viral alert never turns into thousands of hot-row
 * writes. Best effort: Redis down → the count is lost, the request still succeeds.
 */
export class ContentCounters {
  constructor(private readonly deps: Pick<Cradle, 'redis' | 'logger' | 'contentRepository'>) {}

  /** One view per reader per item per 24 h. */
  async view(contentId: string, userId: string): Promise<void> {
    const { redis } = this.deps;
    const first = await redis.set(
      farmKeys.contentViewed(contentId, userId),
      '1',
      'EX',
      VIEW_DEDUPE_SEC,
      'NX',
    );
    if (first === 'OK') await this.add(contentId, 'views', 1);
  }

  async add(contentId: string, counter: Counter, by: number): Promise<void> {
    await this.deps.redis.hincrby(farmKeys.contentCounters(), `${contentId}:${counter}`, by);
  }

  /** Fire-and-forget wrapper for request paths. */
  bump(contentId: string, counter: Counter, by: number): void {
    void this.add(contentId, counter, by).catch((err: unknown) => {
      this.deps.logger.warn({ err }, 'content counter not recorded');
    });
  }

  /**
   * Atomically takes the buffer (RENAME), writes it in one UPDATE, then deletes it. On a DB
   * failure the deltas are added back, so nothing is double-counted or lost.
   */
  async flush(): Promise<number> {
    const { redis, contentRepository, logger } = this.deps;
    const live = farmKeys.contentCounters();
    const taken = `${live}:flushing:${randomUUID()}`;
    try {
      await redis.rename(live, taken);
    } catch {
      return 0; // nothing buffered (no such key)
    }
    const raw = await redis.hgetall(taken);
    const byId = new Map<string, CounterDelta>();
    for (const [field, value] of Object.entries(raw)) {
      const sep = field.lastIndexOf(':');
      const id = field.slice(0, sep);
      const counter = field.slice(sep + 1) as Counter;
      const delta = byId.get(id) ?? { id, views: 0, yes: 0, no: 0, saves: 0, shares: 0 };
      delta[counter] += Number(value);
      byId.set(id, delta);
    }
    try {
      await contentRepository.applyCounters([...byId.values()]);
    } catch (error) {
      logger.error({ err: error }, 'content counter flush failed; re-buffering');
      const pipe = redis.pipeline();
      for (const [field, value] of Object.entries(raw)) pipe.hincrby(live, field, Number(value));
      await pipe.exec();
      await redis.del(taken);
      throw error;
    }
    await redis.del(taken);
    return byId.size;
  }
}
