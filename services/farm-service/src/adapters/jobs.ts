import type { Cradle } from '@fastify/awilix';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export const JOBS_QUEUE = 'farm-jobs';

/** BullMQ connection options from a redis:// URL (BullMQ workers need maxRetriesPerRequest null). */
const queueConnection = (url: string): ConnectionOptions => {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username === '' ? {} : { username: decodeURIComponent(u.username) }),
    ...(u.password === '' ? {} : { password: decodeURIComponent(u.password) }),
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
};

/**
 * Repeating background jobs (one per tick across ALL replicas; each is idempotent):
 *   content-tick      every 60 s   flush engagement counters, publish due SCHEDULED, expire due alerts
 *   content-trending  every 10 min recompute trendingScore of live items
 */
export class JobsRuntime {
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(private readonly cradle: Cradle) {}

  async start(): Promise<void> {
    const { config, logger } = this.cradle;
    const connection = queueConnection(config.REDIS_QUEUE_URL);
    this.queue = new Queue(JOBS_QUEUE, {
      connection,
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
    });
    await this.queue.upsertJobScheduler(
      'content-tick',
      { every: 60_000 },
      { name: 'content-tick' },
    );
    await this.queue.upsertJobScheduler(
      'content-trending',
      { every: 10 * 60_000 },
      { name: 'content-trending' },
    );

    this.worker = new Worker(
      JOBS_QUEUE,
      async (job) => {
        switch (job.name) {
          case 'content-tick':
            return this.cradle.contentJobs.tick();
          case 'content-trending':
            return this.cradle.contentJobs.trending();
          default:
            logger.warn({ job: job.name }, 'unknown farm job');
            return undefined;
        }
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      logger.error({ err, job: job?.name }, 'farm job failed');
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
