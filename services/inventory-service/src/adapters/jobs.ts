import type { Cradle } from '@fastify/awilix';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export const JOBS_QUEUE = 'inventory-jobs';

/** BullMQ connection options from a redis:// URL (BullMQ workers need maxRetriesPerRequest null). */
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
 * Repeating background jobs (job schedulers: one job per tick across ALL replicas). Each job is
 * idempotent and claims rows with FOR UPDATE SKIP LOCKED, so overlapping runs are safe.
 *   expire-reservations   every 10 s   ACTIVE past expiresAt → EXPIRED (stock freed)
 *   publish-availability  every 2 s    dirty variants → availability_changed / low_stock events
 *   orphan-sweep          02:30 IST    reservations held for terminal orders → released
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
    const schedule = (name: string, repeat: { every: number } | { pattern: string; tz: string }) =>
      this.queue?.upsertJobScheduler(name, repeat, { name });
    await schedule('expire-reservations', { every: 10_000 });
    await schedule('publish-availability', { every: 2_000 });
    await schedule('orphan-sweep', { pattern: '30 2 * * *', tz: 'Asia/Kolkata' });

    this.worker = new Worker(
      JOBS_QUEUE,
      async (job) => {
        switch (job.name) {
          case 'expire-reservations':
            return this.cradle.reservationsService.expireDue();
          case 'publish-availability':
            return this.cradle.availabilityPublisher.publishDirty();
          case 'orphan-sweep':
            return this.cradle.reservationsService.orphanSweep();
          default:
            logger.warn({ job: job.name }, 'unknown inventory job');
            return undefined;
        }
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      logger.error({ err, job: job?.name }, 'inventory job failed');
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
