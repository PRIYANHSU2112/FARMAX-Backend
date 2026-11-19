import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { admin, adminWrite } from '../../middleware/guards.js';
import { idempotencyKeyOf } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import { STOCK_DOCS } from './stock.docs.js';
import type { OperationResult } from './stock.service.js';
import type {
  AdjustmentInput,
  DamageInput,
  DecisionInput,
  LedgerListQuery,
  LevelListQuery,
  OperationListQuery,
  ReceiptInput,
  ThresholdsInput,
} from './stock.types.js';
import {
  adjustmentSchema,
  decisionSchema,
  getOperationSchema,
  levelSchema,
  listLedgerSchema,
  listLevelsSchema,
  listOperationsSchema,
  movementSchema,
  receiptSchema,
  thresholdsSchema,
} from './stock.validation.js';

interface LevelParams {
  warehouseId: string;
  variantId: string;
}
interface IdParams {
  id: string;
}

const svc = (req: FastifyRequest) => req.diScope.resolve('stockService');

const sendOperation = (reply: FastifyReply, result: OperationResult) =>
  reply.code(result.replayed ? 200 : 201).send(ok(result.operation));

/** Mounted at `/admin/inventory` (gateway: `/v1/admin/inventory`). Staff only. */
export const stockRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: LevelListQuery }>(
    '/stock',
    {
      schema: { ...listLevelsSchema, ...routeDocs(STOCK_DOCS.listLevels) },
      preHandler: admin('inventory.view'),
    },
    async (req) => paginated(await svc(req).listLevels(req.query)),
  );
  app.get<{ Params: LevelParams }>(
    '/stock/:warehouseId/:variantId',
    {
      schema: { ...levelSchema, ...routeDocs(STOCK_DOCS.getLevel) },
      preHandler: admin('inventory.view'),
    },
    async (req) => ok(await svc(req).getLevel(req.params.warehouseId, req.params.variantId)),
  );
  app.patch<{ Params: LevelParams; Body: ThresholdsInput }>(
    '/stock/:warehouseId/:variantId/thresholds',
    {
      schema: { ...thresholdsSchema, ...routeDocs(STOCK_DOCS.thresholds) },
      preHandler: adminWrite('inventory.configure'),
    },
    async (req) =>
      ok(
        await svc(req).setThresholds(
          actorOf(req),
          req.params.warehouseId,
          req.params.variantId,
          req.body,
        ),
      ),
  );
  app.post<{ Body: ReceiptInput }>(
    '/receipts',
    {
      schema: { ...receiptSchema, ...routeDocs(STOCK_DOCS.receipt) },
      preHandler: adminWrite('inventory.receive'),
    },
    async (req, reply) =>
      sendOperation(reply, await svc(req).receive(actorOf(req), idempotencyKeyOf(req), req.body)),
  );
  app.post<{ Body: DamageInput }>(
    '/damage',
    {
      schema: { ...movementSchema, ...routeDocs(STOCK_DOCS.damage) },
      preHandler: adminWrite('inventory.exception_raise'),
    },
    async (req, reply) =>
      sendOperation(reply, await svc(req).damage(actorOf(req), idempotencyKeyOf(req), req.body)),
  );
  app.post<{ Body: DamageInput }>(
    '/write-offs',
    {
      schema: { ...movementSchema, ...routeDocs(STOCK_DOCS.writeOff) },
      preHandler: adminWrite('inventory.write_off'),
    },
    async (req, reply) =>
      sendOperation(reply, await svc(req).writeOff(actorOf(req), idempotencyKeyOf(req), req.body)),
  );
  app.post<{ Body: AdjustmentInput }>(
    '/adjustments',
    {
      schema: { ...adjustmentSchema, ...routeDocs(STOCK_DOCS.adjustment) },
      preHandler: adminWrite('inventory.exception_raise'),
    },
    async (req, reply) =>
      sendOperation(
        reply,
        await svc(req).requestAdjustment(actorOf(req), idempotencyKeyOf(req), req.body),
      ),
  );
  app.post<{ Params: IdParams; Body: DecisionInput }>(
    '/adjustments/:id/approve',
    {
      schema: { ...decisionSchema, ...routeDocs(STOCK_DOCS.approve) },
      preHandler: adminWrite('inventory.adjust'),
    },
    async (req) => ok(await svc(req).approveAdjustment(actorOf(req), req.params.id, req.body)),
  );
  app.post<{ Params: IdParams; Body: DecisionInput }>(
    '/adjustments/:id/reject',
    {
      schema: { ...decisionSchema, ...routeDocs(STOCK_DOCS.reject) },
      preHandler: adminWrite('inventory.adjust'),
    },
    async (req) => ok(await svc(req).rejectAdjustment(actorOf(req), req.params.id, req.body)),
  );
  app.get<{ Querystring: OperationListQuery }>(
    '/operations',
    {
      schema: { ...listOperationsSchema, ...routeDocs(STOCK_DOCS.listOperations) },
      preHandler: admin('inventory.view'),
    },
    async (req) => paginated(await svc(req).listOperations(req.query)),
  );
  app.get<{ Params: IdParams }>(
    '/operations/:id',
    {
      schema: { ...getOperationSchema, ...routeDocs(STOCK_DOCS.getOperation) },
      preHandler: admin('inventory.view'),
    },
    async (req) => ok(await svc(req).getOperation(req.params.id)),
  );
  app.get<{ Querystring: LedgerListQuery }>(
    '/ledger',
    {
      schema: { ...listLedgerSchema, ...routeDocs(STOCK_DOCS.ledger) },
      preHandler: admin('inventory.view'),
    },
    async (req) => paginated(await svc(req).listLedger(req.query)),
  );
};
