import type { Cradle } from '@fastify/awilix';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export const JOBS_QUEUE = 'support-jobs';

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
 * Repeating jobs (one tick across ALL replicas). Each is ONE set-based UPDATE … WHERE id IN
 * (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) over a partial index, so overlaps and crashes are
 * safe and a breach / close is recorded exactly once.
 *   sla-sweep    every 30 s   first-response + resolve breaches → support.sla_breached.v1
 *   auto-close   every 10 min RESOLVED without feedback for autoCloseHours → CLOSED
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
    await this.queue.upsertJobScheduler('sla-sweep', { every: 30_000 }, { name: 'sla-sweep' });
    await this.queue.upsertJobScheduler(
      'auto-close',
      { every: 10 * 60_000 },
      { name: 'auto-close' },
    );

    this.worker = new Worker(
      JOBS_QUEUE,
      async (job) => {
        switch (job.name) {
          case 'sla-sweep':
            return this.cradle.ticketsJobs.sweepSla();
          case 'auto-close':
            return this.cradle.ticketsJobs.autoClose();
          default:
            logger.warn({ job: job.name }, 'unknown support job');
            return undefined;
        }
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      logger.error({ err, job: job?.name }, 'support job failed');
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
