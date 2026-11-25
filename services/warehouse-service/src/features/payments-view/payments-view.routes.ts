import { Readable } from 'node:stream';

import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { type Audience, audRead, callerOf, rateLimit } from '../../middleware/guards.js';
import { type Paging, pageBody } from '../../middleware/paging.js';
import { paymentsViewDocs } from './payments-view.docs.js';
import type { LedgerTab } from './payments-view.repository.js';
import * as V from './payments-view.validation.js';

type Q = Record<string, string | number | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const svc = (req: FastifyRequest) => req.diScope.resolve('paymentsViewService');
const ledger = (req: FastifyRequest) => {
  const f = q(req);
  return {
    tab: (f.tab ?? 'all') as LedgerTab,
    ...(f.q === undefined ? {} : { q: String(f.q) }),
    ...(f.warehouseId === undefined ? {} : { warehouseId: String(f.warehouseId) }),
    ...(f.method === undefined ? {} : { method: String(f.method) }),
  };
};
const paging = (req: FastifyRequest): Paging => ({
  limit: Number(q(req).limit ?? 20),
  ...(q(req).cursor === undefined ? {} : { cursor: String(q(req).cursor) }),
  ...(q(req).page === undefined ? {} : { page: Number(q(req).page) }),
});

/** D-57b W3.18 payment view (prepaid parts; credit is a later phase). Both audiences, read only. */
export const paymentsViewRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = paymentsViewDocs(aud);
    const R = audRead(aud, 'fulfilment.view');
    app.get(
      '/payments-view/kpis',
      { schema: { ...V.kpisQuery, ...routeDocs(D.kpis) }, preHandler: R },
      async (req) =>
        ok(
          await svc(req).kpis(
            callerOf(req),
            q(req).warehouseId as string | undefined,
            q(req).month as string | undefined,
          ),
        ),
    );
    app.get(
      '/payments-view/orders',
      { schema: { ...V.ordersQuery, ...routeDocs(D.orders) }, preHandler: R },
      async (req) => {
        const page = await svc(req).orders(callerOf(req), ledger(req), paging(req));
        return { ...pageBody(page), tabs: page.tabs };
      },
    );
    app.get(
      '/payments-view/orders/export.csv',
      {
        schema: { ...V.csvQuery, ...routeDocs(D.csv) },
        preHandler: [...R, rateLimit('export', 5, 60)],
      },
      async (req, reply) =>
        reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="payments-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          .send(Readable.from(svc(req).exportCsv(callerOf(req), ledger(req)))),
    );
    app.get(
      '/payments-view/customers/:userId',
      { schema: { ...V.customerParams, ...routeDocs(D.customer) }, preHandler: R },
      async (req) =>
        ok(await svc(req).customer(callerOf(req), (req.params as { userId: string }).userId)),
    );
    app.get(
      '/payments-view/sla',
      { schema: { ...V.slaQuery, ...routeDocs(D.sla) }, preHandler: R },
      async (req) => ok(await svc(req).sla(q(req).month as string | undefined)),
    );
  };
