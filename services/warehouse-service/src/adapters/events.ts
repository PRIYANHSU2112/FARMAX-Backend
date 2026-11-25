import { type Tx, claimInboxEvent, createOutboxSource, writeOutboxEvent } from '@farmx/database';
import {
  type EventEnvelope,
  OutboxRelay,
  createInbox,
  WAREHOUSE_EVENT_SOURCE,
  type WarehouseEventMap,
  type WarehouseEventType,
} from '@farmx/infra/events';
import { RabbitConsumer, RabbitPublisher } from '@farmx/infra/rabbitmq';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from './uuid.js';

/** Consumer queue (= inbox consumer name) and the routing keys warehouse-service listens to. */
export const WAREHOUSE_QUEUE = 'warehouse-service.events';
export const WAREHOUSE_BINDINGS = [
  'order.placed.v1',
  // D-57b: payment status on the fulfilment order.
  'order.paid.v1',
  'order.confirmed.v1',
  'order.delivered.v1',
  'order.rejected.v1',
  'order.cancelled.v1',
  'order.failed.v1',
  // D-57b W3.15: delivery details changed before picking.
  'order.delivery_updated.v1',
  'inventory.reservation_committed.v1',
  'inventory.reservation_released.v1',
  // D-57b: inventory refused an over-issue at dispatch.
  'inventory.issue_rejected.v1',
  // D-57b W3.13: what the storefront shows (ATP storefront sync).
  'inventory.availability_changed.v1',
  // D-57a: variant facts for the stock projection.
  'product.variant_created.v1',
  'product.variant_updated.v1',
  'product.variant_deactivated.v1',
  // D-60 quality-service: SKU quality policy, batch read copy, decisions to execute.
  'quality.spec_changed.v1',
  'quality.batch_state_changed.v1',
  'quality.decision_requested.v1',
  'quality.decision_retry_requested.v1',
];

export type EventHandlerMap = Partial<
  Record<string, (event: EventEnvelope, tx: Tx) => Promise<void>>
>;

/** Several features consume the same event: their handlers run in turn, in the same tx. */
export const combineHandlers = (...maps: EventHandlerMap[]): EventHandlerMap => {
  const out: EventHandlerMap = {};
  for (const m of maps)
    for (const [type, h] of Object.entries(m)) {
      if (h === undefined) continue;
      const prev = out[type];
      out[type] =
        prev === undefined
          ? h
          : async (e, tx) => {
              await prev(e, tx);
              await h(e, tx);
            };
    }
  return out;
};

/** Transactional outbox write of a warehouse event (commits with the change it describes). */
export const emitWarehouseEvent = async <T extends WarehouseEventType>(
  tx: Tx,
  type: T,
  data: WarehouseEventMap[T],
  correlationId: string,
): Promise<void> => {
  const envelope: EventEnvelope = {
    id: uuidv7(),
    type,
    version: Number(type.slice(type.lastIndexOf('.v') + 2)),
    occurredAt: new Date().toISOString(),
    source: WAREHOUSE_EVENT_SOURCE,
    correlationId,
    data,
  };
  await writeOutboxEvent(tx, envelope);
};

/**
 * Outbox relay (warehouse events → RabbitMQ) + one durable consumer queue (order and reservation
 * events → order read model, D-56 P3). Each event runs inside the inbox transaction, so a
 * redelivered event is a no-op. Started by server.ts only (never in tests).
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
      consumer: WAREHOUSE_QUEUE,
      runInTransaction,
      claim: claimInboxEvent,
      handlers: combineHandlers(
        this.cradle.orderEventHandlers,
        this.cradle.stockEventHandlers,
        this.cradle.fulfilmentEventHandlers,
        this.cradle.atpEventHandlers,
      ),
    });
    this.consumer = new RabbitConsumer({
      url: config.RABBITMQ_URL,
      queue: WAREHOUSE_QUEUE,
      bindings: WAREHOUSE_BINDINGS,
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
