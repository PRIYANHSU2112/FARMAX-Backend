import { UnauthorizedError } from '@farmx/common/errors';
import { internalAuth } from '@farmx/common/middleware';
import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { AuthUser } from '@farmx/common/types';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { rateLimit, requireAuth } from '../../middleware/guards.js';
import { idempotencyKeyOf } from '../../middleware/http.js';
import { ORDER_DOCS, ORDERS_TAG } from './orders.docs.js';
import { ledgerDocs } from './orders.ledger.docs.js';
import type { CancelInput, CheckoutInput, DeliveryInput, OrderListQuery } from './orders.types.js';
import {
  buyerCancelSchema,
  checkoutSchema,
  complianceRejectSchema,
  shortageRefundSchema,
  cancelLinesSchema,
  internalDeliverySchema,
  listOrdersSchema,
  orderIdSchema,
  quoteSchema,
  statusesSchema,
} from './orders.validation.js';

interface IdParams {
  id: string;
}

const svc = (req: FastifyRequest) => req.diScope.resolve('ordersService');
const userOf = (req: FastifyRequest): AuthUser => {
  if (req.user === null) throw new UnauthorizedError();
  return req.user;
};
const ctx = (req: FastifyRequest) => ({ correlationId: req.id });
const buyer = requireAuth('CUSTOMER');
const AUTH_BUYER_LEDGER =
  'Bearer access token of a `CUSTOMER` with full scope. Own orders only; any other id answers 404.';

/** Mounted at `/orders` (gateway: `/v1/orders`). Buyers only; own orders only. */
export const ordersRoutes: FastifyPluginAsync = async (app) => {
  await app.register(ordersCancelRoutes);
  app.post<{ Body: CheckoutInput }>(
    '/checkout',
    {
      schema: { ...checkoutSchema, ...routeDocs(ORDER_DOCS.checkout) },
      preHandler: [buyer, rateLimit('checkout', 10, 60)],
    },
    async (req, reply) => {
      const result = await svc(req).checkout(
        userOf(req),
        idempotencyKeyOf(req),
        req.body,
        ctx(req),
      );
      return reply
        .code(result.replayed ? 200 : 201)
        .send(ok({ order: result.order, payment: result.payment }));
    },
  );
  app.get<{ Querystring: OrderListQuery }>(
    '/',
    { schema: { ...listOrdersSchema, ...routeDocs(ORDER_DOCS.list) }, preHandler: buyer },
    async (req) => paginated(await svc(req).list(userOf(req), req.query)),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { ...orderIdSchema, ...routeDocs(ORDER_DOCS.get) }, preHandler: buyer },
    async (req) => ok(await svc(req).get(userOf(req), req.params.id)),
  );
  app.get<{ Params: IdParams }>(
    '/:id/transactions',
    {
      schema: { ...orderIdSchema, ...routeDocs(ledgerDocs(ORDERS_TAG, AUTH_BUYER_LEDGER)) },
      preHandler: buyer,
    },
    async (req) => ok(await svc(req).transactions(userOf(req), req.params.id)),
  );
  app.post<{ Params: IdParams }>(
    '/:id/pay',
    {
      schema: { ...orderIdSchema, ...routeDocs(ORDER_DOCS.pay) },
      preHandler: [buyer, rateLimit('pay', 20, 60)],
    },
    async (req) => {
      const r = await svc(req).pay(userOf(req), req.params.id, ctx(req));
      return ok({ order: r.order, payment: r.payment });
    },
  );
};

/** Buyer cancellation (registered with the buyer routes). */
export const ordersCancelRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: IdParams; Body: Pick<CancelInput, 'lines'> }>(
    '/:id/cancellation-quote',
    {
      schema: { ...quoteSchema, ...routeDocs(ORDER_DOCS.quote) },
      preHandler: [buyer, rateLimit('cancel-quote', 30, 60)],
    },
    async (req) => ok(await svc(req).cancellationQuote(userOf(req), req.params.id, req.body.lines)),
  );
  app.post<{ Params: IdParams; Body: CancelInput }>(
    '/:id/cancel',
    {
      schema: { ...buyerCancelSchema, ...routeDocs(ORDER_DOCS.cancel) },
      preHandler: [buyer, rateLimit('cancel', 10, 60)],
    },
    async (req) =>
      ok(
        await svc(req).cancel(
          userOf(req),
          req.params.id,
          idempotencyKeyOf(req),
          req.body,
          ctx(req),
        ),
      ),
  );
};

/**
 * Mounted at `/internal/orders` (service token, checked BEFORE validation; never routed by the
 * gateway; not in Swagger). For inventory (orphan sweep) and future logistics / invoice services.
 */
export const ordersInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;
  const guard = internalAuth(token);

  app.get<{ Querystring: { ids: string } }>(
    '/status',
    { schema: { hide: true, ...statusesSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).statuses(req.query.ids.split(','))),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { hide: true, ...orderIdSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).getInternal(req.params.id)),
  );
  // F1 / D-57 (warehouse-service): orders per status, fulfilment facts, compliance rejection.
  app.get('/counts', { schema: { hide: true }, onRequest: [guard] }, async (req) =>
    ok(await svc(req).counts()),
  );
  app.get<{ Params: IdParams }>(
    '/:id/fulfilment-facts',
    { schema: { hide: true, ...orderIdSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).fulfilmentFacts(req.params.id)),
  );
  app.post<{
    Params: IdParams;
    Body: { shipmentId: string; lines: { lineNo: number; qty: number }[] };
  }>(
    '/:id/shortage-refund',
    { schema: { hide: true, ...shortageRefundSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).shortageRefund(req.params.id, req.body, ctx(req))),
  );
  app.post<{
    Params: IdParams;
    Body: {
      lines: { variantId: string; qty: number }[];
      reasonCode: string;
      note: string;
      by?: string | null;
    };
  }>(
    '/:id/cancel-lines',
    { schema: { hide: true, ...cancelLinesSchema }, onRequest: [guard] },
    async (req) => {
      const row = await req.diScope
        .resolve('orderCancelService')
        .cancel(
          req.params.id,
          { lines: req.body.lines, reasonCode: req.body.reasonCode, note: req.body.note },
          { type: 'SERVICE', id: req.body.by ?? null },
          { ctx: ctx(req) },
        );
      return ok({ orderId: row.id, status: row.status });
    },
  );
  app.patch<{ Params: IdParams; Body: DeliveryInput & { by: string } }>(
    '/:id/delivery',
    { schema: { hide: true, ...internalDeliverySchema }, onRequest: [guard] },
    async (req) => {
      const { by, ...input } = req.body;
      return ok(
        await req.diScope
          .resolve('ordersAdminService')
          .updateDelivery(
            { userId: by, ip: req.ip, requestId: req.id },
            req.params.id,
            input,
            ctx(req),
          ),
      );
    },
  );
  app.post<{ Params: IdParams; Body: { reason: string } }>(
    '/:id/compliance-reject',
    { schema: { hide: true, ...complianceRejectSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).complianceReject(req.params.id, req.body.reason, ctx(req))),
  );
};
