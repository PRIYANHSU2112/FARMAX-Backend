import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, customer, rateLimit } from '../../middleware/guards.js';
import type { ProductParams } from './wishlist.controller.js';
import { WISHLIST_DOCS } from './wishlist.docs.js';
import type { AddWishlistInput, WishlistQuery } from './wishlist.types.js';
import {
  addSchema,
  adminListSchema,
  listSchema,
  productParamsSchema,
} from './wishlist.validation.js';

const c = (request: FastifyRequest) => request.diScope.resolve('wishlistController');

/** Mounted at `/me/wishlist` (gateway `/v1/me/wishlist`). The caller's own wishlist. */
export const wishlistRoutes: FastifyPluginAsync = async (app) => {
  const read = [...customer, rateLimit('wishlist-read', 120, 60)];
  const write = [...customer, rateLimit('wishlist-write', 30, 60)];
  const D = WISHLIST_DOCS;

  app.get<{ Querystring: WishlistQuery }>(
    '/',
    { schema: { ...listSchema, ...routeDocs(D.list) }, preHandler: read },
    (req) => c(req).list(req),
  );
  app.get(
    '/ids',
    { schema: routeDocs(D.ids), preHandler: [...customer, rateLimit('wishlist-ids', 30, 60)] },
    (req) => c(req).ids(req),
  );
  app.post<{ Body: AddWishlistInput }>(
    '/',
    { schema: { ...addSchema, ...routeDocs(D.add) }, preHandler: write },
    (req, reply) => c(req).add(req, reply),
  );
  app.delete<{ Params: ProductParams }>(
    '/:productId',
    { schema: { ...productParamsSchema, ...routeDocs(D.remove) }, preHandler: write },
    (req, reply) => c(req).remove(req, reply),
  );
  app.delete('/', { schema: routeDocs(D.clear), preHandler: write }, (req, reply) =>
    c(req).clear(req, reply),
  );
};

/** Mounted at `/admin/customers` (gateway `/v1/admin/customers`). Support, read-only. */
export const wishlistAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { userId: string }; Querystring: WishlistQuery }>(
    '/:userId/wishlist',
    {
      schema: { ...adminListSchema, ...routeDocs(WISHLIST_DOCS.adminList) },
      preHandler: admin('customers.view'),
    },
    (req) => c(req).adminList(req),
  );
};
