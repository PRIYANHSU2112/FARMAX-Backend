import { type Tx, claimInboxEvent } from '@farmx/database';
import { type EventEnvelope, createInbox } from '@farmx/infra/events';
import { RabbitConsumer } from '@farmx/infra/rabbitmq';
import type { Cradle } from '@fastify/awilix';

/** Consumer queue (= inbox consumer name) and the routing keys farm-service listens to. */
export const FARM_QUEUE = 'farm-service.events';
export const FARM_BINDINGS = ['user.profile_updated.v1'];

/** Per event type: the inbox-transaction write, and best-effort work after it commits. */
export interface EventHandlers {
  inTx: Partial<Record<string, (event: EventEnvelope, tx: Tx) => Promise<void>>>;
  afterCommit: Partial<Record<string, (event: EventEnvelope) => Promise<void>>>;
}

/**
 * One durable consumer queue (auth account events). Each event runs inside the inbox
 * transaction, so a redelivery is a no-op; after-commit hooks (cache drops) run only when the
 * event was processed. The farm outbox RELAY is deliberately not started here: it is a separate
 * rollout (existing outbox rows would all publish at once). Started by server.ts only.
 */
export class EventsRuntime {
  private consumer: RabbitConsumer | undefined;

  constructor(private readonly cradle: Cradle) {}

  start(): void {
    const { config, logger, runInTransaction, farmEventHandlers } = this.cradle;
    const inbox = createInbox<Tx>({
      consumer: FARM_QUEUE,
      runInTransaction,
      claim: claimInboxEvent,
      handlers: farmEventHandlers.inTx,
    });
    this.consumer = new RabbitConsumer({
      url: config.RABBITMQ_URL,
      queue: FARM_QUEUE,
      bindings: FARM_BINDINGS,
      handle: async (event) => {
        const result = await inbox(event);
        if (result === 'processed') await farmEventHandlers.afterCommit[event.type]?.(event);
        return result;
      },
      logger,
    });
    void this.consumer.start();
  }

  async stop(): Promise<void> {
    await this.consumer?.close();
  }
}
