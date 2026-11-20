import type { Cradle } from '@fastify/awilix';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export const JOBS_QUEUE = 'order-jobs';
export const PDF_QUEUE = 'order-invoice-pdf';

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
 *   ledger-reconcile  every 15 min order ledger vs payment-service totals (settled rows) → mismatches
 *   invoice-pdf       every 10 s   (own queue) render PENDING / due FAILED / stale invoice PDFs
 */
export class JobsRuntime {
  private queue: Queue | undefined;
  private worker: Worker | undefined;
  private pdfQueue: Queue | undefined;
  private pdfWorker: Worker | undefined;

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
    await every('ledger-reconcile', 15 * 60_000);

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
          case 'ledger-reconcile':
            return this.cradle.transactionsService.reconcile();
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

    // Invoice PDFs: CPU-heavy, so on their own queue (never delays the order jobs above).
    this.pdfQueue = new Queue(PDF_QUEUE, {
      connection,
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
    });
    await this.pdfQueue.upsertJobScheduler(
      'invoice-pdf',
      { every: 10_000 },
      { name: 'invoice-pdf' },
    );
    this.pdfWorker = new Worker(PDF_QUEUE, () => this.cradle.invoicesService.renderDue(), {
      connection,
      concurrency: 1,
    });
    this.pdfWorker.on('failed', (job, err) => {
      logger.error({ err, job: job?.name }, 'invoice PDF job failed');
    });
  }

  async stop(): Promise<void> {
    await this.pdfWorker?.close();
    await this.pdfQueue?.close();
    await this.worker?.close();
    await this.queue?.close();
  }
}
