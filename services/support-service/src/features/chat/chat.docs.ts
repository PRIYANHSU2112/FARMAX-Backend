import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_REQUESTER } from '../../docs/shared.js';

export const CHAT_TAG = 'Support Live Chat';

const PROTOCOL = [
  '**Connect**: `wss://<host>/v1/support/chat/ws?token=<token>` with a token from `POST /v1/support/chat/ws-token` (single use, 60 s). Browsers must send an allowed `Origin`.',
  '**Client → server** `{ "id"?: "c1", "type": "...", "data": {...} }`; replies: `{ "type": "ack", "id": "c1", "data" }` or `{ "type": "error", "id", "error": { code, message } }`.',
  '- `subscribe { ticketId, afterSeq? }` → ack `{ ticketId, status, version, messages[] }` (messages after `afterSeq`: resync without gaps)',
  '- `unsubscribe { ticketId }` · `queue.subscribe` (agents)',
  '- `message.send { ticketId, clientMessageId, body, attachments? }` → ack `{ message, replayed }` (retry with the same clientMessageId is safe)',
  '- `typing { ticketId }` · `read { ticketId, seq }` · `ping`',
  '**Server → client pushes** `{ "type", "room"?, "data" }`: `ready`, `message.new`, `ticket.updated`, `typing`, `read`, `queue.updated` + `sla.breached` (agents).',
  '**Limits**: frame ≤ 16 KB; 30 frames / 10 s per user (3 strikes → close 4008); ≤ 5 sockets per user; ≤ 20 tickets per socket; server pings every 25 s.',
  '**Close codes**: 1001 server restart · 1013 too slow (reconnect + resync) · 4001 session ended · 4008 rate limited. Reconnect with backoff, then `subscribe` with `afterSeq`.',
].join('\n\n');

export const CHAT_DOCS = {
  token: {
    tag: CHAT_TAG,
    auth: AUTH_REQUESTER,
    summary: 'Get a WebSocket connect token',
    description: `\`as: requester\` (default; needs live chat enabled) or \`as: agent\` (staff with support.view; replying needs support.manage).\n\n${PROTOCOL}`,
    rateLimit: '20 per user per minute',
    requestExample: { as: 'requester' },
    success: {
      status: 200,
      description: 'Token',
      data: Joi.object({
        token: Joi.string(),
        expiresIn: Joi.number().integer().example(60),
        path: Joi.string().example('/v1/support/chat/ws?token=…'),
      }).meta({ className: 'ChatToken' }),
    },
    errors: [422, 503],
  },
  socket: {
    tag: CHAT_TAG,
    public: true,
    auth: 'WebSocket upgrade with `?token=` (see the token route).',
    summary: 'Live chat WebSocket',
    description: `Plain HTTP GET answers 426 Upgrade Required.\n\n${PROTOCOL}`,
    success: { status: 200, description: 'Never returned (101 Switching Protocols on upgrade)' },
  },
} satisfies Record<string, RouteDocs>;
