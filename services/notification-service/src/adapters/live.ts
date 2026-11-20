import type { Logger } from '@farmx/common/logger';
import { type Redis, notificationKeys } from '@farmx/infra/redis';

import type { NotificationApp } from '../domain.js';
import type { Metrics } from './metrics.js';

/** One SSE event for a set of users of one app (a page of recipients = one Redis message). */
export interface LiveMessage {
  userIds: string[];
  app: NotificationApp;
  event: 'notification' | 'unread_count';
  data: unknown;
}

/** An open stream on this replica. `send` writes one SSE frame. */
export interface LiveStream {
  userId: string;
  app: NotificationApp;
  send: (event: string, data: unknown) => void;
}

/**
 * Live inbox updates across replicas: every replica publishes to ONE Redis channel and keeps ONE
 * subscriber connection, delivering to the streams it holds. Best effort by design: a missed live
 * event is recovered by the app's next inbox / unread-count read (the inbox is the source of truth).
 */
export class LiveHub {
  private readonly streams = new Map<string, Set<LiveStream>>();
  private subscriber: Redis | undefined;
  private subscribing: Promise<void> | undefined;

  constructor(private readonly deps: { redis: () => Redis; logger: Logger; metrics: Metrics }) {}

  /** Fire-and-forget publish; never throws. */
  publish(message: LiveMessage): void {
    if (message.userIds.length === 0) return;
    this.deps
      .redis()
      .publish(notificationKeys.liveChannel(), JSON.stringify(message))
      .catch((err: unknown) => {
        this.deps.logger.warn({ err }, 'live publish failed');
      });
  }

  /** Resolves once this replica listens to the channel (call before opening a stream). */
  ready(): Promise<void> {
    return this.ensureSubscribed();
  }

  /** Registers a stream (after `ready()`); returns its unsubscribe function. */
  add(stream: LiveStream): () => void {
    let own = this.streams.get(stream.userId);
    if (own === undefined) this.streams.set(stream.userId, (own = new Set()));
    own.add(stream);
    this.deps.metrics.sseConnections.inc();
    return () => {
      const set = this.streams.get(stream.userId);
      if (set?.delete(stream) === true) this.deps.metrics.sseConnections.dec();
      if (set?.size === 0) this.streams.delete(stream.userId);
    };
  }

  /** Delivers a message to this replica's matching streams (exported for tests). */
  dispatch(message: LiveMessage): void {
    for (const userId of message.userIds) {
      for (const stream of this.streams.get(userId) ?? []) {
        if (stream.app === message.app) stream.send(message.event, message.data);
      }
    }
  }

  async close(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
  }

  private ensureSubscribed(): Promise<void> {
    this.subscribing ??= (async () => {
      const subscriber = this.deps.redis().duplicate();
      this.subscriber = subscriber;
      subscriber.on('message', (_channel: string, raw: string) => {
        try {
          this.dispatch(JSON.parse(raw) as LiveMessage);
        } catch (err) {
          this.deps.logger.warn({ err }, 'bad live message');
        }
      });
      await subscriber.subscribe(notificationKeys.liveChannel());
    })().catch((err: unknown) => {
      this.subscribing = undefined;
      throw err;
    });
    return this.subscribing;
  }
}
