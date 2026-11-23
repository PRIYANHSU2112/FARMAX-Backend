import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { AppError, ErrorCode } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import type { Redis } from 'ioredis';
import { type RawData, WebSocketServer } from 'ws';

import { hitRateLimit } from '../redis/rate-limit.js';
import { RealtimeConnection, userRoom } from './connection.js';
import type { RealtimeHub } from './hub.js';
import { CloseCode, type ClientFrame, parseClientFrame } from './protocol.js';
import type { ConnectTokens, RealtimePrincipal } from './tokens.js';

/** One frame handler. `parse` validates `data` (throw an AppError to reject); `handle` replies. */
export interface FrameHandler<T = unknown> {
  parse?: (data: unknown) => T;
  /** May return a value or a promise of one (the ack payload). */
  handle: (conn: RealtimeConnection, data: T) => unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a registry mixes payload types
export type FrameHandlers = Record<string, FrameHandler<any>>;

export interface RealtimeLimits {
  /** Max bytes of one inbound frame (ws closes with 1009 above it). Default 16 KiB. */
  maxPayloadBytes: number;
  /** Open sockets per user across all replicas. Default 5. */
  maxConnectionsPerUser: number;
  /** Rooms per socket (the auto `user:` room included). Default 21. */
  maxRoomsPerConnection: number;
  /** Inbound frames per user per window, shared by all replicas. Default 30 / 10 s. */
  framesPerWindow: number;
  windowSeconds: number;
  /** Rate-limit violations before the socket is closed with 4008. Default 3. */
  maxStrikes: number;
  /** Outbound buffer above which a slow client is dropped (it resyncs). Default 1 MiB. */
  maxBufferedBytes: number;
  /** Protocol ping interval; a socket missing one pong is terminated. Default 25 s. */
  heartbeatMs: number;
  /** How often each socket's session is re-validated. Default 60 s. */
  revalidateMs: number;
}

export interface RealtimeServerOptions {
  /** Exact request path, e.g. `/support/chat/ws`. */
  path: string;
  logger: Logger;
  redis: () => Redis;
  hub: RealtimeHub;
  tokens: ConnectTokens;
  handlers: FrameHandlers;
  /**
   * Allowed `Origin` values. A request WITHOUT an Origin (native apps) is accepted (the token
   * authenticates it); a browser Origin must be listed. `*` accepts any origin (local dev only).
   */
  allowedOrigins: readonly string[];
  /** Key of the per-user open-socket counter and of the per-user frame rate limit. */
  keys: { connections: (userId: string) => string; rateLimit: (userId: string) => string };
  /** Re-checked every `revalidateMs`: false closes the socket with 4001 (revoked, suspended …). */
  revalidate?: (principal: RealtimePrincipal) => Promise<boolean>;
  onConnect?: (conn: RealtimeConnection) => void;
  onDisconnect?: (conn: RealtimeConnection) => void;
  limits?: Partial<RealtimeLimits>;
}

const DEFAULT_LIMITS: RealtimeLimits = {
  maxPayloadBytes: 16 * 1024,
  maxConnectionsPerUser: 5,
  maxRoomsPerConnection: 21,
  framesPerWindow: 30,
  windowSeconds: 10,
  maxStrikes: 3,
  maxBufferedBytes: 1024 * 1024,
  heartbeatMs: 25_000,
  revalidateMs: 60_000,
};

/** Counter TTL: refreshed by every heartbeat, so a crashed replica's counts fade out. */
const CONN_COUNT_TTL_SECONDS = 120;

/**
 * THE WebSocket server of a FarmX service: every socket concern lives here, services only plug in
 * frame handlers and a token issuer.
 *  - Upgrade on one exact path; Origin allowlist; single-use connect token (no header needed).
 *  - Per-user socket cap across replicas; per-user frame rate limit (Redis) with strikes.
 *  - Frame size cap (ws `maxPayload`), JSON-only protocol, per-type validation, ack / error replies.
 *  - Heartbeat ping/pong, periodic session re-validation, backpressure drop, graceful shutdown.
 *  - Rooms + fan-out through `RealtimeHub` (Redis pub/sub across replicas).
 */
export class RealtimeServer {
  private readonly limits: RealtimeLimits;
  private readonly wss: WebSocketServer;
  private readonly connections = new Set<RealtimeConnection>();
  private heartbeat: NodeJS.Timeout | undefined;
  private revalidation: NodeJS.Timeout | undefined;
  private server: Server | undefined;
  private closing = false;

