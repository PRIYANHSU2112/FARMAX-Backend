import type { Cradle } from '@fastify/awilix';

type Deps = Pick<
  Cradle,
  'contentRepository' | 'contentAdminService' | 'contentCounters' | 'contentService' | 'logger'
>;

const BATCH = 100;

/**
 * BullMQ handlers (adapters/jobs.ts). Each step is idempotent: transitions are guarded by
 * (version, status), so a retried or overlapping run changes each item at most once.
 */
export class ContentJobs {
  constructor(private readonly deps: Deps) {}

  /** Every 60 s: flush counters, publish due SCHEDULED items, expire due alerts. */
  async tick(): Promise<{ counters: number; published: number; expired: number }> {
    const { contentRepository, contentAdminService, contentCounters, contentService, logger } =
      this.deps;
    const counters = await contentCounters.flush();
    const now = new Date();
    let published = 0;
    for (const item of await contentRepository.dueScheduled(now, BATCH))
      if (await contentAdminService.goLive(item)) published += 1;
    let expired = 0;
    for (const item of await contentRepository.dueExpiry(now, BATCH))
      if (await contentAdminService.expireDue(item)) expired += 1;
    if (published + expired > 0) {
      await contentService.invalidate();
      logger.info({ published, expired }, 'content lifecycle tick');
    }
    return { counters, published, expired };
  }

  /** Every 10 min: trending order of live items. */
  async trending(): Promise<number> {
    const updated = await this.deps.contentRepository.recomputeTrending();
    await this.deps.contentService.invalidate();
    return updated;
  }
}
