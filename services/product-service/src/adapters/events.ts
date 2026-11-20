import { type Tx, claimInboxEvent, createOutboxSource, writeOutboxEvent } from '@farmx/database';
import {
  type EventEnvelope,
  OutboxRelay,
  PRODUCT_EVENT_SOURCE,
  type ProductEventMap,
  type ProductEventType,
  createInbox,
} from '@farmx/infra/events';
import { RabbitConsumer, RabbitPublisher } from '@farmx/infra/rabbitmq';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from './uuid.js';

/** Consumer queue (= inbox consumer name) and the routing keys product-service listens to. */
export const PRODUCT_QUEUE = 'product-service.events';
export const PRODUCT_BINDINGS = [
  'catalog.brand_updated.v1',
  'inventory.availability_changed.v1',
  'pricing.price_changed.v1',
  'order.delivered.v1',
];

export type EventHandlerMap = Partial<
  Record<string, (event: EventEnvelope, tx: Tx) => Promise<void>>
>;

/** Transactional outbox write of a product-service event (commits with the business change). */
export const emitProductEvent = async <T extends ProductEventType>(
  tx: Tx,
  type: T,
  data: ProductEventMap[T],
  correlationId: string,
): Promise<void> => {
  const envelope: EventEnvelope = {
    id: uuidv7(),
    type,
    version: Number(type.slice(type.lastIndexOf('.v') + 2)),
    occurredAt: new Date().toISOString(),
    source: PRODUCT_EVENT_SOURCE,
    correlationId,
    data,
  };
  await writeOutboxEvent(tx, envelope);
};

/**
 * Outbox relay (product events → RabbitMQ) + one durable consumer queue (catalog, inventory,
 * pricing events → projections; order.delivered → review eligibility). Started by server.ts only; tests never open AMQP.
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
      consumer: PRODUCT_QUEUE,
      runInTransaction,
      claim: claimInboxEvent,
      handlers: { ...this.cradle.productEventHandlers, ...this.cradle.reviewEventHandlers },
    });
    this.consumer = new RabbitConsumer({
      url: config.RABBITMQ_URL,
      queue: PRODUCT_QUEUE,
      bindings: PRODUCT_BINDINGS,
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
