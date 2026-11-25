import { Readable } from 'node:stream';

import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import {
  type Audience,
  audRead,
  audWrite,
  callerOf,
  rateLimit,
  requireCustomer,
} from '../../middleware/guards.js';
import { type Paging, pageBody } from '../../middleware/paging.js';
import { deliveryDocs, publicDocs } from './fulfilment.delivery.docs.js';
import * as V from './fulfilment.validation.js';

type Q = Record<string, string | number | boolean | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const p = (req: FastifyRequest) => req.params as Record<string, string>;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of the validated body
const b = <T>(req: FastifyRequest) => req.body as T;
const svc = (req: FastifyRequest) => req.diScope.resolve('fulfilmentDelivery');
const id = (req: FastifyRequest) => p(req).id ?? '';
const paging = (req: FastifyRequest): Paging => ({
  limit: Number(q(req).limit ?? 20),
  ...(q(req).cursor === undefined ? {} : { cursor: String(q(req).cursor) }),
  ...(q(req).page === undefined ? {} : { page: Number(q(req).page) }),
});
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed filter view of the validated query
const filters = <T>(req: FastifyRequest): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q(req)))
    if (v !== undefined && !['cursor', 'page', 'limit'].includes(k)) out[k] = v;
  return out as T;
};
const str = (v: string | number | boolean | undefined) => (v === undefined ? undefined : String(v));

/** D-57b Phase 4b delivery & settlement (W3.09 / W3.10), exports, 3PL links — both audiences. */
export const deliveryRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = deliveryDocs(aud);
    type Docs = Parameters<typeof routeDocs>[0];
    type H = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    const get = (path: string, schema: object, docs: Docs, h: H) =>
      app.get(
        path,
        { schema: { ...schema, ...routeDocs(docs) }, preHandler: audRead(aud, 'fulfilment.view') },
        h,
      );
    const post = (
      path: string,
      schema: object,
      docs: Docs,
      key: string,
      h: H,
      method: 'post' | 'delete' = 'post',
    ) =>
      app[method](
        path,
        { schema: { ...schema, ...routeDocs(docs) }, preHandler: audWrite(aud, key) },
        h,
      );
    const staff = (req: FastifyRequest) => ({ kind: 'staff' as const, caller: callerOf(req) });

    post(
      '/fulfilment/shipments/:id/out-for-delivery',
      V.idParams,
      D.out,
      'logistics.dispatch_assign',
      async (req) => ok(await svc(req).outForDelivery(staff(req), id(req))),
    );
    post(
      '/fulfilment/shipments/:id/deliver',
      V.deliverSchema,
      D.deliver,
      'logistics.delivery_confirm',
      async (req) => ok(await svc(req).deliver(staff(req), id(req), b(req))),
    );
    post(
      '/fulfilment/shipments/:id/deliver-override',
      V.overrideSchema,
      D.override,
      'logistics.delivery_override',
      async (req) => ok(await svc(req).deliverOverride(callerOf(req), id(req), b(req))),
    );
    post(
      '/fulfilment/shipments/:id/delivery-failed',
      V.failedSchema,
      D.failed,
      'logistics.delivery_confirm',
      async (req) => ok(await svc(req).failed(staff(req), id(req), b(req))),
    );
    post(
      '/fulfilment/shipments/:id/otp/resend',
      V.idParams,
      D.resend,
      'logistics.dispatch_assign',
      async (req) => ok(await svc(req).resendOtp(callerOf(req), id(req))),
    );
    post(
      '/fulfilment/shipments/:id/return-to-warehouse',
      V.returnSchema,
      D.returned,
      'inventory.receive',
      async (req) => ok(await svc(req).returnToWarehouse(callerOf(req), id(req), b(req))),
    );
    post(
      '/fulfilment/shipments/:id/fulfil',
      V.idParams,
      D.fulfil,
      'fulfilment.manage',
      async (req) => ok(await svc(req).fulfil(callerOf(req), id(req))),
    );
    post(
      '/fulfilment/shipments/:id/settle',
      V.settleSchema,
      D.settle,
      'fulfilment.manage',
      async (req) => ok(await svc(req).settle(callerOf(req), id(req), b(req))),
    );
    get('/fulfilment/shipments/:id/pod', V.idParams, D.pod, async (req) =>
      ok(await svc(req).pod(callerOf(req), id(req))),
    );
    get('/fulfilment/delivered/kpis', V.deliveredKpisQuery, D.deliveredKpis, async (req) =>
      ok(
        await svc(req).deliveredKpis(
          callerOf(req),
          str(q(req).warehouseId),
          str(q(req).from),
          str(q(req).to),
        ),
      ),
    );
    get('/fulfilment/delivered', V.deliveredQuery, D.delivered, async (req) =>
      pageBody(await svc(req).delivered(callerOf(req), filters(req), paging(req))),
    );
    get('/fulfilment/fulfilled/kpis', V.fulfilledKpisQuery, D.fulfilledKpis, async (req) =>
      ok(await svc(req).fulfilledKpis(callerOf(req), str(q(req).warehouseId), str(q(req).month))),
    );
    get('/fulfilment/fulfilled', V.fulfilledQuery, D.fulfilled, async (req) =>
      pageBody(await svc(req).fulfilled(callerOf(req), filters(req), paging(req))),
    );
    post('/exports', V.exportCreateSchema, D.exportCreate, 'fulfilment.view', async (req, reply) =>
      reply.code(201).send(ok(await svc(req).createExport(callerOf(req), b(req)))),
    );
    get('/exports', V.exportsQuery, D.exports, async (req) => {
      const page = await svc(req).exports(callerOf(req), str(q(req).cursor), Number(q(req).limit));
      return {
        success: true,
        data: page.items,
        meta: { nextCursor: page.nextCursor, limit: page.limit },
      };
    });
    get('/exports/:id', V.idParams, D.exportGet, async (req) =>
      ok(await svc(req).export(callerOf(req), id(req))),
    );
    app.get(
      '/exports/:id/download',
      {
        schema: { ...V.idParams, ...routeDocs(D.exportDownload) },
        preHandler: [...audRead(aud, 'fulfilment.view'), rateLimit('export', 5, 60)],
      },
      async (req, reply) => {
        const e = await svc(req).export(callerOf(req), id(req));
        if (!e.downloadable)
          return reply.code(409).send({
            success: false,
            error: {
              code: 'CONFLICT',
              message: 'The export is not ready',
              details: { reason: 'NOT_READY' },
              requestId: req.id,
            },
          });
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="${e.type.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          .send(Readable.from(svc(req).download(callerOf(req), id(req))));
      },
    );
    app.get(
      '/fulfilment/shipments/:id/invoice.pdf',
      {
        schema: { ...V.idParams, ...routeDocs(D.invoicePdf) },
        preHandler: [...audRead(aud, 'fulfilment.view'), rateLimit('invoice-print', 30, 60)],
      },
      async (req, reply) => {
        const pdf = await svc(req).invoicePdf(callerOf(req), id(req));
        return reply
          .header('content-type', 'application/pdf')
          .header('content-disposition', `attachment; filename="${pdf.fileName}"`)
          .header('cache-control', 'private, no-store')
          .send(pdf.file);
      },
    );
    post(
      '/dispatch/trips/:id/driver-link',
      V.driverLinkSchema,
      D.linkCreate,
      'logistics.dispatch_assign',
      async (req, reply) =>
        reply
          .code(201)
          .send(
            ok(
              await req.diScope
                .resolve('dispatchService')
                .createLink(callerOf(req), id(req), b(req)),
            ),
          ),
    );
    post(
      '/dispatch/trips/:id/driver-link',
      V.idParams,
      D.linkRevoke,
      'logistics.dispatch_assign',
      async (req) =>
        ok(await req.diScope.resolve('dispatchService').revokeLink(callerOf(req), id(req))),
      'delete',
    );
  };

