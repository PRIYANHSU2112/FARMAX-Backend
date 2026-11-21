import { type Tx, claimInboxEvent, createOutboxSource, writeOutboxEvent } from '@farmx/database';
import {
  type EventEnvelope,
  OutboxRelay,
  WALLET_EVENT_SOURCE,
  type WalletEventMap,
  type WalletEventType,
  createInbox,
} from '@farmx/infra/events';
import { RabbitConsumer, RabbitPublisher } from '@farmx/infra/rabbitmq';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from './uuid.js';

/** Consumer queue (= inbox consumer name) and the routing keys wallet-service listens to. */
export const WALLET_QUEUE = 'wallet-service.events';
export const WALLET_BINDINGS = [
  'payment.topup_captured.v1',
  'payment.topup_failed.v1',
  'payment.topup_expired.v1',
  'payment.refund_processed.v1',
  'order.delivered.v1',
];

export type EventHandlerMap = Partial<
  Record<string, (event: EventEnvelope, tx: Tx) => Promise<void>>
>;

/** Transactional outbox write of a wallet event (commits with the ledger change, or not at all). */
export const emitWalletEvent = async <T extends WalletEventType>(
  tx: Tx,
  type: T,
  data: WalletEventMap[T],
  correlationId: string,
  causationId?: string,
): Promise<void> => {
  const envelope: EventEnvelope = {
    id: uuidv7(),
    type,
    version: Number(type.slice(type.lastIndexOf('.v') + 2)),
    occurredAt: new Date().toISOString(),
    source: WALLET_EVENT_SOURCE,
    correlationId,
    ...(causationId === undefined ? {} : { causationId }),
    data,
  };
  await writeOutboxEvent(tx, envelope);
};

/**
 * Outbox relay (wallet events → RabbitMQ) + one durable consumer queue (payment top-up outcomes).
 * Each event runs inside the inbox transaction, so a redelivered event is a no-op. Started by
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
      consumer: WALLET_QUEUE,
      runInTransaction,
      claim: claimInboxEvent,
      handlers: { ...this.cradle.topupEventHandlers, ...this.cradle.rewardEventHandlers },
    });
    this.consumer = new RabbitConsumer({
      url: config.RABBITMQ_URL,
      queue: WALLET_QUEUE,
      bindings: WALLET_BINDINGS,
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
