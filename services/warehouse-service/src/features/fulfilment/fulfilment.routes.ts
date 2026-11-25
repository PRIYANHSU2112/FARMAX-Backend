import { Readable } from 'node:stream';

import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { type Audience, audRead, audWrite, callerOf, rateLimit } from '../../middleware/guards.js';
import { type Paging, pageBody } from '../../middleware/paging.js';
import { deliveryRoutes } from './fulfilment.delivery.routes.js';
import { splitRoutes } from './fulfilment.split.routes.js';
import { fulfilmentDocs } from './fulfilment.docs.js';
import * as V from './fulfilment.validation.js';

type Q = Record<string, string | number | boolean | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const p = (req: FastifyRequest) => req.params as Record<string, string>;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of the validated body
const b = <T>(req: FastifyRequest) => req.body as T;
const str = (v: string | number | boolean | undefined) => (v === undefined ? undefined : String(v));
const wh = (req: FastifyRequest) => str(q(req).warehouseId);
const fresh = (req: FastifyRequest) => q(req).fresh === true;
const paging = (req: FastifyRequest): Paging => ({
  limit: Number(q(req).limit ?? 20),
  ...(q(req).cursor === undefined ? {} : { cursor: String(q(req).cursor) }),
  ...(q(req).page === undefined ? {} : { page: Number(q(req).page) }),
});
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

/**
 * D-57b Phase 3: order fulfilment (W3.01–W3.07, W3.11, W3.15 hold, W4.05). Mounted at `/wms`
 * (warehouse panel, scoped) and `/admin/wms` (admin panel, GLOBAL) with the same handlers.
 * Admin-only: settings, shelf-life rule writes, allocation reconcile report.
 */