  constructor(private readonly opts: RealtimeServerOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.limits.maxPayloadBytes,
      perMessageDeflate: false,
      clientTracking: false,
    });
  }

  /** Attaches to the HTTP server (call once the app is ready). Other upgrade paths are ignored. */
  attach(server: Server): void {
    this.server = server;
    server.on('upgrade', this.onUpgrade);
    this.heartbeat = setInterval(() => {
      this.beat();
    }, this.limits.heartbeatMs);
    this.heartbeat.unref();
    if (this.opts.revalidate !== undefined) {
      this.revalidation = setInterval(() => {
        void this.revalidateAll();
      }, this.limits.revalidateMs);
      this.revalidation.unref();
    }
  }

  get size(): number {
    return this.connections.size;
  }

  /** Stops accepting, closes every socket with 1001 (clients reconnect elsewhere). */
  async close(): Promise<void> {
    this.closing = true;
    this.server?.off('upgrade', this.onUpgrade);
    clearInterval(this.heartbeat);
    clearInterval(this.revalidation);
    for (const conn of this.connections) conn.close(CloseCode.GOING_AWAY, 'server shutting down');
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });
  }

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== this.opts.path) return; // another listener's path
    void this.accept(req, socket, head, url).catch((err: unknown) => {
      this.opts.logger.error({ err }, 'websocket upgrade failed');
      reject(socket, 500, 'Internal Server Error');
    });
  };

  private async accept(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
  ): Promise<void> {
    if (this.closing) {
      reject(socket, 503, 'Service Unavailable');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !this.originAllowed(origin)) {
      reject(socket, 403, 'Forbidden');
      return;
    }

    const token = url.searchParams.get('token') ?? '';
    const principal = await this.opts.tokens.consume(token).catch(() => null);
    if (principal === null) {
      reject(socket, 401, 'Unauthorized');
      return;
    }

    const counted = await this.countConnection(principal.userId, 1);
    if (counted > this.limits.maxConnectionsPerUser) {
      await this.countConnection(principal.userId, -1);
      reject(socket, 429, 'Too Many Requests');
      return;
    }
    await this.opts.hub.ready();

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new RealtimeConnection(ws, principal, {
        maxBufferedBytes: this.limits.maxBufferedBytes,
        maxRooms: this.limits.maxRoomsPerConnection,
        onJoin: (c, room) => {
          this.opts.hub.add(c, room);
        },
        onLeave: (c, room) => {
          this.opts.hub.remove(c, room);
        },
      });
      this.connections.add(conn);
      conn.join(userRoom(principal.userId));

      ws.on('pong', () => {
        conn.alive = true;
      });
      ws.on('message', (raw: RawData, isBinary: boolean) => {
        void this.onFrame(conn, raw, isBinary);
      });
      ws.on('error', (err) => {
        this.opts.logger.debug({ err, connId: conn.id }, 'websocket error');
      });
      ws.on('close', () => {
        this.connections.delete(conn);
        for (const room of [...conn.rooms]) conn.leave(room);
        void this.countConnection(principal.userId, -1);
        this.safe(() => this.opts.onDisconnect?.(conn));
      });

      conn.push('ready', { connectionId: conn.id, heartbeatMs: this.limits.heartbeatMs });
      this.safe(() => this.opts.onConnect?.(conn));
    });
  }

  private async onFrame(conn: RealtimeConnection, raw: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      conn.close(CloseCode.POLICY, 'binary frames are not supported');
      return;
    }
    const frame = parseClientFrame(rawToString(raw));
    if (frame === null) {
      conn.send({
        type: 'error',
        error: { code: ErrorCode.BAD_REQUEST, message: 'Malformed frame' },
      });
      return;
    }
    if (!(await this.withinRate(conn, frame))) return;
    if (frame.type === 'ping') {
      reply(conn, frame, { at: new Date().toISOString() });
      return;
    }

    const handler = this.opts.handlers[frame.type];
    if (handler === undefined) {
      replyError(conn, frame, ErrorCode.BAD_REQUEST, `Unknown frame type "${frame.type}"`);
      return;
    }
    try {
      const data: unknown = handler.parse === undefined ? frame.data : handler.parse(frame.data);
      const result = await handler.handle(conn, data);
      reply(conn, frame, result ?? null);
    } catch (err) {
      if (err instanceof AppError) {
        replyError(conn, frame, err.code, err.message);
        return;
      }
      this.opts.logger.error(
        { err, type: frame.type, connId: conn.id },
        'websocket handler failed',
      );
      replyError(conn, frame, ErrorCode.INTERNAL_ERROR, 'Something went wrong');
    }
  }

  /** Shared fixed window per user. Redis down → allow (availability over limiting). */
  private async withinRate(conn: RealtimeConnection, frame: ClientFrame): Promise<boolean> {
    try {
      const result = await hitRateLimit(
        this.opts.redis(),
        this.opts.keys.rateLimit(conn.principal.userId),
        this.limits.framesPerWindow,
        this.limits.windowSeconds,
      );
      if (result.allowed) return true;
    } catch {
      return true;
    }
    conn.strikes += 1;
    if (conn.strikes >= this.limits.maxStrikes) {
      conn.close(CloseCode.RATE_LIMITED, 'rate limit exceeded');
      return false;
    }
    replyError(conn, frame, ErrorCode.RATE_LIMITED, 'Too many messages; slow down');
    return false;
  }

  private beat(): void {
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.terminate();
        continue;
      }
      conn.alive = false;
      conn.ping();
    }
    const users = new Set([...this.connections].map((c) => c.principal.userId));
    if (users.size === 0) return;
    const pipeline = this.opts.redis().pipeline();
    for (const userId of users)
      pipeline.expire(this.opts.keys.connections(userId), CONN_COUNT_TTL_SECONDS);
    pipeline.exec().catch(() => undefined);
  }

  private async revalidateAll(): Promise<void> {
    const check = this.opts.revalidate;
    if (check === undefined) return;
    for (const conn of [...this.connections]) {
      const valid = await check(conn.principal).catch(() => true); // store down → keep the socket
      if (!valid) conn.close(CloseCode.UNAUTHORIZED, 'session ended');
    }
  }

  /** INCRBY on the per-user counter; Redis down → 0 (allow). */
  private async countConnection(userId: string, delta: 1 | -1): Promise<number> {
    try {
      const key = this.opts.keys.connections(userId);
      const [[, count] = [null, 0]] = ((await this.opts
        .redis()
        .multi()
        .incrby(key, delta)
        .expire(key, CONN_COUNT_TTL_SECONDS)
        .exec()) ?? []) as [unknown, number][];
      if (count < 0) await this.opts.redis().set(key, '0', 'EX', CONN_COUNT_TTL_SECONDS);
      return count;
    } catch {
      return 0;
    }
  }

  private originAllowed(origin: string): boolean {
    const list = this.opts.allowedOrigins;
    return list.includes('*') || list.includes(origin);
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.logger.warn({ err }, 'realtime hook failed');
    }
  }
}

const rawToString = (raw: RawData): string =>
  Array.isArray(raw)
    ? Buffer.concat(raw).toString('utf8')
    : Buffer.from(raw as ArrayBuffer).toString('utf8');

const reply = (conn: RealtimeConnection, frame: ClientFrame, data: unknown): void => {
  if (frame.id !== undefined) conn.send({ type: 'ack', id: frame.id, data });
};

const replyError = (
  conn: RealtimeConnection,
  frame: ClientFrame,
  code: string,
  message: string,
) => {
  conn.send({
    type: 'error',
    ...(frame.id === undefined ? {} : { id: frame.id }),
    error: { code, message },
  });
};

/** Refuses an upgrade with a plain HTTP status (no socket is opened). */
function reject(socket: Duplex, status: number, text: string): void {
  if (!socket.writable) return;
  socket.write(
    `HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}
