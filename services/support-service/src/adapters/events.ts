import { type Tx, claimInboxEvent, createOutboxSource, writeOutboxEvent } from '@farmx/database';
import {
  type EventEnvelope,
  OutboxRelay,
  SUPPORT_EVENT_SOURCE,
  type SupportEventMap,
  type SupportEventType,
  createInbox,
} from '@farmx/infra/events';
import { RabbitConsumer, RabbitPublisher } from '@farmx/infra/rabbitmq';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from './uuid.js';

/** Consumer queue (= inbox consumer name) and the routing keys support-service listens to. */
export const SUPPORT_QUEUE = 'support-service.events';
export const SUPPORT_BINDINGS = ['user.deleted.v1', 'user.status_changed.v1'];

export type EventHandlerMap = Partial<
  Record<string, (event: EventEnvelope, tx: Tx) => Promise<void>>
>;

/** Transactional outbox write (commits with the ticket change, or not at all). */
export const emitSupportEvent = async <T extends SupportEventType>(
  tx: Tx,
  type: T,
  data: SupportEventMap[T],
  correlationId: string,
): Promise<void> => {
  const envelope: EventEnvelope = {
    id: uuidv7(),
    type,
    version: Number(type.slice(type.lastIndexOf('.v') + 2)),
    occurredAt: new Date().toISOString(),
    source: SUPPORT_EVENT_SOURCE,
    correlationId,
    data,
  };
  await writeOutboxEvent(tx, envelope);
};

/**
 * Outbox relay (support events → RabbitMQ) + one durable consumer queue (auth user lifecycle).
 * Each consumed event runs inside the inbox transaction, so a redelivery is a no-op. Started by
 * server.ts only (never in tests).
 */
export class EventsRuntime {
  private relay: OutboxRelay | undefined;
  private publisher: RabbitPublisher | undefined;
  private consumer: RabbitConsumer | undefined;

  constructor(private readonly cradle: Cradle) {}

  start(): void {
    const { config, logger, db, runInTransaction } = this.cradle;
    this.publisher = new RabbitPublisher(config.RABBITMQ_URL, logger);
    this.relay = new OutboxRelay({
      source: createOutboxSource(db),
      publisher: this.publisher,
      logger,
    });
    this.relay.start();
    const handle = createInbox<Tx>({
      consumer: SUPPORT_QUEUE,
      runInTransaction,
      claim: claimInboxEvent,
      handlers: { ...this.cradle.ticketEventHandlers },
    });
    this.consumer = new RabbitConsumer({
      url: config.RABBITMQ_URL,
      queue: SUPPORT_QUEUE,
      bindings: SUPPORT_BINDINGS,
      handle,
      logger,
    });
    void this.consumer.start();
  }

  async stop(): Promise<void> {
    await this.relay?.stop();
    await this.consumer?.close();
    await this.publisher?.close();
  }
}
