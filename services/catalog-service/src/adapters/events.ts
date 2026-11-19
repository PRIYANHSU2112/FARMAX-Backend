import { type Tx, createOutboxSource, writeOutboxEvent } from '@farmx/database';
import {
  CATALOG_EVENT_SOURCE,
  type CatalogEventMap,
  type CatalogEventType,
  type EventEnvelope,
  OutboxRelay,
} from '@farmx/infra/events';
import { RabbitPublisher } from '@farmx/infra/rabbitmq';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from './uuid.js';

/** Transactional outbox write of a catalog-service event (commits with the business change). */
export const emitCatalogEvent = async <T extends CatalogEventType>(
  tx: Tx,
  type: T,
  data: CatalogEventMap[T],
  correlationId: string,
): Promise<void> => {
  const envelope: EventEnvelope = {
    id: uuidv7(),
    type,
    version: Number(type.slice(type.lastIndexOf('.v') + 2)),
    occurredAt: new Date().toISOString(),
    source: CATALOG_EVENT_SOURCE,
    correlationId,
    data,
  };
  await writeOutboxEvent(tx, envelope);
};

/** Outbox relay (catalog events → RabbitMQ). Started by server.ts only. */
export class EventsRuntime {
  private relay: OutboxRelay | undefined;
  private publisher: RabbitPublisher | undefined;

  constructor(private readonly cradle: Cradle) {}

  start(): void {
    const { config, logger, db } = this.cradle;
    this.publisher = new RabbitPublisher(config.RABBITMQ_URL, logger);
    this.relay = new OutboxRelay({
      source: createOutboxSource(db),
      publisher: this.publisher,
      logger,
    });
    this.relay.start();
  }

  async stop(): Promise<void> {
    await this.relay?.stop();
    await this.publisher?.close();
  }
}
