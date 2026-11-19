import amqp, { type Channel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';

import type { EventEnvelope } from './envelope.js';
import { type InboxResult, PoisonMessageError, parseEnvelope } from './inbox.js';
import type { EventPublisher } from './relay.js';

/** Topic exchange every event goes to; routing key = event type. */
export const EVENTS_EXCHANGE = 'events';
/** Dead-letter exchange; each consumer queue `<q>` has a `<q>.dlq` bound by its name. */
export const EVENTS_DLX = 'events.dlx';
const ATTEMPT_HEADER = 'x-farmx-attempts';

interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

type Connection = Awaited<ReturnType<typeof amqp.connect>>;

/**
 * Publisher with broker confirms: `publish` resolves only once RabbitMQ has the message, so the
 * relay marks the outbox row published only after a confirm. Reconnects lazily after a failure.
 */
export class RabbitPublisher implements EventPublisher {
  private connection: Connection | undefined;
  private channel: Promise<ConfirmChannel> | undefined;

  constructor(
    private readonly url: string,
    private readonly logger: Logger,
  ) {}

  private open(): Promise<ConfirmChannel> {
    this.channel ??= (async () => {
      const connection = await amqp.connect(this.url);
      const reset = () => {
        this.connection = undefined;
        this.channel = undefined;
      };
      connection.on('error', (err: unknown) => {
        this.logger.warn({ err }, 'rabbitmq publisher connection error');
      });
      connection.on('close', reset);
      this.connection = connection;
      const channel = await connection.createConfirmChannel();
      channel.on('close', reset);
      await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
      return channel;
    })().catch((err: unknown) => {
      this.channel = undefined;
      throw err;
    });
    return this.channel;
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    const channel = await this.open();
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EVENTS_EXCHANGE,
        envelope.type,
        Buffer.from(JSON.stringify(envelope)),
        {
          persistent: true,
          contentType: 'application/json',
          messageId: envelope.id,
          type: envelope.type,
          timestamp: Math.floor(Date.parse(envelope.occurredAt) / 1000),
          headers: { correlationId: envelope.correlationId },
        },
        (err) => {
          if (err === null || err === undefined) resolve();
          else reject(err instanceof Error ? err : new Error('Broker nack'));
        },
      );
    });
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.channel = undefined;
    await connection?.close().catch(() => undefined);
  }
}

export interface ConsumerOptions {
  url: string;
  /** Durable queue name = inbox consumer name, e.g. `product-service.catalog-events`. */
  queue: string;
  /** Routing-key patterns, e.g. `['catalog.brand.*.v1']`. */
  bindings: string[];
  handle: (event: EventEnvelope) => Promise<InboxResult>;
  logger: Logger;
  prefetch?: number;
  /** Deliveries before a failing message is dead-lettered. */
  maxAttempts?: number;
}

/** Declares exchange, DLX, queue (+ `.dlq`) and bindings. Exported for tests and ops scripts. */
export const declareTopology = async (channel: Channel, queue: string, bindings: string[]) => {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(EVENTS_DLX, 'direct', { durable: true });
  await channel.assertQueue(`${queue}.dlq`, { durable: true });
  await channel.bindQueue(`${queue}.dlq`, EVENTS_DLX, queue);
  await channel.assertQueue(queue, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': EVENTS_DLX, 'x-dead-letter-routing-key': queue },
  });
  for (const pattern of bindings) await channel.bindQueue(queue, EVENTS_EXCHANGE, pattern);
};

/** What to do with a delivery after the handler ran (pure; unit-tested). */
export const settle = (
  error: unknown,
  attempts: number,
  maxAttempts: number,
): 'ack' | 'retry' | 'dead-letter' => {
  if (error === undefined) return 'ack';
  if (error instanceof PoisonMessageError) return 'dead-letter';
  return attempts + 1 < maxAttempts ? 'retry' : 'dead-letter';
};

/**
 * Durable, idempotent consumer (the handler goes through `createInbox`). Failures are retried by
 * re-queueing with an attempt counter, then dead-lettered. Reconnects with backoff.
 */
export class RabbitConsumer {
  private connection: Connection | undefined;
  private closed = false;
  private retryDelayMs = 1_000;

  constructor(private readonly options: ConsumerOptions) {}

  async start(): Promise<void> {
    const { url, queue, bindings, logger } = this.options;
    try {
      const connection = await amqp.connect(url);
      this.connection = connection;
      connection.on('error', (err: unknown) => {
        logger.warn({ err, queue }, 'rabbitmq consumer connection error');
      });
      connection.on('close', () => {
        this.connection = undefined;
        this.reconnect();
      });
      const channel = await connection.createChannel();
      await declareTopology(channel, queue, bindings);
      await channel.prefetch(this.options.prefetch ?? 10);
      await channel.consume(queue, (msg) => {
        if (msg !== null) void this.onMessage(channel, msg);
      });
      this.retryDelayMs = 1_000;
      logger.info({ queue, bindings }, 'event consumer started');
    } catch (err) {
      // Usually RabbitMQ is still booting: reconnect() retries with backoff (1 s → 30 s), forever.
      logger.error(
        { err, queue, retryInMs: this.retryDelayMs },
        'event consumer failed to start; retrying',
      );
      this.reconnect();
    }
  }

  private reconnect(): void {
    if (this.closed) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
    setTimeout(() => void this.start(), delay);
  }

  private async onMessage(channel: Channel, msg: ConsumeMessage): Promise<void> {
    const { queue, logger } = this.options;
    const headers = msg.properties.headers ?? {};
    const attempts = Number(headers[ATTEMPT_HEADER] ?? 0);
    let error: unknown;
    try {
      await this.options.handle(parseEnvelope(msg.content));
    } catch (err) {
      error = err;
    }
    const action = settle(error, attempts, this.options.maxAttempts ?? 5);
    if (action === 'ack') {
      channel.ack(msg);
      return;
    }
    logger.warn({ queue, attempts: attempts + 1, err: error, action }, 'event handling failed');
    if (action === 'retry') {
      channel.sendToQueue(queue, msg.content, {
        ...msg.properties,
        headers: { ...headers, [ATTEMPT_HEADER]: attempts + 1 },
      });
      channel.ack(msg);
    } else {
      channel.nack(msg, false, false);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.connection?.close().catch(() => undefined);
  }
}
