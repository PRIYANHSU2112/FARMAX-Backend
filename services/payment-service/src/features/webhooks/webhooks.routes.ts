import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { rateLimit } from '../../middleware/guards.js';
import { WEBHOOK_DOCS } from './webhooks.docs.js';

const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Mounted at `/webhooks` (gateway: `/v1/webhooks`). Public, but every delivery must carry a valid
 * HMAC signature over the RAW body: this plugin parses JSON bodies as raw Buffers (encapsulated —
 * other routes keep the normal JSON parser).
 */
export const webhooksRoutes: FastifyPluginAsync = async (app) => {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post<{ Body: Buffer }>(
    '/razorpay',
    {
      schema: routeDocs(WEBHOOK_DOCS.razorpay),
      preHandler: rateLimit('webhook', 600, 60),
    },
    async (req) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const { stored } = await req.diScope
        .resolve('webhooksService')
        .receive(
          raw,
          header(req.headers['x-razorpay-signature']),
          header(req.headers['x-razorpay-event-id']),
        );
      return { status: 'ok', duplicate: !stored };
    },
  );
};
