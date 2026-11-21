import type { Cradle } from '@fastify/awilix';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export const JOBS_QUEUE = 'wallet-jobs';

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
 * Repeating background jobs (one job per tick across ALL replicas). Every job is idempotent and
 * works under row locks, so overlaps and crashes are safe. Redis only schedules; money state is
 * always read from Postgres / payment-service.
 *   topup-reconcile   every 60 s   open top-ups older than 2 min → resume payment → live status
 *   cashback-sweep    every 10 min completed top-ups whose cashback points are not granted yet
 *   points-mature     every 15 min PENDING lots past their hold → AVAILABLE
 *   points-expire     every 60 min AVAILABLE lots past expiry → EXPIRE
 *   points-notice     every 24 h   lots expiring within the notice window → points.expiring_soon.v1
 *   ledger-check      every 15 min ledgers vs. postings / lots / top-ups → wallet_ledger_checks
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
    await every('topup-reconcile', 60_000);
    await every('cashback-sweep', 10 * 60_000);
    await every('points-mature', 15 * 60_000);
    await every('points-expire', 60 * 60_000);
    await every('points-notice', 24 * 60 * 60_000);
    await every('ledger-check', 15 * 60_000);

    this.worker = new Worker(
      JOBS_QUEUE,
      async (job) => {
        switch (job.name) {
          case 'topup-reconcile':
            return this.cradle.topupsService.reconcile();
          case 'cashback-sweep':
            return this.cradle.topupsService.grantPendingCashback();
          case 'points-mature':
            return this.cradle.rewardsService.matureDue();
          case 'points-expire':
            return this.cradle.rewardsService.expireDue();
          case 'points-notice':
            return this.cradle.rewardsService.noticeDue();
          case 'ledger-check':
            return this.cradle.checksService.run();
          default:
            logger.warn({ job: job.name }, 'unknown wallet job');
            return undefined;
        }
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      logger.error({ err, job: job?.name }, 'wallet job failed');
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
