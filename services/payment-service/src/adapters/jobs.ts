import type { Cradle } from '@fastify/awilix';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export const JOBS_QUEUE = 'payment-jobs';

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
 * Repeating background jobs (one job per tick across ALL replicas). Every job claims rows with
 * FOR UPDATE SKIP LOCKED and is idempotent, so overlaps and crashes are safe.
 *   webhook-process     every 2 s    stored, signed gateway webhooks → payments / refunds
 *   refund-execute      every 10 s   APPROVED / RETRYING refunds due → gateway (backoff)
 *   refund-status       every 15 min PROCESSING > 1 h → gateway refetch; stale claims recovered
 *   reconcile-pending   every 60 s   open payments older than reconcileAfterSeconds → refetch
 *   expire-intents      every 60 s   open payments past expiresAt → live check → EXPIRED
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
    await every('webhook-process', 2_000);
    await every('refund-execute', 10_000);
    await every('refund-status', 15 * 60_000);
    await every('reconcile-pending', 60_000);
    await every('expire-intents', 60_000);

    this.worker = new Worker(
      JOBS_QUEUE,
      async (job) => {
        switch (job.name) {
          case 'webhook-process':
            return this.cradle.webhooksService.processPending();
          case 'refund-execute':
            return this.cradle.refundsService.executeDue();
          case 'refund-status':
            return this.cradle.refundsService.syncStale();
          case 'reconcile-pending':
            return this.cradle.paymentsService.reconcilePending();
          case 'expire-intents':
            return this.cradle.paymentsService.expireDue();
          default:
            logger.warn({ job: job.name }, 'unknown payment job');
            return undefined;
        }
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      logger.error({ err, job: job?.name }, 'payment job failed');
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
