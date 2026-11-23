import type { Logger } from '@farmx/common/logger';
import type { Redis } from 'ioredis';

import { CloseCode } from './protocol.js';
import type { RealtimeConnection } from './connection.js';

/** One fan-out message on the Redis channel (all replicas receive it). */
export interface HubMessage {
  /** Push to a room, or close every socket of a user. */
  kind: 'push' | 'kick';
  room: string;
  event?: string;
  data?: unknown;
  /** Deliver only to connections carrying at least one of these tags (e.g. `agent`). */
  audience?: string[];
  /** Skip this connection (no echo of a sender's own typing frame). */
  except?: string;
  closeCode?: number;
  reason?: string;
}

export interface PublishOptions {
  audience?: string[];
  except?: string;
}

/**
 * Cross-replica rooms over ONE Redis pub/sub channel. Each replica holds an index
 * room → connections and delivers what it owns. Delivery is best effort by design: every
 * realtime event also lives in Postgres, and clients resync on (re)connect (`afterSeq`).
 * Publish only AFTER the database transaction commits.
 */
export class RealtimeHub {
  private readonly rooms = new Map<string, Set<RealtimeConnection>>();
  private subscriber: Redis | undefined;
  private subscribing: Promise<void> | undefined;

  constructor(private readonly deps: { redis: () => Redis; channel: string; logger: Logger }) {}

  /** Fire-and-forget; never throws. */
  publish(room: string, event: string, data: unknown, options: PublishOptions = {}): void {
    this.send({ kind: 'push', room, event, data, ...options });
  }

  /** Closes every socket of a user on every replica (logout, suspension, account deletion). */
  kickUser(userId: string, reason: string, closeCode: number = CloseCode.UNAUTHORIZED): void {
    this.send({ kind: 'kick', room: `user:${userId}`, reason, closeCode });
  }

  /** Resolves once this replica listens on the channel (awaited before accepting sockets). */
  ready(): Promise<void> {
    this.subscribing ??= (async () => {
      const subscriber = this.deps.redis().duplicate();
      this.subscriber = subscriber;
      subscriber.on('message', (_channel: string, raw: string) => {
        try {
          this.dispatch(JSON.parse(raw) as HubMessage);
        } catch (err) {
          this.deps.logger.warn({ err }, 'bad realtime message');
        }
      });
      await subscriber.subscribe(this.deps.channel);
    })().catch((err: unknown) => {
      this.subscribing = undefined;
      throw err;
    });
    return this.subscribing;
  }

  /** Local delivery (exported for tests). */
  dispatch(message: HubMessage): void {
    const members = this.rooms.get(message.room);
    if (members === undefined) return;
    for (const conn of [...members]) {
      if (message.kind === 'kick') {
        conn.close(message.closeCode ?? CloseCode.UNAUTHORIZED, message.reason ?? '');
        continue;
      }
      if (message.except === conn.id) continue;
      if (message.audience !== undefined && !message.audience.some((t) => conn.hasTag(t))) continue;
      conn.push(message.event ?? 'event', message.data, message.room);
    }
  }

  /** Room index maintenance (called by the connection). */
  add(conn: RealtimeConnection, room: string): void {
    let set = this.rooms.get(room);
    if (set === undefined) this.rooms.set(room, (set = new Set()));
    set.add(conn);
  }

  remove(conn: RealtimeConnection, room: string): void {
    const set = this.rooms.get(room);
    if (set === undefined) return;
    set.delete(conn);
    if (set.size === 0) this.rooms.delete(room);
  }

  /** Local connections in a room (for presence lists). */
  localMembers(room: string): readonly RealtimeConnection[] {
    return [...(this.rooms.get(room) ?? [])];
  }

  async close(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
    this.subscriber = undefined;
    this.subscribing = undefined;
  }

  private send(message: HubMessage): void {
    this.deps
      .redis()
      .publish(this.deps.channel, JSON.stringify(message))
      .catch((err: unknown) => {
        this.deps.logger.warn({ err, room: message.room }, 'realtime publish failed');
      });
  }
}
