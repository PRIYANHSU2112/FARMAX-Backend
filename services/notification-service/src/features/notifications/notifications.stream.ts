import { RateLimitError } from '@farmx/common/errors';
import { notificationKeys } from '@farmx/infra/redis';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { NotificationApp } from '../../domain.js';
import { userOf } from '../../middleware/http.js';

const MAX_STREAMS_PER_USER = 5;
const HEARTBEAT_MS = 25_000;
/** Stream counter TTL: refreshed by heartbeats, so a crashed replica's counts fade out. */
const COUNTER_TTL_S = 90;
/** Ask the client to re-authenticate this long before the access token expires. */
const REAUTH_EARLY_MS = 30_000;

/**
 * Opens an SSE stream for the caller's inbox of `app`. The connection lives until the client
 * leaves or the access token is about to expire (`reauth`), so a revoked / expired token never
 * keeps receiving data for longer than its lifetime.
 */
export async function openStream(
  request: FastifyRequest,
  reply: FastifyReply,
  app: NotificationApp,
): Promise<void> {
  const user = userOf(request);
  const { redis, liveHub, inboxService } = request.diScope.cradle;
  const counterKey = notificationKeys.streams(user.id);

  // Concurrent streams per user across replicas (Redis down → allow; availability first).
  let counted = false;
  try {
    const open = await redis.incr(counterKey);
    counted = true;
    await redis.expire(counterKey, COUNTER_TTL_S);
    if (open > MAX_STREAMS_PER_USER) {
      counted = false;
      await redis.decr(counterKey);
      throw new RateLimitError(30);
    }
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    request.log.warn({ err }, 'stream counter unavailable; allowing');
  }

  let closed = false;
  const release = () => {
    if (counted) void redis.decr(counterKey).catch(() => undefined);
    counted = false;
  };
  try {
    // Fail with a normal JSON error (503) before any byte is streamed.
    await liveHub.ready();
    const unreadCount = await inboxService.unreadCount(user.id, app);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: string, data: unknown) => {
      if (!closed) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    raw.write('retry: 5000\n\n');
    send('unread_count', { unreadCount });

    const unsubscribe = liveHub.add({ userId: user.id, app, send });
    const heartbeat = setInterval(() => {
      if (closed) return;
      raw.write(': ping\n\n');
      void redis.expire(counterKey, COUNTER_TTL_S).catch(() => undefined);
    }, HEARTBEAT_MS);
    const untilReauth = Math.max(0, user.expiresAt * 1000 - Date.now() - REAUTH_EARLY_MS);
    const reauth = setTimeout(
      () => {
        send('reauth', {});
        raw.end();
      },
      Math.min(untilReauth, 2_147_000_000),
    );
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(reauth);
      unsubscribe();
      release();
    };
    raw.on('close', cleanup);
    raw.on('error', cleanup);
  } catch (err) {
    release();
    throw err;
  }
}
