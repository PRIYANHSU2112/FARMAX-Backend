import { type Tx, claimInboxEvent, createOutboxSource, writeOutboxEvent } from '@farmx/database';
import {
  type EventEnvelope,
  OutboxRelay,
  QUALITY_EVENT_SOURCE,
  type QualityEventMap,
  type QualityEventType,
  createInbox,
} from '@farmx/infra/events';
import { RabbitConsumer, RabbitPublisher } from '@farmx/infra/rabbitmq';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from './uuid.js';

/** Consumer queue (= inbox consumer name) and the routing keys quality-service listens to. */
export const QUALITY_QUEUE = 'quality-service.events';
export const QUALITY_BINDINGS = [
  // Projections: batches + CN lines (auto samples), buyers per batch (ownership, recall list).
  'warehouse.receipt_created.v1',
  'warehouse.shipment_batches.v1',
  // Decision progress: one task per warehouse.
  'warehouse.quality_tasks_planned.v1',
  'warehouse.quality_task_updated.v1',
];

export type EventHandler = (event: EventEnvelope, tx: Tx) => Promise<void>;
export type EventHandlerMap = Partial<Record<string, EventHandler>>;

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

/** Transactional outbox write of a quality event (commits with the change it describes). */
export const emitQualityEvent = async <T extends QualityEventType>(
  tx: Tx,
  type: T,
  data: QualityEventMap[T],
  correlationId: string,
): Promise<void> => {
  const envelope: EventEnvelope = {
    id: uuidv7(),
    type,
    version: Number(type.slice(type.lastIndexOf('.v') + 2)),
    occurredAt: new Date().toISOString(),
    source: QUALITY_EVENT_SOURCE,
    correlationId,
    data,
  };
  await writeOutboxEvent(tx, envelope);
};

/**
 * Outbox relay (quality events → RabbitMQ) + one durable consumer queue (warehouse events).
 * Each event runs inside the inbox transaction, so a redelivered event is a no-op.
 * Started by server.ts only (never in tests).
 */
export class EventsRuntime {
  private relay: OutboxRelay | undefined;
  private publisher: RabbitPublisher | undefined;
  private consumer: RabbitConsumer | undefined;

  constructor(private readonly cradle: Cradle) {}

  /** The inbox handler (tests call it directly with a fake envelope). */
  handler() {
    return createInbox<Tx>({
      consumer: QUALITY_QUEUE,
      runInTransaction: this.cradle.runInTransaction,
      claim: claimInboxEvent,
      handlers: combineHandlers(
        this.cradle.projectionEventHandlers,
        this.cradle.releaseEventHandlers,
      ),
    });
  }

  start(): void {
    const { config, logger, db } = this.cradle;
    this.publisher = new RabbitPublisher(config.RABBITMQ_URL, logger);
    this.relay = new OutboxRelay({
      source: createOutboxSource(db),
      publisher: this.publisher,
      logger,
    });
    this.relay.start();
    this.consumer = new RabbitConsumer({
      url: config.RABBITMQ_URL,
      queue: QUALITY_QUEUE,
      bindings: QUALITY_BINDINGS,
      handle: this.handler(),
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
