import { ok } from '@farmx/common/response';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { internalGuard } from '../../middleware/guards.js';
import type { CreditInput, DebitInput } from './purchases.types.js';
import {
  balanceSchema,
  creditSchema,
  debitSchema,
  debitStatusSchema,
} from './purchases.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('purchasesService');

/**
 * Mounted at `/internal/wallet` (service token; never routed by the gateway; not in Swagger).
 * Caller: payment-service (WALLET provider: debit, status, refund credit) and order-service
 * (checkout balance pre-check).
 */
export const purchasesInternalRoutes: FastifyPluginAsync = async (app) => {
  const guard = internalGuard(app);
  if (guard === null) return;

  app.post<{ Body: DebitInput }>(
    '/debits',
    { schema: { hide: true, ...debitSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).debit(req.body)),
  );
  app.get<{ Params: { paymentId: string } }>(
    '/debits/:paymentId',
    { schema: { hide: true, ...debitStatusSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).debitStatus(req.params.paymentId)),
  );
  app.post<{ Body: CreditInput }>(
    '/credits',
    { schema: { hide: true, ...creditSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).credit(req.body)),
  );
  app.get<{ Params: { userId: string } }>(
    '/balance/:userId',
    { schema: { hide: true, ...balanceSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).balance(req.params.userId)),
  );
};
