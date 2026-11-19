import type { EventEnvelope } from './envelope.js';

/** Sends one envelope to the broker and resolves only once the broker confirmed it. */
export interface EventPublisher {
  publish(envelope: EventEnvelope): Promise<void>;
}

/** Structural twin of `@farmx/database` `OutboxSource` (infra does not depend on the database). */
export interface OutboxDrain {
  drain(
    limit: number,
    publish: (
      rows: { id: string; type: string; payload: unknown }[],
    ) => Promise<({ id: string; ok: true } | { id: string; ok: false; error: string })[]>,
  ): Promise<number>;
}

interface RelayLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface OutboxRelayOptions {
  source: OutboxDrain;
  publisher: EventPublisher;
  logger: RelayLogger;
  /** Rows per transaction. */
  batchSize?: number;
  /** Pause when the outbox is empty (a full batch drains again immediately). */
  idleMs?: number;
}

/**
 * Transactional-outbox relay: drains unpublished rows to RabbitMQ (at-least-once; consumers
 * de-duplicate through the inbox). Rows are published in commit order within a batch; a failed
 * row is retried on the next pass without blocking the rest.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;
  private readonly batchSize: number;
  private readonly idleMs: number;

  constructor(private readonly options: OutboxRelayOptions) {
    this.batchSize = options.batchSize ?? 100;
    this.idleMs = options.idleMs ?? 500;
  }

  /** One pass. Returns the number of rows claimed. */
  async tick(): Promise<number> {
    const { source, publisher, logger } = this.options;
    return source.drain(this.batchSize, async (rows) => {
      const outcomes = [];
      for (const row of rows) {
        try {
          await publisher.publish(row.payload as EventEnvelope);
          outcomes.push({ id: row.id, ok: true as const });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logger.warn({ eventId: row.id, type: row.type, err: error }, 'outbox publish failed');
          outcomes.push({ id: row.id, ok: false as const, error });
        }
      }
      return outcomes;
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), delay);
  }

  private async loop(): Promise<void> {
    this.running = true;
    let claimed = 0;
    try {
      claimed = await this.tick();
    } catch (err) {
      this.options.logger.error({ err }, 'outbox relay pass failed');
    } finally {
      this.running = false;
    }
    this.schedule(claimed >= this.batchSize ? 0 : this.idleMs);
  }
}
