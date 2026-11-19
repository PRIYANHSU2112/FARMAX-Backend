import { randomBytes } from 'node:crypto';

import type { Tx } from '@farmx/database';
import { FARM_EVENT_SOURCE, type FarmEventMap, type FarmEventType } from '@farmx/infra/events';

/** RFC 9562 UUID v7 (time-ordered): the event id, outbox row id and consumer de-dup key. */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(nowMs, 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Transactional outbox writer: the event row commits with the business change (D-20). The relay
 * that publishes rows to RabbitMQ is Phase 2 infrastructure.
 */
export class OutboxWriter {
  async add<T extends FarmEventType>(
    tx: Tx,
    type: T,
    data: FarmEventMap[T],
    correlationId: string,
  ): Promise<void> {
    const id = uuidv7();
    const envelope = {
      id,
      type,
      version: Number(type.slice(type.lastIndexOf('.v') + 2)),
      occurredAt: new Date().toISOString(),
      source: FARM_EVENT_SOURCE,
      correlationId,
      data,
    };
    // tsc needs the cast (payload interfaces lack an index signature); type-aware ESLint calls it
    // unnecessary — same mismatch as in @farmx/common/server create-service.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    await tx.outboxEvent.create({ data: { id, type, payload: envelope as object } });
  }
}
