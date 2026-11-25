import { Readable } from 'node:stream';

import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { type Audience, audRead, audWrite, callerOf, rateLimit } from '../../middleware/guards.js';
import { type Paging, pageBody } from '../../middleware/paging.js';
import { dispatchDocs } from './dispatch.docs.js';
import * as V from './dispatch.validation.js';

type Q = Record<string, string | number | boolean | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const p = (req: FastifyRequest) => req.params as Record<string, string>;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of the validated body
const b = <T>(req: FastifyRequest) => req.body as T;
const svc = (req: FastifyRequest) => req.diScope.resolve('dispatchService');
const id = (req: FastifyRequest) => p(req).id ?? '';
const sid = (req: FastifyRequest) => p(req).shipmentId ?? '';
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

/** D-57b Phase 4a dispatch (W3.08, W3.19 + fleet, routes, trips). Both audiences, same handlers. */
export const dispatchRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = dispatchDocs(aud);
    type Docs = Parameters<typeof routeDocs>[0];
    type H = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    const get = (path: string, schema: object, docs: Docs, h: H) =>
      app.get(
        path,
        { schema: { ...schema, ...routeDocs(docs) }, preHandler: audRead(aud, 'fulfilment.view') },
        h,
      );
    const write = (
      method: 'post' | 'patch' | 'delete',
      path: string,
      schema: object,
      docs: Docs,
      key: string,
      h: H,
      extra: unknown[] = [],
    ) =>
      app[method](
        path,
        {
          schema: { ...schema, ...routeDocs(docs) },
          preHandler: [...audWrite(aud, key), ...(extra as never[])],
        },
        h,
      );
    const FLEET = 'logistics.fleet_manage';
    const ASSIGN = 'logistics.dispatch_assign';

    // routes, carriers, vehicles, drivers
    get('/dispatch/routes', V.routesQuery, D.routes, async (req) =>
      ok(await svc(req).routes(callerOf(req), filters(req))),
    );
    write('post', '/dispatch/routes', V.routeCreate, D.routeCreate, FLEET, async (req, reply) =>
      reply.code(201).send(ok(await svc(req).createRoute(callerOf(req), b(req)))),
    );
    write('patch', '/dispatch/routes/:id', V.routePatch, D.routePatch, FLEET, async (req) =>
      ok(await svc(req).updateRoute(callerOf(req), id(req), b(req))),
    );
    get('/dispatch/carriers', V.carriersQuery, D.carriers, async (req) =>
      ok(await svc(req).carriers(filters(req))),
    );
    write(
      'post',
      '/dispatch/carriers',
      V.carrierCreate,
      D.carrierCreate,
      FLEET,
      async (req, reply) =>
        reply.code(201).send(ok(await svc(req).createCarrier(callerOf(req), b(req)))),
    );
    write('patch', '/dispatch/carriers/:id', V.carrierPatch, D.carrierPatch, FLEET, async (req) =>
      ok(await svc(req).updateCarrier(callerOf(req), id(req), b(req))),
    );
    get('/dispatch/vehicles', V.vehiclesQuery, D.vehicles, async (req) =>
      ok(await svc(req).vehicles(callerOf(req), filters(req))),
    );
    write(
      'post',
      '/dispatch/vehicles',
      V.vehicleCreate,
      D.vehicleCreate,
      FLEET,
      async (req, reply) =>
        reply.code(201).send(ok(await svc(req).createVehicle(callerOf(req), b(req)))),
    );
    write('patch', '/dispatch/vehicles/:id', V.vehiclePatch, D.vehiclePatch, FLEET, async (req) =>
      ok(await svc(req).updateVehicle(callerOf(req), id(req), b(req))),
    );
    get('/dispatch/drivers', V.driversQuery, D.drivers, async (req) =>
      ok(await svc(req).drivers(callerOf(req), filters(req))),
    );
    write('post', '/dispatch/drivers', V.driverCreate, D.driverCreate, FLEET, async (req, reply) =>
      reply.code(201).send(ok(await svc(req).createDriver(callerOf(req), b(req)))),
    );
    write('patch', '/dispatch/drivers/:id', V.driverPatch, D.driverPatch, FLEET, async (req) =>
      ok(await svc(req).updateDriver(callerOf(req), id(req), b(req))),
    );

    // trips
    write('post', '/dispatch/trips', V.tripCreate, D.tripCreate, ASSIGN, async (req, reply) =>
      reply.code(201).send(ok(await svc(req).createTrip(callerOf(req), b(req)))),
    );
    get('/dispatch/trips', V.tripsQuery, D.trips, async (req) =>
      pageBody(await svc(req).trips(callerOf(req), filters(req), paging(req))),
    );
    get('/dispatch/weighbridge/recent', V.weighRecentQuery, D.weighRecent, async (req) =>
      ok(
        await svc(req).recentWeighings(
          callerOf(req),
          q(req).warehouseId as string | undefined,
          Number(q(req).limit),
        ),
      ),
    );
    get('/dispatch/trips/:id', V.idParams, D.trip, async (req) =>
      ok(await svc(req).trip(callerOf(req), id(req))),
    );
    write(
      'post',
      '/dispatch/trips/:id/shipments',
      V.tripShipments,
      D.tripShipments,
      ASSIGN,
      async (req) =>
        ok(
          await svc(req).addShipments(
            callerOf(req),
            id(req),
            b<{ shipmentIds: string[] }>(req).shipmentIds,
          ),
        ),
    );
    write(
      'delete',
      '/dispatch/trips/:id/shipments/:shipmentId',
      V.tripShipmentParams,
      D.tripShipmentRemove,
      ASSIGN,
      async (req) => ok(await svc(req).removeShipment(callerOf(req), id(req), sid(req))),
    );
    write('post', '/dispatch/trips/:id/loading', V.loadingSchema, D.loading, ASSIGN, async (req) =>
      ok(await svc(req).loading(callerOf(req), id(req), b(req))),
    );
    write('post', '/dispatch/trips/:id/weighbridge', V.weighSchema, D.weigh, ASSIGN, async (req) =>
      ok(await svc(req).weighbridge(callerOf(req), id(req), b(req))),
    );
    get('/dispatch/trips/:id/weighbridge', V.idParams, D.weighView, async (req) =>
      ok(await svc(req).weighbridgeView(callerOf(req), id(req))),
    );
    write('post', '/dispatch/trips/:id/depart', V.departSchema, D.depart, ASSIGN, async (req) =>
      ok(await svc(req).depart(callerOf(req), id(req), b(req))),
    );
    write('post', '/dispatch/trips/:id/complete', V.idParams, D.complete, ASSIGN, async (req) =>
      ok(await svc(req).complete(callerOf(req), id(req))),
    );
    write('post', '/dispatch/trips/:id/cancel', V.cancelSchema, D.cancel, ASSIGN, async (req) =>
      ok(await svc(req).cancel(callerOf(req), id(req), b<{ reason: string }>(req).reason)),
    );
    write(
      'post',
      '/dispatch/trips/:id/reassign',
      V.reassignSchema,
      D.reassign,
      ASSIGN,
      async (req) => ok(await svc(req).reassign(callerOf(req), id(req), b(req))),
    );
    write(
      'post',
      '/dispatch/trips/:id/pings',
      V.pingSchema,
      D.ping,
      'logistics.consignment_view',
      async (req) => ok(await svc(req).ping(callerOf(req), id(req), b(req))),
      [rateLimit('ping', 60, 60)],
    );
    get('/dispatch/trips/:id/route', V.idParams, D.route, async (req) =>
      ok(await svc(req).route(callerOf(req), id(req))),
    );
    get('/dispatch/trips/:id/tracking', V.idParams, D.tracking, async (req) =>
      ok(await svc(req).tracking(callerOf(req), id(req))),
    );

    // W3.08 dispatched
    get('/fulfilment/dispatched', V.dispatchedQuery, D.dispatched, async (req) =>
      pageBody(await svc(req).dispatched(callerOf(req), filters(req), paging(req))),
    );
    get(
      '/fulfilment/shipments/:shipmentId/dispatch-summary',
      V.shipmentParams,
      D.summary,
      async (req) => ok(await svc(req).shipmentSummary(callerOf(req), sid(req))),
    );
    get('/fulfilment/shipments/:shipmentId/vehicle', V.shipmentParams, D.vehicle, async (req) =>
      ok(await svc(req).shipmentVehicle(callerOf(req), sid(req))),
    );
    get(
      '/fulfilment/shipments/:shipmentId/tracking',
      V.shipmentParams,
      D.shipTracking,
      async (req) => ok(await svc(req).shipmentTracking(callerOf(req), sid(req))),
    );
    get('/fulfilment/shipments/:shipmentId/dispatch-info', V.shipmentParams, D.info, async (req) =>
      ok(await svc(req).shipmentDispatchInfo(callerOf(req), sid(req))),
    );

    // W3.19 bulk
    get('/bulk/kpis', V.bulkKpisQuery, D.bulkKpis, async (req) =>
      ok(await svc(req).bulkKpis(callerOf(req), q(req).warehouseId as string | undefined)),
    );
    get('/bulk/orders', V.bulkOrdersQuery, D.bulkOrders, async (req) =>
      pageBody(await svc(req).bulkOrders(callerOf(req), filters(req), paging(req))),
    );
    get('/bulk/bays', V.whRequired, D.bays, async (req) =>
      ok(await svc(req).bays(callerOf(req), String(q(req).warehouseId))),
    );
    get('/bulk/corridors', V.whRequired, D.corridors, async (req) =>
      ok(await svc(req).corridors(callerOf(req), String(q(req).warehouseId))),
    );
    app.get(
      '/bulk/orders/export.csv',
      {
        schema: { ...V.bulkOrdersQuery, ...routeDocs(D.bulkCsv) },
        preHandler: [...audRead(aud, 'fulfilment.view'), rateLimit('export', 5, 60)],
      },
      async (req, reply) =>
        reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="bulk-manifest-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          .send(Readable.from(svc(req).bulkCsv(callerOf(req), filters(req)))),
    );
  };
