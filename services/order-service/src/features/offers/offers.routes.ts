import { createHash } from 'node:crypto';

import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';
import Joi from 'joi';

import { rateLimit, requireAuth } from '../../middleware/guards.js';
import { OFFERS_DOCS } from './offers.docs.js';
import type { OffersInput, PreviewInput } from './offers.types.js';
import { offersSchema, previewSchema } from './offers.validation.js';
import { ID } from '../../middleware/http.js';

/** Mounted at `/orders` (gateway: `/v1/orders`). Customers, own ACTIVE farm only. */
export const offersRoutes: FastifyPluginAsync = async (app) => {
  // Public (no login): coupons a shopper can browse before building a cart. Redis 60 s + ETag / 304.
  app.get<{ Querystring: { categoryId?: string } }>(
    '/offers/public',
    {
      schema: {
        querystring: Joi.object({ categoryId: ID }),
        ...routeDocs(OFFERS_DOCS.publicOffers),
      },
      preHandler: [rateLimit('public-offers', 120, 60)],
    },
    async (req, reply) => {
      const body = ok(
        await req.diScope.resolve('offersService').publicOffers(req.query.categoryId),
      );
      const etag = `W/"${createHash('sha1').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;
      void reply
        .header('etag', etag)
        .header('cache-control', 'public, max-age=60, stale-while-revalidate=300');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.send(body);
    },
  );

  const guard = [requireAuth('CUSTOMER'), rateLimit('pricing', 60, 60)];
  app.post<{ Body: OffersInput }>(
    '/offers',
    { schema: { ...offersSchema, ...routeDocs(OFFERS_DOCS.offers) }, preHandler: guard },
    (req) => req.diScope.resolve('offersController').offers(req),
  );
  app.post<{ Body: PreviewInput }>(
    '/preview',
    { schema: { ...previewSchema, ...routeDocs(OFFERS_DOCS.preview) }, preHandler: guard },
    (req) => req.diScope.resolve('offersController').preview(req),
  );
};
