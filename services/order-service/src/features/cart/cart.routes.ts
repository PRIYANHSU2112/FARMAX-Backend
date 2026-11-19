import { randomUUID } from 'node:crypto';

import { UnauthorizedError, ValidationError } from '@farmx/common/errors';
import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { optionalCustomer, rateLimit, requireAuth } from '../../middleware/guards.js';
import { CART_DOCS } from './cart.docs.js';
import type {
  AddItemInput,
  CartOwner,
  CartQuery,
  CartWriteView,
  SetItemInput,
} from './cart.types.js';
import {
  addItemSchema,
  couponSchema,
  getCartSchema,
  removeItemSchema,
  setItemSchema,
} from './cart.validation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const svc = (req: FastifyRequest) => req.diScope.resolve('cartService');

/** `X-Cart-Token` (guest cart id). Malformed → 422 (never silently another cart). */
const cartToken = (req: FastifyRequest): string | undefined => {
  const header = req.headers['x-cart-token'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value === '') return undefined;
  if (!UUID.test(value))
    throw new ValidationError([{ path: 'headers.x-cart-token', message: 'must be a UUID' }]);
  return value.toLowerCase();
};

/**
 * Whose cart: the customer (JWT) — merging the guest cart sent along, once, right after login —
 * or the guest (`X-Cart-Token`). A guest write without a token gets a fresh one (new cart).
 */
async function ownerOf(
  req: FastifyRequest,
  reply: FastifyReply,
  forWrite: boolean,
): Promise<CartOwner | null> {
  const token = cartToken(req);
  if (req.user !== null) {
    if (token !== undefined) {
      const merged = await svc(req).mergeGuest(req.user.id, token);
      if (merged?.merged === true) void reply.header('x-cart-merged', 'true');
    }
    return { userId: req.user.id };
  }
  if (token !== undefined) return { guestToken: token };
  return forWrite ? { guestToken: randomUUID() } : null;
}

const mustOwn = async (req: FastifyRequest, reply: FastifyReply): Promise<CartOwner> => {
  const owner = await ownerOf(req, reply, true);
  if (owner === null) throw new Error('unreachable: writes always resolve an owner');
  return owner;
};

const sendWrite = (reply: FastifyReply, view: CartWriteView) => {
  if (view.guestToken !== undefined) void reply.header('x-cart-token', view.guestToken);
  return reply.send(ok(view));
};

const userId = (req: FastifyRequest) => {
  if (req.user === null) throw new UnauthorizedError();
  return req.user.id;
};

/** Mounted at `/cart` (gateway: `/v1/cart`). Guests and customers. Thin handlers. */
export const cartRoutes: FastifyPluginAsync = async (app) => {
  const read = [optionalCustomer, rateLimit('cart-read', 240, 60)];
  const write = [optionalCustomer, rateLimit('cart-write', 120, 60)];
  const customer = [requireAuth('CUSTOMER'), rateLimit('cart-write', 120, 60)];

  app.get<{ Querystring: CartQuery }>(
    '/',
    { schema: { ...getCartSchema, ...routeDocs(CART_DOCS.get) }, preHandler: read },
    async (req, reply) => {
      const owner = await ownerOf(req, reply, false);
      void reply.header('cache-control', 'private, no-store');
      return ok(
        await svc(req).get(owner, req.user, req.user === null ? undefined : req.query.farmId),
      );
    },
  );

  app.post<{ Body: AddItemInput }>(
    '/items',
    { schema: { ...addItemSchema, ...routeDocs(CART_DOCS.addItem) }, preHandler: write },
    async (req, reply) =>
      sendWrite(reply, await svc(req).addItem(await mustOwn(req, reply), req.body)),
  );

  app.put<{ Params: { variantId: string }; Body: SetItemInput }>(
    '/items/:variantId',
    { schema: { ...setItemSchema, ...routeDocs(CART_DOCS.setItem) }, preHandler: write },
    async (req, reply) =>
      sendWrite(
        reply,
        await svc(req).setItem(await mustOwn(req, reply), req.params.variantId, req.body),
      ),
  );

  app.delete<{ Params: { variantId: string }; Querystring: { expectedVersion?: number } }>(
    '/items/:variantId',
    { schema: { ...removeItemSchema, ...routeDocs(CART_DOCS.removeItem) }, preHandler: write },
    async (req, reply) =>
      sendWrite(
        reply,
        await svc(req).removeItem(
          await mustOwn(req, reply),
          req.params.variantId,
          req.query.expectedVersion,
        ),
      ),
  );

  app.delete('/', { schema: routeDocs(CART_DOCS.clear), preHandler: write }, async (req, reply) =>
    sendWrite(reply, await svc(req).clear(await mustOwn(req, reply))),
  );

  app.post(
    '/refresh-prices',
    { schema: routeDocs(CART_DOCS.refreshPrices), preHandler: write },
    async (req, reply) => ok(await svc(req).refreshPrices(await mustOwn(req, reply))),
  );

  app.put<{ Body: { code: string } }>(
    '/coupon',
    { schema: { ...couponSchema, ...routeDocs(CART_DOCS.setCoupon) }, preHandler: customer },
    async (req) => ok(await svc(req).setCoupon(userId(req), req.body.code)),
  );

  app.delete(
    '/coupon',
    { schema: routeDocs(CART_DOCS.removeCoupon), preHandler: customer },
    async (req) => ok(await svc(req).removeCoupon(userId(req))),
  );

  app.post('/merge', { schema: routeDocs(CART_DOCS.merge), preHandler: customer }, async (req) => {
    const token = cartToken(req);
    if (token === undefined)
      throw new ValidationError([{ path: 'headers.x-cart-token', message: 'is required' }]);
    const merged = await svc(req).mergeGuest(userId(req), token);
    return ok(merged ?? { merged: false, guestLines: 0, mergedLines: 0 });
  });
};