export const fulfilmentRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = fulfilmentDocs(aud);
    const r = (key: string) => audRead(aud, key);
    const w = (key: string) => audWrite(aud, key);
    const orders = (req: FastifyRequest) => req.diScope.resolve('fulfilmentOrders');
    const fefo = (req: FastifyRequest) => req.diScope.resolve('fulfilmentFefo');
    const floor = (req: FastifyRequest) => req.diScope.resolve('fulfilmentFloor');
    const ex = (req: FastifyRequest) => req.diScope.resolve('fulfilmentExceptions');
    const qs = (req: FastifyRequest) => req.diScope.resolve('fulfilmentQueries');
    type Docs = Parameters<typeof routeDocs>[0];
    const get = (
      path: string,
      schema: object,
      docs: Docs,
      key: string,
      h: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    ) => app.get(path, { schema: { ...schema, ...routeDocs(docs) }, preHandler: r(key) }, h);
    const post = (
      path: string,
      schema: object,
      docs: Docs,
      key: string,
      h: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
      method: 'post' | 'put' | 'patch' | 'delete' = 'post',
    ) => app[method](path, { schema: { ...schema, ...routeDocs(docs) }, preHandler: w(key) }, h);
    await deliveryRoutes(aud)(app, {});
    await splitRoutes(aud)(app, {});
    const V_ = 'fulfilment.view';
    const M = 'fulfilment.manage';

    // ── W3.01 dashboard ──
    get('/fulfilment/dashboard/status-strip', V.whQuery, D.strip, V_, async (req) =>
      ok(await qs(req).statusStrip(callerOf(req), wh(req), fresh(req))),
    );
    get('/fulfilment/dashboard/kpis', V.whQuery, D.kpis, V_, async (req) =>
      ok(await qs(req).kpis(callerOf(req), wh(req), fresh(req))),
    );
    get('/fulfilment/dashboard/trend', V.rangeQuery, D.trend, V_, async (req) =>
      ok(await qs(req).trend(callerOf(req), wh(req), str(q(req).from), str(q(req).to))),
    );
    get('/fulfilment/dashboard/fulfilment-rate', V.rangeQuery, D.rate, V_, async (req) =>
      ok(await qs(req).fulfilmentRate(callerOf(req), wh(req), str(q(req).from), str(q(req).to))),
    );
    get('/fulfilment/dashboard/status-mix', V.rangeQuery, D.statusMix, V_, async (req) =>
      ok(await qs(req).statusMix(callerOf(req), wh(req), str(q(req).from), str(q(req).to))),
    );
    get('/fulfilment/dashboard/recent-orders', V.recentQuery, D.recent, V_, async (req) =>
      ok(await qs(req).recentOrders(callerOf(req), wh(req), Number(q(req).limit))),
    );
    get(
      '/fulfilment/dashboard/warehouse-performance',
      V.perfQuery,
      D.performance,
      V_,
      async (req) =>
        ok(
          await qs(req).warehousePerformance(
            callerOf(req),
            str(q(req).from),
            str(q(req).to),
            q(req).groupBy === 'type' ? 'type' : 'warehouse',
          ),
        ),
    );
    get('/fulfilment/dashboard/ops-status', V.whQuery, D.ops, V_, async (req) =>
      ok(await qs(req).opsStatus(callerOf(req), wh(req))),
    );
    get('/sync-status', {}, D.sync, V_, async (req) => ok(await qs(req).syncStatus()));
    get('/fulfilment/nav-counts', V.whQuery, D.nav, V_, async (req) =>
      ok(await qs(req).navCounts(callerOf(req), wh(req))),
    );

    // ── W3.02 / W3.03 orders ──
    get('/fulfilment/orders/kpis', V.whQuery, D.orderKpis, V_, async (req) =>
      ok(await orders(req).kpis(callerOf(req), wh(req))),
    );
    get('/fulfilment/orders', V.ordersQuery, D.orders, V_, async (req) =>
      pageBody(await orders(req).list(callerOf(req), filters(req), paging(req))),
    );
    get('/fulfilment/orders/filter-options', V.orderOptionsQuery, D.orderOptions, V_, async (req) =>
      ok(
        await orders(req).filterOptions(
          callerOf(req),
          q(req).field === 'pin' ? 'pin' : 'customer',
          str(q(req).q),
        ),
      ),
    );
    get('/fulfilment/orders/:orderId', V.orderParams, D.order, V_, async (req) =>
      ok(await orders(req).detail(callerOf(req), p(req).orderId ?? '')),
    );
    get('/fulfilment/orders/:orderId/customer', V.orderParams, D.customer, V_, async (req) =>
      ok(await orders(req).customer(callerOf(req), p(req).orderId ?? '')),
    );
    get('/fulfilment/orders/:orderId/items', V.orderParams, D.items, V_, async (req) =>
      ok(await orders(req).items(callerOf(req), p(req).orderId ?? '')),
    );
    get('/fulfilment/orders/:orderId/activity', V.orderCursor, D.activity, V_, async (req) => {
      const page = await orders(req).activity(
        callerOf(req),
        p(req).orderId ?? '',
        str(q(req).cursor),
        Number(q(req).limit),
      );
      return {
        success: true,
        data: page.items,
        meta: { nextCursor: page.nextCursor, limit: page.limit },
      };
    });
    get('/fulfilment/orders/:orderId/audit', V.orderCursor, D.audit, V_, async (req) => {
      const page = await orders(req).audit(
        callerOf(req),
        p(req).orderId ?? '',
        str(q(req).cursor),
        Number(q(req).limit),
      );
      return {
        success: true,
        data: page.items,
        meta: { nextCursor: page.nextCursor, limit: page.limit },
      };
    });
    get('/fulfilment/orders/:orderId/hold', V.orderParams, D.holdView, V_, async (req) =>
      ok(await orders(req).holdView(callerOf(req), p(req).orderId ?? '')),
    );
    post('/fulfilment/orders/:orderId/hold', V.holdSchema, D.hold, M, async (req) =>
      ok(await orders(req).hold(callerOf(req), p(req).orderId ?? '', b(req))),
    );
    post(
      '/fulfilment/orders/:orderId/hold',
      V.holdPatchSchema,
      D.holdPatch,
      M,
      async (req) => ok(await orders(req).patchHold(callerOf(req), p(req).orderId ?? '', b(req))),
      'patch',
    );
    post(
      '/fulfilment/orders/:orderId/release-hold',
      V.releaseHoldSchema,
      D.releaseHold,
      M,
      async (req) =>
        ok(
          await orders(req).releaseHold(
            callerOf(req),
            p(req).orderId ?? '',
            b<{ note?: string | null }>(req),
          ),
        ),
    );
    get(
      '/fulfilment/orders/:orderId/shelf-life-check',
      V.orderParams,
      D.shelfCheck,
      V_,
      async (req) => ok(await fefo(req).shelfLifeCheck(callerOf(req), p(req).orderId ?? '')),
    );

    // ── W3.04 allocation ──
    get(
      '/fulfilment/orders/:orderId/allocation-candidates',
      V.orderParams,
      D.candidates,
      V_,
      async (req) => ok(await orders(req).candidates(callerOf(req), p(req).orderId ?? '')),
    );
    get('/fulfilment/orders/:orderId/allocation-map', V.orderParams, D.map, V_, async (req) =>
      ok(await orders(req).map(callerOf(req), p(req).orderId ?? '')),
    );
    post(
      '/fulfilment/orders/:orderId/allocate',
      V.allocateSchema,
      D.allocate,
      'fulfilment.reallocate',
      async (req, reply) =>
        reply
          .code(201)
          .send(ok(await orders(req).allocate(callerOf(req), p(req).orderId ?? '', b(req)))),
    );
    get('/fulfilment/reallocations/:id', V.idParams, D.reallocation, V_, async (req) =>
      ok(await orders(req).reallocation(callerOf(req), p(req).id ?? '')),
    );

    // ── W3.05 FEFO ──
    get('/fulfilment/shipments/:id', V.idParams, D.shipment, V_, async (req) =>
      ok(await fefo(req).header(callerOf(req), p(req).id ?? '')),
    );
    get('/fulfilment/shipments/:id/lines', V.idParams, D.lines, V_, async (req) =>
      ok(await fefo(req).lines(callerOf(req), p(req).id ?? '')),
    );
    get('/fulfilment/shipments/:id/lines/:lineNo/lots', V.lineParams, D.lots, V_, async (req) =>
      ok(
        await fefo(req).lots(callerOf(req), p(req).id ?? '', Number(p(req).lineNo), {
          recommendedOnly: q(req).recommendedOnly === true,
          sort: (str(q(req).sort) ?? 'fefo') as 'fefo',
        }),
      ),
    );
    get('/fulfilment/shipments/:id/allocation-summary', V.idParams, D.summary, V_, async (req) =>
      ok(await fefo(req).allocationSummary(callerOf(req), p(req).id ?? '')),
    );
    get('/fulfilment/shipments/:id/allocations', V.idParams, D.allocations, V_, async (req) =>
      ok(await fefo(req).allocations(callerOf(req), p(req).id ?? '')),
    );
    post(
      '/fulfilment/shipments/:id/allocations',
      V.reserveSchema,
      D.reserve,
      M,
      async (req, reply) =>
        reply.code(201).send(ok(await fefo(req).reserve(callerOf(req), p(req).id ?? '', b(req)))),
    );
    post(
      '/fulfilment/shipments/:id/allocations/change-batch',
      V.changeBatchSchema,
      D.changeBatch,
      M,
      async (req) => ok(await fefo(req).changeBatch(callerOf(req), p(req).id ?? '', b(req))),
    );
    post(
      '/fulfilment/shipments/:id/allocations',
      V.releaseAllocSchema,
      D.release,
      M,
      async (req) =>
        ok(
          await fefo(req).release(callerOf(req), p(req).id ?? '', {
            ...(q(req).lineNo === undefined ? {} : { lineNo: Number(q(req).lineNo) }),
            ...(q(req).reason === undefined ? {} : { reason: String(q(req).reason) }),
          }),
        ),
      'delete',
    );

    // ── W3.06 tasks ──
    get('/fulfilment/operators', V.operatorsQuery, D.operators, V_, async (req) =>
      ok(await floor(req).operators(callerOf(req), String(q(req).warehouseId), filters(req))),
    );
    get('/fulfilment/task-templates/:type', V.templateParams, D.template, V_, async (req) =>
      ok(await floor(req).template(wh(req))),
    );
    post('/fulfilment/shipments/:id/tasks', V.assignSchema, D.assign, M, async (req, reply) =>
      reply.code(201).send(ok(await floor(req).assign(callerOf(req), p(req).id ?? '', b(req)))),
    );
    post('/fulfilment/tasks/batch', V.batchSchema, D.batch, M, async (req, reply) =>
      reply.code(201).send(ok(await floor(req).batch(callerOf(req), b(req)))),
    );
    post(
      '/fulfilment/tasks/:taskId',
      V.taskPatchSchema,
      D.taskPatch,
      M,
      async (req) => ok(await floor(req).patchTask(callerOf(req), p(req).taskId ?? '', b(req))),
      'patch',
    );
    post(
      '/fulfilment/tasks/:taskId/checklist/:key',
      V.checklistSchema,
      D.checklist,
      V_,
      async (req) =>
        ok(
          await floor(req).tickChecklist(
            callerOf(req),
            p(req).taskId ?? '',
            p(req).key ?? '',
            b<{ done: boolean }>(req).done,
          ),
        ),
      'put',
    );
    get('/fulfilment/tasks', V.tasksQuery, D.tasks, V_, async (req) => {
      const page = await floor(req).tasks(callerOf(req), {
        ...filters<Record<string, string>>(req),
        limit: Number(q(req).limit),
        ...(q(req).cursor === undefined ? {} : { cursor: String(q(req).cursor) }),
      });
      return {
        success: true,
        data: page.items,
        meta: { nextCursor: page.nextCursor, limit: page.limit },
      };
    });
    get('/fulfilment/tasks/:taskId', V.taskParams, D.task, V_, async (req) =>
      ok(await floor(req).task(callerOf(req), p(req).taskId ?? '')),
    );

    // ── W3.07 processing ──
    get('/fulfilment/processing/counts', V.processingDayQuery, D.procCounts, V_, async (req) =>
      ok(await qs(req).processingCounts(callerOf(req), wh(req), str(q(req).date))),
    );
    get('/fulfilment/processing', V.processingQuery, D.processing, V_, async (req) =>
      pageBody(await qs(req).processing(callerOf(req), filters(req), paging(req))),
    );
    get('/fulfilment/processing/kpis', V.processingDayQuery, D.procKpis, V_, async (req) =>
      ok(await qs(req).processingKpis(callerOf(req), wh(req), str(q(req).date), fresh(req))),
    );
    post('/fulfilment/shipments/:id/pick', V.pickSchema, D.pick, 'inventory.pick', async (req) =>
      ok(await floor(req).pick(callerOf(req), p(req).id ?? '', b(req))),
    );
    post(
      '/fulfilment/shipments/:id/pick/complete',
      V.emptyBody,
      D.pickComplete,
      'inventory.pick',
      async (req) => ok(await floor(req).pickComplete(callerOf(req), p(req).id ?? '')),
    );
    post('/fulfilment/shipments/:id/pack', V.packSchema, D.pack, M, async (req) =>
      ok(await floor(req).pack(callerOf(req), p(req).id ?? '', b(req))),
    );
    post('/fulfilment/shipments/:id/qc', V.qcSchema, D.qc, M, async (req) =>
      ok(await floor(req).qc(callerOf(req), p(req).id ?? '', b(req))),
    );
    post('/fulfilment/shipments/:id/stage', V.stageSchema, D.stage, M, async (req) =>
      ok(await floor(req).stage(callerOf(req), p(req).id ?? '', b(req))),
    );
    post('/fulfilment/processing/bulk', V.processingBulkSchema, D.bulk, M, async (req) =>
      ok(await floor(req).bulk(callerOf(req), b(req))),
    );

    // ── W3.11 exceptions ──
    get('/fulfilment/exceptions/kpis', V.exceptionKpisQuery, D.exKpis, V_, async (req) =>
      ok(await ex(req).kpis(callerOf(req), wh(req), str(q(req).from), str(q(req).to))),
    );
    get('/fulfilment/exceptions', V.exceptionsQuery, D.exceptions, V_, async (req) =>
      pageBody(await ex(req).list(callerOf(req), filters(req), paging(req))),
    );
    app.get(
      '/fulfilment/exceptions/export.csv',
      {
        schema: { ...V.exceptionsQuery, ...routeDocs(D.exCsv) },
        preHandler: [...r(V_), rateLimit('export', 5, 60)],
      },
      async (req, reply) => csv(reply, 'exceptions', ex(req).csv(callerOf(req), filters(req))),
    );
    get('/fulfilment/exceptions/:id', V.idParams, D.exception, V_, async (req) =>
      ok(await ex(req).get(callerOf(req), p(req).id ?? '')),
    );
    post(
      '/fulfilment/exceptions',
      V.exceptionCreateSchema,
      D.exCreate,
      'inventory.exception_raise',
      async (req, reply) => reply.code(201).send(ok(await ex(req).create(callerOf(req), b(req)))),
    );
    post('/fulfilment/exceptions/bulk', V.exceptionBulkSchema, D.exBulk, M, async (req) =>
      ok(await ex(req).bulk(callerOf(req), b(req))),
    );
    post(
      '/fulfilment/exceptions/:id',
      V.exceptionPatchSchema,
      D.exPatch,
      M,
      async (req) => ok(await ex(req).patch(callerOf(req), p(req).id ?? '', b(req))),
      'patch',
    );
    post('/fulfilment/exceptions/:id/resolve', V.resolveSchema, D.resolve, M, async (req) =>
      ok(await ex(req).resolve(callerOf(req), p(req).id ?? '', b(req))),
    );
    get('/settings/sop', {}, D.sop, V_, async (req) =>
      ok(await req.diScope.resolve('fulfilmentSettings').get('fulfilment.sop')),
    );
    get('/fulfilment/shelf-life-rules', {}, D.shelfRules, V_, async (req) =>
      ok(await fefo(req).shelfLifeRules()),
    );

    // ── W4.05 reserved stock ──
    get('/stock/reservations/kpis', V.whQuery, D.reservedKpis, 'inventory.view', async (req) =>
      ok(await qs(req).reservedKpis(callerOf(req), wh(req), fresh(req))),
    );
    get(
      '/stock/reservations',
      V.reservationsQuery,
      D.reservations,
      'inventory.view',
      async (req) => {
        const page = await qs(req).reservations(
          callerOf(req),
          {
            ...filters<Record<string, string>>(req),
            tab: (str(q(req).tab) ?? 'active') as 'active',
          },
          paging(req),
        );
        const body = pageBody(page);
        return { ...body, meta: { ...body.meta, notAllocated: page.notAllocated } };
      },
    );
    get(
      '/stock/reservations/:allocationId',
      V.allocationParams,
      D.reservation,
      'inventory.view',
      async (req) => ok(await qs(req).reservation(callerOf(req), p(req).allocationId ?? '')),
    );

    if (aud === 'admin') {
      post(
        '/settings/sop',
        V.sopSchema,
        D.sopPut,
        M,
        async (req) =>
          ok(await qs(req).putSettings(callerOf(req), 'GLOBAL', { 'fulfilment.sop': b(req) })),
        'put',
      );
      get('/fulfilment/settings', V.settingsQuery, D.settings, 'warehouse.configure', async (req) =>
        ok(await qs(req).settings(String(q(req).scope))),
      );
      post(
        '/fulfilment/settings',
        V.settingsSchema,
        D.settingsPut,
        'warehouse.configure',
        async (req) => ok(await qs(req).putSettings(callerOf(req), String(q(req).scope), b(req))),
        'put',
      );
      post(
        '/fulfilment/shelf-life-rules',
        V.shelfCreateSchema,
        D.shelfCreate,
        M,
        async (req, reply) =>
          reply.code(201).send(ok(await fefo(req).createShelfLifeRule(callerOf(req), b(req)))),
      );
      post(
        '/fulfilment/shelf-life-rules/:id',
        V.shelfPatchSchema,
        D.shelfPatch,
        M,
        async (req) =>
          ok(await fefo(req).updateShelfLifeRule(callerOf(req), p(req).id ?? '', b(req))),
        'patch',
      );
      post(
        '/fulfilment/shelf-life-rules/:id',
        V.idParams,
        D.shelfDelete,
        M,
        async (req, reply) => {
          await fefo(req).deleteShelfLifeRule(callerOf(req), p(req).id ?? '');
          return reply.code(204).send();
        },
        'delete',
      );
      get('/ops/reconcile/allocation', {}, D.reconcile, 'warehouse.configure', async (req) =>
        ok(await req.diScope.resolve('fulfilmentJobs').report()),
      );
    }
  };
