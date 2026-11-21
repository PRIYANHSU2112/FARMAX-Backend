import { UnauthorizedError } from '@farmx/common/errors';
import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { AuthUser } from '@farmx/common/types';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  admin,
  adminWrite,
  customerWrite,
  internalGuard,
  requireCustomer,
} from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import { PAYMENT_DOCS } from './payments.docs.js';
import {
  type CreatePaymentInput,
  type CreateTopupPaymentInput,
  type MockPayInput,
  type PaymentListQuery,
  type VerifyInput,
  toPaymentView,
} from './payments.types.js';
import {
  cancelSchema,
  createPaymentSchema,
  createTopupPaymentSchema,
  getPaymentSchema,
  listPaymentsSchema,
  mockPaySchema,
  verifySchema,
} from './payments.validation.js';

interface IdParams {
  id: string;
}

const svc = (req: FastifyRequest) => req.diScope.resolve('paymentsService');
const userOf = (req: FastifyRequest): AuthUser => {
  if (req.user === null) throw new UnauthorizedError();
  return req.user;
};

/** Mounted at `/payments` (gateway: `/v1/payments`). Buyers only, own payments only. */
export const paymentsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: IdParams }>(
    '/:id',
    {
      schema: { ...getPaymentSchema, ...routeDocs(PAYMENT_DOCS.get) },
      preHandler: requireCustomer,
    },
    async (req) => ok(await svc(req).getForUser(userOf(req), req.params.id)),
  );
  app.post<{ Params: IdParams; Body: VerifyInput }>(
    '/:id/verify',
    {
      schema: { ...verifySchema, ...routeDocs(PAYMENT_DOCS.verify) },
      preHandler: customerWrite('verify', 20),
    },
    async (req) => ok(await svc(req).verify(userOf(req), req.params.id, req.body)),
  );

  // Mock gateway checkout: registered ONLY when PAYMENT_PROVIDER=mock (refused in prod).
  if (app.diContainer.resolve('config').PAYMENT_PROVIDER !== 'mock') return;
  app.post<{ Params: IdParams; Body: MockPayInput }>(
    '/:id/mock/succeed',
    {
      schema: { ...mockPaySchema, ...routeDocs(PAYMENT_DOCS.mockSucceed) },
      preHandler: customerWrite('mock-pay', 20),
    },
    async (req) => ok(await svc(req).mockPay(userOf(req), req.params.id, req.body, 'captured')),
  );
  app.post<{ Params: IdParams; Body: MockPayInput }>(
    '/:id/mock/fail',
    {
      schema: { ...mockPaySchema, ...routeDocs(PAYMENT_DOCS.mockFail) },
      preHandler: customerWrite('mock-pay', 20),
    },
    async (req) => ok(await svc(req).mockPay(userOf(req), req.params.id, req.body, 'failed')),
  );
};

/** Mounted at `/admin/payments` (gateway: `/v1/admin/payments`). Staff only. */
export const paymentsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: PaymentListQuery }>(
    '/',
    {
      schema: { ...listPaymentsSchema, ...routeDocs(PAYMENT_DOCS.adminList) },
      preHandler: admin('payments.view'),
    },
    async (req) => paginated(await svc(req).list(req.query)),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    {
      schema: { ...getPaymentSchema, ...routeDocs(PAYMENT_DOCS.adminGet) },
      preHandler: admin('payments.view'),
    },
    async (req) => {
      const p = await svc(req).get(req.params.id);
      const [attempts, refunds, webhooks] = await Promise.all([
        svc(req).attempts(p.id),
        req.diScope.resolve('refundsService').forPayment(p.id),
        p.providerOrderId === null
          ? Promise.resolve([])
          : req.diScope.resolve('webhooksService').forPaymentOrder(p.providerOrderId),
      ]);
      return ok({ ...toPaymentView(p), attempts, refunds, webhooks });
    },
  );
  app.post<{ Params: IdParams }>(
    '/:id/reconcile',
    {
      schema: { ...getPaymentSchema, ...routeDocs(PAYMENT_DOCS.reconcile) },
      preHandler: adminWrite('payments.reconcile'),
    },
    async (req) => ok(await svc(req).adminReconcile(actorOf(req), req.params.id)),
  );
};

/**
 * Mounted at `/internal/payments` (service token; never routed by the gateway; not in Swagger).
 * Called by order-service checkout ("create / reuse"), order timeout ("live status") and cancel,
 * and by wallet-service (top-up payment, live status).
 */
export const paymentsInternalRoutes: FastifyPluginAsync = async (app) => {
  const guard = internalGuard(app);
  if (guard === null) return;

  app.post<{ Body: CreatePaymentInput }>(
    '/',
    { schema: { hide: true, ...createPaymentSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).createForOrder(req.body)),
  );
  app.post<{ Body: CreateTopupPaymentInput }>(
    '/topups',
    { schema: { hide: true, ...createTopupPaymentSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).createForTopup(req.body)),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { hide: true, ...getPaymentSchema }, onRequest: [guard] },
    async (req) => ok(toPaymentView(await svc(req).get(req.params.id))),
  );
  app.get<{ Params: IdParams }>(
    '/:id/live-status',
    { schema: { hide: true, ...getPaymentSchema }, onRequest: [guard] },
    async (req) => ok(toPaymentView(await svc(req).liveStatus(req.params.id))),
  );
  app.post<{ Params: IdParams; Body: { reason: string } }>(
    '/:id/cancel',
    { schema: { hide: true, ...cancelSchema }, onRequest: [guard] },
    async (req) => ok(toPaymentView(await svc(req).cancel(req.params.id, req.body.reason))),
  );
};
