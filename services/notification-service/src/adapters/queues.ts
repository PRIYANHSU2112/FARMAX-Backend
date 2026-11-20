import type { Logger } from '@farmx/common/logger';
import { type ConnectionOptions, Queue } from 'bullmq';

import type { NotificationConfig } from '../config/index.js';
import type { NotificationPriority } from '../domain.js';

export const JOBS_QUEUE = 'notification-jobs';

export type DeliveryChannel = 'PUSH' | 'EMAIL' | 'SMS';
/** One queue per channel: a slow SMTP server never delays pushes. */
export const CHANNEL_QUEUES: Readonly<Record<DeliveryChannel, string>> = {
  PUSH: 'notification-push',
  EMAIL: 'notification-email',
  SMS: 'notification-sms',
};

/** BullMQ priority: lower runs first. */
const PRIORITY: Readonly<Record<NotificationPriority, number>> = {
  CRITICAL: 1,
  HIGH: 2,
  NORMAL: 3,
  LOW: 4,
};

export interface DeliveryJob {
  id: string;
  channel: DeliveryChannel;
  priority: NotificationPriority;
  /** Attempts already made (part of the job id: one job per attempt). */
  attempts: number;
  delayMs?: number;
}

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
 * Producer side of the BullMQ queues (every replica; workers run only when JOBS_ENABLED). Queues
 * open lazily. Enqueue failures never fail the business transaction: the DB row is the source of
 * truth and the sweep job re-enqueues anything overdue.
 */
export class Queues {
  private readonly open = new Map<string, Queue>();

  constructor(private readonly deps: { config: NotificationConfig; logger: Logger }) {}

  queue(name: string): Queue {
    let q = this.open.get(name);
    if (q === undefined) {
      q = new Queue(name, {
        connection: queueConnection(this.deps.config.REDIS_QUEUE_URL),
        defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
      });
      this.open.set(name, q);
    }
    return q;
  }

  get jobsQueue(): Queue {
    return this.queue(JOBS_QUEUE);
  }

  /**
   * One fan-out job per notification (jobId dedupes while queued / running). Retried with
   * exponential backoff (5 s … ~10 min); removed when it fails for good so the sweep can re-add it.
   */
  async enqueueFanout(notificationId: string): Promise<void> {
    await this.jobsQueue.add(
      'fanout',
      { notificationId },
      {
        jobId: `fanout-${notificationId}`,
        attempts: 8,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /**
   * One job per delivery ATTEMPT (jobId = delivery + attempt: re-adding the same attempt is a
   * no-op, so the sweep and the creator can both enqueue safely). Retries are new delayed jobs
   * scheduled by the delivery service; BullMQ itself never retries (attempts: 1).
   */
  async enqueueDeliveries(jobs: readonly DeliveryJob[]): Promise<void> {
    const byChannel = new Map<DeliveryChannel, DeliveryJob[]>();
    for (const job of jobs)
      byChannel.set(job.channel, [...(byChannel.get(job.channel) ?? []), job]);
    await Promise.all(
      [...byChannel].map(([channel, list]) =>
        this.queue(CHANNEL_QUEUES[channel]).addBulk(
          list.map((job) => ({
            name: 'deliver',
            data: { deliveryId: job.id },
            opts: {
              jobId: `delivery-${job.id}-${String(job.attempts)}`,
              priority: PRIORITY[job.priority],
              ...(job.delayMs === undefined ? {} : { delay: job.delayMs }),
              attempts: 1,
              removeOnComplete: true,
              removeOnFail: 1000,
            },
          })),
        ),
      ),
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.open.values()].map((q) => q.close()));
  }
}
