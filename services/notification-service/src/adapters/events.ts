import { claimInboxEvent } from '@farmx/database';
import type { EventEnvelope, InboxResult } from '@farmx/infra/events';
import { RabbitConsumer } from '@farmx/infra/rabbitmq';
import type { Cradle } from '@fastify/awilix';

import { EVENT_BINDINGS } from '../features/events/index.js';
import type { Accepted } from '../features/notifications/index.js';

/** Consumer queue (= inbox consumer name). Consume-only: this service publishes no events. */
export const NOTIFICATION_QUEUE = 'notification-service.events';

/**
 * Idempotent handling of one event: inbox claim + notifications commit together (a redelivery
 * is a no-op), then the post-commit side effects (fan-out / delivery enqueue, live push). The
 * transaction does DB work only, so a slow auth-service never holds a connection here.
 */
export const createEventHandler =
  (cradle: Cradle) =>
  async (event: EventEnvelope): Promise<InboxResult> => {
    const { eventsService, notificationsService, runInTransaction, metrics } = cradle;
    if (!eventsService.handles(event.type)) return 'ignored';
    let accepted: Accepted[] = [];
    try {
      const result = await runInTransaction(async (tx) => {
        if (!(await claimInboxEvent(tx, event.id, NOTIFICATION_QUEUE))) return 'duplicate';
        accepted = await eventsService.handle(event, tx);
        return 'processed';
      });
      metrics.eventsConsumed.inc({ type: event.type, result });
      for (const a of accepted) await notificationsService.afterCommit(a);
      return result;
    } catch (err) {
      metrics.eventsConsumed.inc({ type: event.type, result: 'error' });
      throw err;
    }
  };

/** One durable consumer queue (retries 5×, then `<queue>.dlq`). Started by server.ts only. */
export class EventsRuntime {
  private consumer: RabbitConsumer | undefined;

  constructor(private readonly cradle: Cradle) {}

  start(): void {
    const { config, logger } = this.cradle;
    this.consumer = new RabbitConsumer({
      url: config.RABBITMQ_URL,
      queue: NOTIFICATION_QUEUE,
      bindings: [...EVENT_BINDINGS],
      handle: createEventHandler(this.cradle),
      logger,
      prefetch: 20,
    });
    void this.consumer.start();
  }

  async stop(): Promise<void> {
    await this.consumer?.close();
  }
}