/** Public 3PL driver trip link (`/v1/driver/*`, §2a.8): the token is the credential. */
export const driverRoutes: FastifyPluginAsync = async (app) => {
  const disp = (req: FastifyRequest) => req.diScope.resolve('dispatchService');
  const token = (req: FastifyRequest) => p(req).token ?? '';
  const limit = [rateLimit('driver', 120, 60)];
  app.get(
    '/trips/:token',
    { schema: { ...V.driverTokenParams, ...routeDocs(publicDocs.driverTrip) }, preHandler: limit },
    async (req) => ok(await disp(req).driverTrip(token(req))),
  );
  app.post(
    '/trips/:token/pings',
    { schema: { ...V.driverPingSchema, ...routeDocs(publicDocs.driverPing) }, preHandler: limit },
    async (req) => ok(await disp(req).driverPing(token(req), b(req))),
  );
  app.post(
    '/trips/:token/shipments/:id/out-for-delivery',
    {
      schema: { ...V.driverShipmentParams, ...routeDocs(publicDocs.driverOut) },
      preHandler: limit,
    },
    async (req) => {
      const t = await disp(req).driverShipment(token(req), id(req));
      return ok(await svc(req).outForDelivery({ kind: 'driver', tripId: t.id }, id(req)));
    },
  );
  app.post(
    '/trips/:token/shipments/:id/deliver',
    {
      schema: { ...V.driverDeliverSchema, ...routeDocs(publicDocs.driverDeliver) },
      preHandler: [rateLimit('driver-otp', 20, 60)],
    },
    async (req) => {
      const t = await disp(req).driverShipment(token(req), id(req));
      return ok(await svc(req).deliver({ kind: 'driver', tripId: t.id }, id(req), b(req)));
    },
  );
  app.post(
    '/trips/:token/shipments/:id/delivery-failed',
    {
      schema: { ...V.driverFailedSchema, ...routeDocs(publicDocs.driverFailed) },
      preHandler: limit,
    },
    async (req) => {
      const t = await disp(req).driverShipment(token(req), id(req));
      return ok(await svc(req).failed({ kind: 'driver', tripId: t.id }, id(req), b(req)));
    },
  );
};

/** Customer app (`/v1/shipments`): own shipments, OTP while out for delivery. */
export const customerShipmentRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    {
      schema: { ...V.customerShipmentsQuery, ...routeDocs(publicDocs.customer) },
      preHandler: [requireCustomer],
    },
    async (req) => ok(await svc(req).customerShipments(req.user?.id ?? '', str(q(req).orderId))),
  );
};
