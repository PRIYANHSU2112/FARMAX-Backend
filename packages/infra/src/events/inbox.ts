import { EVENT_TYPE_PATTERN, type EventEnvelope } from './envelope.js';

export type InboxResult = 'processed' | 'duplicate' | 'ignored';

export interface InboxOptions<TTx> {
  /** Consumer name = queue name, e.g. `product-service.catalog-events`. */
  consumer: string;
  runInTransaction: <T>(work: (tx: TTx) => Promise<T>) => Promise<T>;
  /** `@farmx/database` `claimInboxEvent`: false when (eventId, consumer) was already recorded. */
  claim: (tx: TTx, eventId: string, consumer: string) => Promise<boolean>;
  /** Handlers by routing key; each runs inside the inbox transaction. */
  handlers: Partial<Record<string, (event: EventEnvelope, tx: TTx) => Promise<void>>>;
}

/** Thrown for a message that can never be processed (bad envelope) → dead-letter, no retry. */
export class PoisonMessageError extends Error {}

export const parseEnvelope = (raw: Buffer | string): EventEnvelope => {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString());
  } catch {
    throw new PoisonMessageError('Event body is not JSON');
  }
  const e = value as Partial<EventEnvelope>;
  if (
    typeof e.id !== 'string' ||
    typeof e.type !== 'string' ||
    !EVENT_TYPE_PATTERN.test(e.type) ||
    typeof e.occurredAt !== 'string'
  ) {
    throw new PoisonMessageError('Malformed event envelope');
  }
  return e as EventEnvelope;
};

/**
 * Idempotent consumer: the inbox row and the handler's writes commit together, so a redelivered
 * event is a no-op and a crash mid-handler retries cleanly.
 */
export const createInbox =
  <TTx>(options: InboxOptions<TTx>) =>
  async (event: EventEnvelope): Promise<InboxResult> => {
    const handler = options.handlers[event.type];
    if (handler === undefined) return 'ignored';
    return options.runInTransaction(async (tx) => {
      if (!(await options.claim(tx, event.id, options.consumer))) return 'duplicate';
      await handler(event, tx);
      return 'processed';
    });
  };
