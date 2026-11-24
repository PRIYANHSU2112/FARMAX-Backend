import { type Tx, claimInboxEvent, createOutboxSource, writeOutboxEvent } from '@farmx/database';
import {
  type EventEnvelope,
  INVENTORY_EVENT_SOURCE,
  type InventoryEventMap,
  type InventoryEventType,
  OutboxRelay,
  createInbox,
} from '@farmx/infra/events';
import { RabbitConsumer, RabbitPublisher } from '@farmx/infra/rabbitmq';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from './uuid.js';

/** Consumer queue (= inbox consumer name) and the routing keys inventory-service listens to. */
export const INVENTORY_QUEUE = 'inventory-service.events';
export const INVENTORY_BINDINGS = [
  'product.variant_created.v1',
  'product.variant_updated.v1',
  'product.variant_deactivated.v1',
  'order.paid.v1',
  'order.rejected.v1',
  'order.cancelled.v1',
  'order.failed.v1',
  'warehouse.upserted.v1',
  'warehouse.coverage_replaced.v1',
  // D-57a: WMS stock deltas + thresholds copy.
  'warehouse.stock_changed.v1',
  'warehouse.thresholds_changed.v1',
  // D-57b: issue at dispatch.
  'shipment.dispatched.v1',
  'warehouse.routing_rules_replaced.v1',
];

export type EventHandlerMap = Partial<
  Record<string, (event: EventEnvelope, tx: Tx) => Promise<void>>
>;

/** Transactional outbox write of an inventory event (commits with the stock change). */
export const emitInventoryEvent = async <T extends InventoryEventType>(
  tx: Tx,
  type: T,
  data: InventoryEventMap[T],
  correlationId: string,
  causationId?: string,
): Promise<void> => {
  const envelope: EventEnvelope = {
    id: uuidv7(),
    type,
    version: Number(type.slice(type.lastIndexOf('.v') + 2)),
    occurredAt: new Date().toISOString(),
    source: INVENTORY_EVENT_SOURCE,
    correlationId,
    ...(causationId === undefined ? {} : { causationId }),
    data,
  };
  await writeOutboxEvent(tx, envelope);
};

/**
 * Outbox relay (inventory events → RabbitMQ) + one durable consumer queue (product events →
 * variant projection; order events → reservation commit / release). Each event runs inside the
 * inbox transaction, so a redelivered event is a no-op. Started by server.ts only.
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
      consumer: INVENTORY_QUEUE,
      runInTransaction,
      claim: claimInboxEvent,
      handlers: {
        ...this.cradle.projectionEventHandlers,
        ...this.cradle.reservationEventHandlers,
        ...this.cradle.warehouseEventHandlers,
        ...this.cradle.wmsStockEventHandlers,
      },
    });
    this.consumer = new RabbitConsumer({
      url: config.RABBITMQ_URL,
      queue: INVENTORY_QUEUE,
      bindings: INVENTORY_BINDINGS,
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
