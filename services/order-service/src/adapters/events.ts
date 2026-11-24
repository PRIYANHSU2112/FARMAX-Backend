import { type Tx, claimInboxEvent, createOutboxSource, writeOutboxEvent } from '@farmx/database';
import {
  type EventEnvelope,
  ORDER_EVENT_SOURCE,
  type OrderEventMap,
  type OrderEventType,
  OutboxRelay,
  createInbox,
} from '@farmx/infra/events';
import { RabbitConsumer, RabbitPublisher } from '@farmx/infra/rabbitmq';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from './uuid.js';

/** Consumer queue (= inbox consumer name) and the routing keys order-service listens to. */
export const ORDER_QUEUE = 'order-service.events';
export const ORDER_BINDINGS = [
  // projections (cart / pricing read models)
  'product.variant_created.v1',
  'product.variant_updated.v1',
  'product.variant_deactivated.v1',
  'pricing.price_changed.v1',
  'farm.facts_changed.v1',
  'inventory.availability_changed.v1',
  // order lifecycle (docs/oms)
  'payment.captured.v1',
  'payment.failed.v1',
  'payment.expired.v1',
  'payment.refund_initiated.v1',
  'payment.refund_processed.v1',
  'payment.refund_failed.v1',
  'inventory.reservation_committed.v1',
  'inventory.reservation_rejected.v1',
  'inventory.reservation_released.v1',
  // F1 (D-57b): order status follows its shipments.
  'shipment.status_changed.v1',
];

export type EventHandlerMap = Partial<
  Record<string, (event: EventEnvelope, tx: Tx) => Promise<void>>
>;

/** Transactional outbox write of an order event (commits with the order change). */
export const emitOrderEvent = async <T extends OrderEventType>(
  tx: Tx,
  type: T,
  data: OrderEventMap[T],
  correlationId: string,
  causationId?: string,
): Promise<void> => {
  const envelope: EventEnvelope = {
    id: uuidv7(),
    type,
    version: Number(type.slice(type.lastIndexOf('.v') + 2)),
    occurredAt: new Date().toISOString(),
    source: ORDER_EVENT_SOURCE,
    correlationId,
    ...(causationId === undefined ? {} : { causationId }),
    data,
  };
  await writeOutboxEvent(tx, envelope);
};

/**
 * Outbox relay (order events → RabbitMQ) + one durable consumer queue (projections + the order
 * lifecycle). Each event runs inside the inbox transaction, so a redelivery is a no-op [R4].
 * Started by server.ts only; tests never open AMQP.
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
      consumer: ORDER_QUEUE,
      runInTransaction,
      claim: claimInboxEvent,
      handlers: { ...this.cradle.projectionEventHandlers, ...this.cradle.orderEventHandlers },
    });
    this.consumer = new RabbitConsumer({
      url: config.RABBITMQ_URL,
      queue: ORDER_QUEUE,
      bindings: ORDER_BINDINGS,
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
