import { Readable } from 'node:stream';
import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { type Audience, audRead, callerOf, rateLimit } from '../../middleware/guards.js';
import { type Paging, pageBody } from '../../middleware/paging.js';
import { stockReadDocs } from './stock.read.docs.js';
import * as V from './stock.read.validation.js';

type Q = Record<string, string | number | boolean | undefined> & Paging;
const q = (req: FastifyRequest) => req.query as Q;
const svc = (req: FastifyRequest) => req.diScope.resolve('stockQueries');
const wh = (req: FastifyRequest) => q(req).warehouseId as string | undefined;
const fresh = (req: FastifyRequest) => q(req).fresh === true;
const vid = (req: FastifyRequest) => (req.params as { variantId: string }).variantId;
const bid = (req: FastifyRequest) => (req.params as { batchId: string }).batchId;
const paging = (req: FastifyRequest): Paging => ({
  limit: q(req).limit,
  ...(q(req).cursor === undefined ? {} : { cursor: String(q(req).cursor) }),
  ...(q(req).page === undefined ? {} : { page: Number(q(req).page) }),
});
/** Query string without paging / undefined keys → service filter object. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed filter view of the validated query
const filters = <T>(req: FastifyRequest): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q(req)))
    if (v !== undefined && !['cursor', 'page', 'limit', 'fresh'].includes(k)) out[k] = v;
  return out as T;
};
const csv = (reply: FastifyReply, name: string, rows: AsyncIterable<string>) =>
  reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header(
      'content-disposition',
      `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
    )
    .send(Readable.from(rows));

/** D-57a Phase 2: W4 screen reads (both audiences). */
export const stockReadRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = stockReadDocs(aud);
    const view = audRead(aud, 'inventory.view');
    const exportGuard = [...audRead(aud, 'inventory.view'), rateLimit('export', 5, 60)];
    const get = (
      path: string,
      schema: object,
      docs: Parameters<typeof routeDocs>[0],
      h: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    ) => app.get(path, { schema: { ...schema, ...routeDocs(docs) }, preHandler: view }, h);

    // W4.00 landing
    get('/stock/landing/kpis', V.whQuery, D.landingKpis, async (req) =>
      ok(await svc(req).landingKpis(callerOf(req), wh(req), fresh(req))),
    );
    get('/stock/landing/by-category', V.byCategoryQuery, D.landingByCategory, async (req) =>
      ok(await svc(req).landingByCategory(callerOf(req), wh(req), Number(q(req).top), fresh(req))),
    );
    get('/stock/landing/status-mix', V.whQuery, D.landingStatusMix, async (req) =>
      ok(await svc(req).landingStatusMix(callerOf(req), wh(req), fresh(req))),
    );
    get('/stock/category-matrix', V.freshQuery, D.categoryMatrix, async (req) =>
      ok(await svc(req).categoryMatrix(callerOf(req), fresh(req))),
    );
    get('/stock/products', V.productsQuery, D.products, async (req) =>
      pageBody(await svc(req).products(callerOf(req), filters(req), paging(req))),
    );
    get('/stock/products/search', V.productsQuery, D.products, async (req) =>
      pageBody(await svc(req).products(callerOf(req), filters(req), paging(req))),
    );

    // W4.01 overview
    get('/stock/overview/kpis', V.whQuery, D.overviewKpis, async (req) =>
      ok(await svc(req).overviewKpis(callerOf(req), wh(req), fresh(req))),
    );
    get('/stock/overview/warehouses', V.freshQuery, D.overviewWarehouses, async (req) =>
      ok(await svc(req).overviewWarehouses(callerOf(req), fresh(req))),
    );
    get('/stock/overview/status-mix', V.whQuery, D.overviewStatusMix, async (req) =>
      ok(await svc(req).overviewStatusMix(callerOf(req), wh(req), fresh(req))),
    );

    // W4.02 all stock
    get('/stock/records', V.recordsQuery, D.records, async (req) =>
      pageBody(await svc(req).records(callerOf(req), filters(req), paging(req))),
    );
    app.get(
      '/stock/records/export.csv',
      { schema: { ...V.recordsQuery, ...routeDocs(D.recordsCsv) }, preHandler: exportGuard },
      async (req, reply) =>
        csv(reply, 'stock-records', svc(req).recordsCsv(callerOf(req), filters(req))),
    );
    get('/stock/filter-options', V.filterOptionsQuery, D.filterOptions, async (req) =>
      ok(
        await svc(req).filterOptions(
          callerOf(req),
          String(q(req).field),
          q(req).q as string | undefined,
          wh(req),
        ),
      ),
    );

    // W4.03 product
    get('/stock/products/:variantId', V.variantParams, D.productHeader, async (req) =>
      ok(await svc(req).productHeader(callerOf(req), vid(req))),
    );
    get('/stock/products/:variantId/kpis', V.variantWhQuery, D.productKpis, async (req) =>
      ok(await svc(req).productKpis(callerOf(req), vid(req), wh(req))),
    );
    get(
      '/stock/products/:variantId/warehouses',
      V.variantParams,
      D.productWarehouses,
      async (req) => ok(await svc(req).productWarehouses(callerOf(req), vid(req))),
    );
    get('/stock/products/:variantId/batches', V.variantWhQuery, D.productBatches, async (req) =>
      ok(await svc(req).productBatches(callerOf(req), vid(req), wh(req))),
    );
    get(
      '/stock/products/:variantId/availability',
      V.variantWhQuery,
      D.productAvailability,
      async (req) => ok(await svc(req).productAvailability(callerOf(req), vid(req), wh(req))),
    );
    get(
      '/stock/products/:variantId/movements',
      V.variantPagedQuery,
      D.productMovements,
      async (req) =>
        pageBody(
          await svc(req).movements(
            callerOf(req),
            { variantId: vid(req), ...(wh(req) === undefined ? {} : { warehouseId: wh(req) }) },
            paging(req),
          ),
        ),
    );
    get('/stock/products/:variantId/units', V.variantUnitsQuery, D.productUnits, async (req) =>
      pageBody(
        await svc(req).units(callerOf(req), { ...filters(req), variantId: vid(req) }, paging(req)),
      ),
    );

    // W4.04 batch
    get('/stock/batches/:batchId', V.batchWhQuery, D.batchHeader, async (req) =>
      ok(await svc(req).batchHeader(callerOf(req), bid(req), wh(req))),
    );
    get('/stock/batches/:batchId/kpis', V.batchWhQuery, D.batchKpis, async (req) =>
      ok(await svc(req).batchKpis(callerOf(req), bid(req), wh(req))),
    );
    get('/stock/batches/:batchId/traceability', V.batchWhQuery, D.batchTraceability, async (req) =>
      ok(await svc(req).batchTraceability(callerOf(req), bid(req), wh(req))),
    );
    get('/stock/batches/:batchId/units', V.batchUnitsQuery, D.batchUnits, async (req) =>
      pageBody(
        await svc(req).units(callerOf(req), { ...filters(req), batchId: bid(req) }, paging(req)),
      ),
    );
    get('/stock/batches/:batchId/quality', V.batchWhQuery, D.batchQuality, async (req) =>
      ok(await svc(req).batchQuality(callerOf(req), bid(req), wh(req))),
    );
    get('/stock/batches/:batchId/movements', V.batchMovesQuery, D.batchMovements, async (req) =>
      pageBody(
        await svc(req).movements(
          callerOf(req),
          { batchId: bid(req), ...(wh(req) === undefined ? {} : { warehouseId: wh(req) }) },
          paging(req),
        ),
      ),
    );
    get('/stock/units/:qrCode', V.qrParams, D.unit, async (req) =>
      ok(await svc(req).unit(callerOf(req), (req.params as { qrCode: string }).qrCode)),
    );

    // W4.09 movements
    get('/stock/movements', V.movementsQuery, D.movements, async (req) =>
      pageBody(await svc(req).movements(callerOf(req), filters(req), paging(req))),
    );
    app.get(
      '/stock/movements/export.csv',
      { schema: { ...V.movementsQuery, ...routeDocs(D.movementsCsv) }, preHandler: exportGuard },
      async (req, reply) =>
        csv(reply, 'stock-movements', svc(req).movementsCsv(callerOf(req), filters(req))),
    );
    get('/stock/movements/:id', V.idParam, D.movement, async (req) =>
      ok(await svc(req).movement(callerOf(req), (req.params as { id: string }).id)),
    );

    // W4.10 ownership
    get('/stock/ownership/kpis', V.whQuery, D.ownershipKpis, async (req) =>
      ok(await svc(req).ownershipKpis(callerOf(req), wh(req), fresh(req))),
    );
    get('/stock/ownership', V.ownershipQuery, D.ownership, async (req) =>
      pageBody(await svc(req).ownership(callerOf(req), filters(req), paging(req))),
    );

    // W4.06 alerts / W4.07 plan
    get('/stock/alerts/kpis', V.whQuery, D.alertKpis, async (req) =>
      ok(await svc(req).alertKpis(callerOf(req), wh(req), fresh(req))),
    );
    get('/stock/alerts/count', V.whQuery, D.alertCount, async (req) =>
      ok(await svc(req).alertCount(callerOf(req), wh(req))),
    );
    get('/stock/alerts', V.alertsQuery, D.alerts, async (req) =>
      pageBody(await svc(req).alerts(callerOf(req), filters(req), paging(req))),
    );
    get('/stock/restock-plan', V.planQuery, D.restockPlan, async (req) => {
      const page = await svc(req).restockPlan(callerOf(req), filters(req), paging(req));
      const body = pageBody(page);
      return { ...body, meta: { ...body.meta, month: page.month, note: page.note } };
    });
    get('/stock/restock-plan/item', V.planItemQuery, D.restockPlanItem, async (req) =>
      ok(
        await svc(req).restockPlanItem(
          callerOf(req),
          String(q(req).variantId),
          String(q(req).warehouseId),
        ),
      ),
    );
  };
