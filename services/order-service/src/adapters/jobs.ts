import type { Cradle } from '@fastify/awilix';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export const JOBS_QUEUE = 'order-jobs';

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
 * Repeating background jobs (one per tick across ALL replicas; each is idempotent and locks the
 * orders it changes):
 *   payment-timeout   every 60 s   unpaid past paymentDueAt + grace (live gateway check) → FAILED
 *   stuck-orders      every 60 s   placement interrupted (stock outcome unknown / no payment) → resume
 *   review-sla        every 5 min  paid orders past the review SLA → alert once; auto-reject if set
 *   recovery-watch    every 5 min  release / refund decisions that did not land → re-send
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
    const every = (name: string, ms: number) =>
      this.queue?.upsertJobScheduler(name, { every: ms }, { name });
    await every('payment-timeout', 60_000);
    await every('stuck-orders', 60_000);
    await every('review-sla', 5 * 60_000);
    await every('recovery-watch', 5 * 60_000);

    this.worker = new Worker(
      JOBS_QUEUE,
      async (job) => {
        switch (job.name) {
          case 'payment-timeout':
            return this.cradle.ordersService.failUnpaidDue();
          case 'stuck-orders':
            return this.cradle.ordersService.resumeStuck();
          case 'review-sla':
            return this.cradle.ordersAdminService.reviewSla();
          case 'recovery-watch':
            return this.cradle.ordersAdminService.recoveryWatch();
          default:
            logger.warn({ job: job.name }, 'unknown order job');
            return undefined;
        }
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      logger.error({ err, job: job?.name }, 'order job failed');
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
