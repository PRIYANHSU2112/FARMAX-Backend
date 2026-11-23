import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';
import Joi from 'joi';

import { rateLimit, requireUser } from '../../middleware/guards.js';
import { CHAT_DOCS } from './chat.docs.js';

/** Mounted at `/support/chat` (gateway: `/v1/support/chat`, WebSocket-enabled proxy). */
export const chatRoutes: FastifyPluginAsync = async (app) => {
  const chat = app.diContainer.resolve('chatService');
  // The socket server shares the HTTP server; it starts with the app and closes before it.
  app.addHook('onReady', async () => {
    await app.diContainer
      .resolve('realtimeHub')
      .ready()
      .catch((err: unknown) => {
        app.log.warn({ err }, 'realtime hub not ready yet; it retries on the first connection');
      });
    chat.start(app.server);
  });
  app.addHook('onClose', async () => {
    await chat.stop();
  });

  app.post<{ Body: { as?: 'requester' | 'agent' } }>(
    '/ws-token',
    {
      schema: {
        body: Joi.object({
          as: Joi.string().valid('requester', 'agent').default('requester'),
        }).default({}),
        ...routeDocs(CHAT_DOCS.token),
      },
      preHandler: [requireUser, rateLimit('ws-token', 20, 60)],
    },
    async (req) => ok(await chat.issueToken(req, req.body.as ?? 'requester')),
  );
  app.get('/ws', { schema: routeDocs(CHAT_DOCS.socket) }, async (_req, reply) =>
    reply
      .status(426)
      .header('upgrade', 'websocket')
      .send({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Use a WebSocket upgrade with ?token=' },
      }),
  );
};
