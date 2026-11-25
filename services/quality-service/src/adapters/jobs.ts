import type { Cradle } from '@fastify/awilix';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export const JOBS_QUEUE = 'quality-jobs';

/** BullMQ connection options from a redis:// URL (workers need maxRetriesPerRequest null). */
export const queueConnection = (url: string): ConnectionOptions => {
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
 * Repeating jobs (one tick across ALL replicas):
 *   coa-expiry      every hour   approved COAs past valid-until → EXPIRED (+ batch read copy)
 *   decision-sweep  every 5 min  decisions APPLYING too long → warning log (screens show "stuck")
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
      'coa-expiry',
      { every: 60 * 60_000 },
      { name: 'coa-expiry' },
    );
    await this.queue.upsertJobScheduler(
      'decision-sweep',
      { every: 5 * 60_000 },
      { name: 'decision-sweep' },
    );
    this.worker = new Worker(
      JOBS_QUEUE,
      async (job) => {
        switch (job.name) {
          case 'coa-expiry':
            return this.cradle.coasService.expireDue();
          case 'decision-sweep':
            return this.cradle.releaseService.sweepStuck();
          default:
            logger.warn({ job: job.name }, 'unknown quality job');
            return undefined;
        }
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      logger.error({ err, job: job?.name }, 'quality job failed');
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
