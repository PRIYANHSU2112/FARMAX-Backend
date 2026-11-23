import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { type Audience, audRead, audWrite, callerOf } from '../../middleware/guards.js';
import { stockDocs } from './stock.docs.js';
import type {
  AdjustmentInput,
  CoaInput,
  MoveInput,
  OwnerFixInput,
  ProposalDecision,
  ProposalInput,
  QualityInput,
  ReceiptInput,
  RelabelInput,
  StatusChangeInput,
  ThresholdInput,
} from './stock.types.js';
import * as V from './stock.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('stockService');
const idem = (req: FastifyRequest) => String(req.headers['idempotency-key']);
interface Id {
  id: string;
}
interface Page {
  cursor?: string;
  limit: number;
}

/**
 * D-57a stock commands. Mounted twice with the same handlers: `/wms` (warehouse panel, scoped)
 * and `/admin/wms` (admin panel, GLOBAL). Admin-only routes: lifecycle decisions, settings.
 */
export const stockRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = stockDocs(aud);
    const r = (key: string) => audRead(aud, key);
    const w = (key: string) => audWrite(aud, key);

    app.post<{ Body: ReceiptInput }>(
      '/stock/receipts',
      {
        schema: { ...V.receiptSchema, ...routeDocs(D.receive) },
        preHandler: w('inventory.receive'),
      },
      async (req, reply) =>
        reply.code(201).send(ok(await svc(req).receive(callerOf(req), req.body, idem(req)))),
    );
    app.get<{ Querystring: Page & { warehouseId?: string } }>(
      '/stock/receipts',
      { schema: { ...V.receiptsQuery, ...routeDocs(D.receipts) }, preHandler: r('inventory.view') },
      async (req) => {
        const page = await svc(req).receipts(callerOf(req), req.query);
        return paginated(page);
      },
    );
    app.get<{ Params: Id }>(
      '/stock/receipts/:id',
      { schema: { ...V.idParam, ...routeDocs(D.receipt) }, preHandler: r('inventory.view') },
      async (req) => {
        const view = await svc(req).receiptView(req.params.id);
        callerOf(req).access.require('inventory.view', view.warehouseId);
        return ok(view);
      },
    );
    app.post<{ Params: { batchId: string }; Body: { warehouseId: string } }>(
      '/stock/batches/:batchId/units/generate',
      {
        schema: { ...V.generateUnitsSchema, ...routeDocs(D.generateUnits) },
        preHandler: w('inventory.receive'),
      },
      async (req, reply) =>
        reply
          .code(201)
          .send(
            ok(
              await svc(req).generateUnits(callerOf(req), req.params.batchId, req.body.warehouseId),
            ),
          ),
    );
    app.put<{ Params: { batchId: string }; Body: CoaInput }>(
      '/stock/batches/:batchId/coa',
      { schema: { ...V.coaSchema, ...routeDocs(D.coa) }, preHandler: w('quality.hold_create') },
      async (req) => ok(await svc(req).setCoa(callerOf(req), req.params.batchId, req.body)),
    );
    app.post<{ Body: QualityInput }>(
      '/stock/quality/release',
      {
        schema: { ...V.releaseSchema, ...routeDocs(D.release) },
        preHandler: w('quality.hold_release'),
      },
      async (req) => ok(await svc(req).release(callerOf(req), req.body)),
    );
    app.post<{ Body: QualityInput }>(
      '/stock/quality/hold',
      { schema: { ...V.holdSchema, ...routeDocs(D.hold) }, preHandler: w('quality.hold_create') },
      async (req) => ok(await svc(req).hold(callerOf(req), req.body)),
    );
    app.post<{ Body: StatusChangeInput }>(
      '/stock/status-changes',
      {
        schema: { ...V.statusChangeSchema, ...routeDocs(D.statusChange) },
        preHandler: w('warehouse.view'),
      },
      async (req) => ok(await svc(req).statusChange(callerOf(req), req.body)),
    );
    app.post<{ Body: MoveInput }>(
      '/stock/moves',
      { schema: { ...V.moveSchema, ...routeDocs(D.move) }, preHandler: w('inventory.receive') },
      async (req) => ok(await svc(req).moveBin(callerOf(req), req.body)),
    );
    app.post<{ Body: AdjustmentInput }>(
      '/stock/adjustments',
      {
        schema: { ...V.adjustmentSchema, ...routeDocs(D.adjust) },
        preHandler: w('inventory.adjust'),
      },
      async (req, reply) =>
        reply.code(201).send(ok(await svc(req).adjust(callerOf(req), req.body, idem(req)))),
    );
    app.get<{ Querystring: Page & { warehouseId?: string; status?: string } }>(
      '/stock/adjustments',
      {
        schema: { ...V.adjustmentsQuery, ...routeDocs(D.adjustments) },
        preHandler: r('inventory.view'),
      },
      async (req) => {
        const page = await svc(req).adjustments(callerOf(req), req.query);
        return paginated(page);
      },
    );
    for (const [action, approve] of [
      ['approve', true],
      ['reject', false],
    ] as const)
      app.post<{ Params: Id; Body: { expectedVersion: number; note?: string | null } }>(
        `/stock/adjustments/:id/${action}`,
        {
          schema: {
            ...V.decideSchema,
            ...routeDocs(approve ? D.approveAdjustment : D.rejectAdjustment),
          },
          preHandler: w('inventory.adjust'),
        },
        async (req) =>
          ok(
            await svc(req).decideAdjustment(
              callerOf(req),
              req.params.id,
              approve,
              req.body.note ?? null,
              req.body.expectedVersion,
            ),
          ),
      );
    app.post<{ Params: Id; Body: OwnerFixInput }>(
      '/stock/positions/:id/owner',
      { schema: { ...V.ownerSchema, ...routeDocs(D.owner) }, preHandler: w('inventory.adjust') },
      async (req) => ok(await svc(req).fixOwner(callerOf(req), req.params.id, req.body)),
    );
    app.post<{ Params: { positionId: string }; Body: RelabelInput }>(
      '/stock/opening/:positionId/relabel',
      {
        schema: { ...V.relabelSchema, ...routeDocs(D.relabel) },
        preHandler: w('inventory.receive'),
      },
      async (req) =>
        ok(await svc(req).relabelOpening(callerOf(req), req.params.positionId, req.body)),
    );

    // Thresholds (WMS-owned).
    app.get<{ Params: { warehouseId: string; variantId: string } }>(
      '/stock/thresholds/:warehouseId/:variantId',
      {
        schema: { ...V.thresholdParams, ...routeDocs(D.threshold) },
        preHandler: r('inventory.view'),
      },
      async (req) =>
        ok(await svc(req).threshold(callerOf(req), req.params.warehouseId, req.params.variantId)),
    );
    app.put<{ Params: { warehouseId: string; variantId: string }; Body: ThresholdInput }>(
      '/stock/thresholds/:warehouseId/:variantId',
      {
        schema: { ...V.thresholdSchema, ...routeDocs(D.setThreshold) },
        preHandler: w('warehouse.configure'),
      },
      async (req) =>
        ok(
          await svc(req).setThresholds(callerOf(req), req.params.warehouseId, [
            { ...req.body, variantId: req.params.variantId },
          ]),
        ),
    );
    app.put<{ Body: { warehouseId: string; rows: (ThresholdInput & { variantId: string })[] } }>(
      '/stock/thresholds/bulk',
      {
        schema: { ...V.thresholdBulkSchema, ...routeDocs(D.setThresholdsBulk) },
        preHandler: w('warehouse.configure'),
      },
      async (req) =>
        ok(await svc(req).setThresholds(callerOf(req), req.body.warehouseId, req.body.rows)),
    );

    // Lifecycle (W4.11).
    app.get(
      '/stock/lifecycle',
      { schema: { ...routeDocs(D.lifecycle) }, preHandler: r('inventory.view') },
      async (req) => ok(await svc(req).lifecycle()),
    );
    app.get(
      '/stock/lifecycle/transitions',
      { schema: { ...routeDocs(D.transitions) }, preHandler: r('inventory.view') },
      async (req) => ok(await svc(req).transitions()),
    );
    app.get<{ Querystring: Page & { status?: string } }>(
      '/stock/lifecycle/proposals',
      {
        schema: { ...V.proposalsQuery, ...routeDocs(D.proposals) },
        preHandler: r('inventory.view'),
      },
      async (req) => {
        const page = await svc(req).proposals(req.query);
        return paginated(page);
      },
    );
    app.post<{ Body: ProposalInput }>(
      '/stock/lifecycle/proposals',
      {
        schema: { ...V.proposalSchema, ...routeDocs(D.propose) },
        preHandler: w('warehouse.configure'),
      },
      async (req, reply) =>
        reply.code(201).send(ok(await svc(req).propose(callerOf(req), req.body))),
    );

    if (aud !== 'admin') return;

    // ── Admin panel only ──
    for (const [action, approve] of [
      ['approve', true],
      ['reject', false],
    ] as const)
      app.post<{ Params: Id; Body: ProposalDecision }>(
        `/stock/lifecycle/proposals/:id/${action}`,
        {
          schema: {
            ...V.proposalDecisionSchema,
            ...routeDocs(approve ? D.approveProposal : D.rejectProposal),
          },
          preHandler: w('inventory.lifecycle_approve'),
        },
        async (req) =>
          ok(await svc(req).decideProposal(callerOf(req), req.params.id, approve, req.body)),
      );
    app.get<{ Querystring: { scope: string } }>(
      '/stock/settings',
      {
        schema: { ...V.settingsQuery, ...routeDocs(D.settings) },
        preHandler: r('inventory.configure'),
      },
      async (req) => ok(await svc(req).allSettings(req.query.scope)),
    );
    app.put<{ Querystring: { scope: string }; Body: Record<string, unknown> }>(
      '/stock/settings',
      {
        schema: { ...V.settingsSchema, ...routeDocs(D.setSettings) },
        preHandler: w('inventory.configure'),
      },
      async (req) => ok(await svc(req).setSettings(callerOf(req), req.body, req.query.scope)),
    );
  };
