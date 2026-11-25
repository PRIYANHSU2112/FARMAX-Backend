import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { type Audience, audRead, audWrite, callerOf } from '../../middleware/guards.js';
import { type Paging, pageBody } from '../../middleware/paging.js';
import { restockDocs } from './restock.docs.js';
import type { RequestInput } from './restock.service.js';
import * as V from './restock.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('restockService');
const id = (req: FastifyRequest) => (req.params as { id: string }).id;
type Q = Record<string, string | number | undefined>;
const paging = (q: Q): Paging => ({
  limit: Number(q.limit),
  ...(q.cursor === undefined ? {} : { cursor: String(q.cursor) }),
  ...(q.page === undefined ? {} : { page: Number(q.page) }),
});
const pick = <K extends string>(q: Q, keys: readonly K[]) => {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) if (q[k] !== undefined) out[k] = String(q[k]);
  return out;
};

/**
 * D-57a W4.07 / W4.08: restock requests (procurement / warehouse transfer) and transfers.
 * Both audiences; approve / reject are admin-panel only (GLOBAL `inventory.restock_approve`).
 */
export const restockRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = restockDocs(aud);
    const r = (key: string) => audRead(aud, key);
    const w = (key: string) => audWrite(aud, key);

    app.get(
      '/stock/restock-requests/prefill',
      { schema: { ...V.prefillQuery, ...routeDocs(D.prefill) }, preHandler: r('inventory.view') },
      async (req) => {
        const q = req.query as { warehouseId: string; variantIds: string };
        return ok(await svc(req).prefill(callerOf(req), q.warehouseId, q.variantIds.split(',')));
      },
    );
    app.post<{ Body: RequestInput }>(
      '/stock/restock-requests',
      {
        schema: { ...V.createSchema, ...routeDocs(D.create) },
        preHandler: w('inventory.restock_request'),
      },
      async (req, reply) =>
        reply.code(201).send(ok(await svc(req).create(callerOf(req), req.body))),
    );
    app.get(
      '/stock/restock-requests',
      { schema: { ...V.listQuery, ...routeDocs(D.list) }, preHandler: r('inventory.view') },
      async (req) => {
        const q = req.query as Q;
        return pageBody(
          await svc(req).list(
            callerOf(req),
            pick(q, ['month', 'status', 'type', 'warehouseId'] as const),
            paging(q),
          ),
        );
      },
    );
    app.get(
      '/stock/restock-requests/:id',
      { schema: { ...V.idParam, ...routeDocs(D.view) }, preHandler: r('inventory.view') },
      async (req) => ok(await svc(req).view(callerOf(req), id(req))),
    );
    app.patch<{ Body: Partial<RequestInput> & { expectedVersion: number } }>(
      '/stock/restock-requests/:id',
      {
        schema: { ...V.updateSchema, ...routeDocs(D.update) },
        preHandler: w('inventory.restock_request'),
      },
      async (req) => ok(await svc(req).update(callerOf(req), id(req), req.body)),
    );
    app.post(
      '/stock/restock-requests/:id/submit',
      {
        schema: { ...V.idParam, ...routeDocs(D.submit) },
        preHandler: w('inventory.restock_request'),
      },
      async (req) => ok(await svc(req).submit(callerOf(req), id(req))),
    );
    app.post<{ Body: { note?: string | null } }>(
      '/stock/restock-requests/:id/cancel',
      {
        schema: { ...V.noteSchema, ...routeDocs(D.cancel) },
        preHandler: w('inventory.restock_request'),
      },
      async (req) => ok(await svc(req).cancel(callerOf(req), id(req), req.body.note ?? null)),
    );
    app.post<{ Body: { etaAt?: string; lines?: { variantId: string; qty: number }[] } }>(
      '/stock/restock-requests/:id/dispatch',
      {
        schema: { ...V.dispatchSchema, ...routeDocs(D.dispatch) },
        preHandler: w('inventory.transfer'),
      },
      async (req, reply) =>
        reply.code(201).send(ok(await svc(req).dispatch(callerOf(req), id(req), req.body))),
    );

    app.get(
      '/stock/transfers',
      {
        schema: { ...V.transfersQuery, ...routeDocs(D.transfers) },
        preHandler: r('inventory.view'),
      },
      async (req) => {
        const q = req.query as Q;
        const f = pick(q, ['status', 'warehouseId'] as const);
        const direction = q.direction === 'in' || q.direction === 'out' ? q.direction : undefined;
        return pageBody(
          await svc(req).transfers(
            callerOf(req),
            { ...f, ...(direction === undefined ? {} : { direction }) },
            paging(q),
          ),
        );
      },
    );
    app.get(
      '/stock/transfers/:id',
      { schema: { ...V.idParam, ...routeDocs(D.transfer) }, preHandler: r('inventory.view') },
      async (req) => ok(await svc(req).transferView(callerOf(req), id(req))),
    );
    app.post<{
      Body: {
        lines: { lineNo: number; receivedQty: number; binId?: string | null }[];
        notes?: string | null;
        close?: boolean;
      };
    }>(
      '/stock/transfers/:id/receive',
      {
        schema: { ...V.receiveSchema, ...routeDocs(D.receive) },
        preHandler: w('inventory.receive'),
      },
      async (req) => ok(await svc(req).receive(callerOf(req), id(req), req.body)),
    );

    if (aud === 'admin') {
      app.post<{
        Body: { note?: string | null; lines?: { variantId: string; approvedQty: number }[] };
      }>(
        '/stock/restock-requests/:id/approve',
        {
          schema: { ...V.approveSchema, ...routeDocs(D.approve) },
          preHandler: w('inventory.restock_approve'),
        },
        async (req) => ok(await svc(req).decide(callerOf(req), id(req), true, req.body)),
      );
      app.post<{ Body: { note: string } }>(
        '/stock/restock-requests/:id/reject',
        {
          schema: { ...V.rejectSchema, ...routeDocs(D.reject) },
          preHandler: w('inventory.restock_approve'),
        },
        async (req) => ok(await svc(req).decide(callerOf(req), id(req), false, req.body)),
      );
    }
  };
