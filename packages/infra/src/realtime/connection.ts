import { randomUUID } from 'node:crypto';

import type { WebSocket } from 'ws';

import { CloseCode, type ServerFrame } from './protocol.js';
import type { RealtimePrincipal } from './tokens.js';

/** The room every connection joins automatically: pushes addressed to one user. */
export const userRoom = (userId: string): string => `user:${userId}`;

/**
 * One open socket. Handlers get this object; they never touch `ws` directly, so every frame goes
 * through the backpressure guard and the room index stays consistent.
 */
export class RealtimeConnection {
  readonly id = randomUUID();
  readonly rooms = new Set<string>();
  readonly openedAt = Date.now();
  /** Set by the heartbeat; false = a ping is still unanswered. */
  alive = true;
  /** Rate-limit violations on this socket (closes at the server's `maxStrikes`). */
  strikes = 0;

  constructor(
    private readonly ws: WebSocket,
    readonly principal: RealtimePrincipal,
    private readonly opts: {
      maxBufferedBytes: number;
      maxRooms: number;
      onJoin: (conn: RealtimeConnection, room: string) => void;
      onLeave: (conn: RealtimeConnection, room: string) => void;
    },
  ) {}

  hasTag(tag: string): boolean {
    return this.principal.tags.includes(tag);
  }

  /** Joins a room. Returns false when the per-socket room limit is reached. */
  join(room: string): boolean {
    if (this.rooms.has(room)) return true;
    if (this.rooms.size >= this.opts.maxRooms) return false;
    this.rooms.add(room);
    this.opts.onJoin(this, room);
    return true;
  }

  leave(room: string): void {
    if (this.rooms.delete(room)) this.opts.onLeave(this, room);
  }

  /** Sends one frame. A client that cannot keep up is disconnected (it resyncs on reconnect). */
  send(frame: ServerFrame): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > this.opts.maxBufferedBytes) {
      this.close(CloseCode.TRY_AGAIN, 'slow consumer');
      return;
    }
    this.ws.send(JSON.stringify(frame));
  }

  push(type: string, data: unknown, room?: string): void {
    this.send({ type, data, ...(room === undefined ? {} : { room }) });
  }

  close(code: number = CloseCode.NORMAL, reason = ''): void {
    if (this.ws.readyState === this.ws.CLOSED || this.ws.readyState === this.ws.CLOSING) return;
    this.ws.close(code, reason.slice(0, 120));
  }

  terminate(): void {
    this.ws.terminate();
  }

  ping(): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.ping();
  }
}
