import { randomBytes } from 'node:crypto';

import { type Tx, createOutboxSource, writeOutboxEvent } from '@farmx/database';
import { AUTH_EVENT_SOURCE, type EventEnvelope, OutboxRelay } from '@farmx/infra/events';
import { RabbitPublisher } from '@farmx/infra/rabbitmq';
import type { Cradle } from '@fastify/awilix';

/** RFC 9562 UUID v7 (time-ordered) for event ids. */
const uuidv7 = (nowMs: number = Date.now()): string => {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(nowMs, 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export interface AuthEventData {
  'user.status_changed.v1': {
    userId: string;
    previousStatus: string;
    status: string;
    changedByUserId: string | null;
  };
  'user.deleted.v1': { userId: string; deletedByUserId: string | null };
}

/** Transactional outbox write (commits with the user change, or not at all). */
export const emitAuthEvent = async <T extends keyof AuthEventData>(
  tx: Tx,
  type: T,
  data: AuthEventData[T],
  correlationId: string,
): Promise<void> => {
  const envelope: EventEnvelope = {
    id: uuidv7(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    source: AUTH_EVENT_SOURCE,
    correlationId,
    data,
  };
  await writeOutboxEvent(tx, envelope);
};

/** Outbox relay only (auth publishes; it consumes nothing). Started by server.ts. */
export class AuthEventsRuntime {
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
