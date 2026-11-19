import { type Tx, claimInboxEvent, createOutboxSource, writeOutboxEvent } from '@farmx/database';
import {
  type EventEnvelope,
  PAYMENT_EVENT_SOURCE,
  type PaymentEventMap,
  type PaymentEventType,
  OutboxRelay,
  createInbox,
} from '@farmx/infra/events';
import { RabbitConsumer, RabbitPublisher } from '@farmx/infra/rabbitmq';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from './uuid.js';

/** Consumer queue (= inbox consumer name) and the routing keys inventory-service listens to. */
export const PAYMENT_QUEUE = 'payment-service.events';
export const PAYMENT_BINDINGS = [
  'order.refund_requested.v1',
  'order.rejected.v1',
  'order.cancelled.v1',
  'order.failed.v1',
];

export type EventHandlerMap = Partial<
  Record<string, (event: EventEnvelope, tx: Tx) => Promise<void>>
>;

/** Transactional outbox write of a payment event (commits with the payment change). */
export const emitPaymentEvent = async <T extends PaymentEventType>(
  tx: Tx,
  type: T,
  data: PaymentEventMap[T],
  correlationId: string,
  causationId?: string,
): Promise<void> => {
  const envelope: EventEnvelope = {
    id: uuidv7(),
    type,
    version: Number(type.slice(type.lastIndexOf('.v') + 2)),
    occurredAt: new Date().toISOString(),
    source: PAYMENT_EVENT_SOURCE,
    correlationId,
    ...(causationId === undefined ? {} : { causationId }),
    data,
  };
  await writeOutboxEvent(tx, envelope);
};

/**
 * Outbox relay (payment events → RabbitMQ) + one durable consumer queue (order events: refund
 * decisions → refunds; rejected / cancelled / failed → void the open payment). Each event runs
 * inside the inbox transaction, so a redelivered event is a no-op. Started by server.ts only.
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
      consumer: PAYMENT_QUEUE,
      runInTransaction,
      claim: claimInboxEvent,
      handlers: {
        ...this.cradle.paymentEventHandlers,
        ...this.cradle.refundEventHandlers,
      },
    });
    this.consumer = new RabbitConsumer({
      url: config.RABBITMQ_URL,
      queue: PAYMENT_QUEUE,
      bindings: PAYMENT_BINDINGS,
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
