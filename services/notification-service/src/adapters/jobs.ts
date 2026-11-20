import type { Cradle } from '@fastify/awilix';
import { type Job, Worker } from 'bullmq';

import { CHANNEL_QUEUES, type DeliveryChannel, JOBS_QUEUE, queueConnection } from './queues.js';

/**
 * BullMQ workers (every replica; each job is processed once across replicas).
 *
 * `notification-jobs` (housekeeping + fan-out):
 *   fanout             on demand    resolve a PROCESSING audience page by page (backoff)
 *   fanout-sweep       every 60 s   re-enqueue fan-outs whose job was lost or gave up
 *   delivery-sweep     every 30 s   re-enqueue overdue deliveries; recover crashed SENDING claims
 *   release-scheduled  every 30 s   due SCHEDULED notifications → fan-out
 *   expire             every 5 min  SCHEDULED / PROCESSING past expiresAt (or stuck a day) → EXPIRED
 *   retention          every 24 h   delete history older than NOTIFICATION_RETENTION_DAYS
 *
 * `notification-push | -email | -sms`: one delivery attempt per job, per-channel concurrency and a
 * global rate limit (BullMQ limiter, shared by all replicas through Redis).
 */
export class JobsRuntime {
  private readonly workers: Worker[] = [];

  constructor(private readonly cradle: Cradle) {}

  async start(): Promise<void> {
    const { config, logger, queues, metrics, deliveriesRepository } = this.cradle;
    const connection = queueConnection(config.REDIS_QUEUE_URL);
    const jobs = queues.jobsQueue;
    const every = (name: string, ms: number) =>
      jobs.upsertJobScheduler(name, { every: ms }, { name });
    await every('fanout-sweep', 60_000);
    await every('delivery-sweep', 30_000);
    await every('release-scheduled', 30_000);
    await every('expire', 5 * 60_000);
    await every('retention', 24 * 60 * 60_000);

    const watched = [JOBS_QUEUE, ...Object.values(CHANNEL_QUEUES)];
    metrics.onScrape(async () => {
      for (const name of watched) {
        const counts = await queues
          .queue(name)
          .getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const [state, n] of Object.entries(counts))
          metrics.queueJobs.set({ queue: name, state }, n);
      }
    });
    metrics.onScrape(async () => {
      const failed = await deliveriesRepository.countFailedByChannel();
      for (const channel of Object.keys(CHANNEL_QUEUES))
        metrics.failedDeliveries.set({ channel }, failed[channel] ?? 0);
    });

    this.workers.push(
      new Worker(JOBS_QUEUE, (job) => this.housekeeping(job), {
        connection,
        concurrency: config.FANOUT_CONCURRENCY,
      }),
    );
    const channel = (name: DeliveryChannel, concurrency: number, perSecond: number) =>
      new Worker(
        CHANNEL_QUEUES[name],
        (job: Job<{ deliveryId: string }>) =>
          this.cradle.deliveryService.deliver(job.data.deliveryId),
        { connection, concurrency, limiter: { max: perSecond, duration: 1000 } },
      );
    this.workers.push(
      channel('PUSH', config.PUSH_CONCURRENCY, config.PUSH_RATE_PER_SEC),
      channel('EMAIL', config.EMAIL_CONCURRENCY, config.EMAIL_RATE_PER_SEC),
      channel('SMS', config.SMS_CONCURRENCY, config.SMS_RATE_PER_SEC),
    );
    for (const worker of this.workers)
      worker.on('failed', (job, err) => {
        logger.warn(
          { err, queue: worker.name, job: job?.name, attempts: job?.attemptsMade },
          'notification job failed',
        );
      });
  }

  private housekeeping(job: Job): Promise<unknown> {
    const { notificationsService, deliveryService, logger } = this.cradle;
    switch (job.name) {
      case 'fanout':
        return notificationsService.fanout((job.data as { notificationId: string }).notificationId);
      case 'fanout-sweep':
        return notificationsService.sweepFanouts();
      case 'delivery-sweep':
        return deliveryService.sweep();
      case 'release-scheduled':
        return notificationsService.releaseScheduled();
      case 'expire':
        return notificationsService.expire();
      case 'retention':
        return notificationsService.purgeOld();
      default:
        logger.warn({ job: job.name }, 'unknown notification job');
        return Promise.resolve(undefined);
    }
  }

  /** Graceful shutdown: each worker finishes its running jobs, then closes. */
  async stop(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}
