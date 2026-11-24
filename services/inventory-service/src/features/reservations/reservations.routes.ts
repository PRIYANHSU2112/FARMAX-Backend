import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, adminWrite, internalGuard } from '../../middleware/guards.js';
import { idempotencyKeyOf } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import { RESERVATION_DOCS } from './reservations.docs.js';
import type {
  AvailabilityCheckInput,
  ReleaseInput,
  ReservationListQuery,
  ReserveInput,
} from './reservations.types.js';
import {
  availabilitySchema,
  byOrderRefSchema,
  getReservationSchema,
  listReservationsSchema,
  openLinesSchema,
  reallocateSchema,
  releaseSchema,
  reserveSchema,
} from './reservations.validation.js';

interface IdParams {
  id: string;
}

const svc = (req: FastifyRequest) => req.diScope.resolve('reservationsService');

/** Mounted at `/admin/inventory/reservations` (gateway: `/v1/admin/inventory/reservations`). */
export const reservationsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: ReservationListQuery }>(
    '/',
    {
      schema: { ...listReservationsSchema, ...routeDocs(RESERVATION_DOCS.list) },
      preHandler: admin('inventory.view'),
    },
    async (req) => paginated(await svc(req).list(req.query)),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    {
      schema: { ...getReservationSchema, ...routeDocs(RESERVATION_DOCS.get) },
      preHandler: admin('inventory.view'),
    },
    async (req) => ok(await svc(req).get(req.params.id)),
  );
  app.post<{ Params: IdParams; Body: ReleaseInput }>(
    '/:id/release',
    {
      schema: { ...releaseSchema, ...routeDocs(RESERVATION_DOCS.release) },
      preHandler: adminWrite('inventory.adjust'),
    },
    async (req) => ok(await svc(req).adminRelease(actorOf(req), req.params.id, req.body.reason)),
  );
};

/**
 * Mounted at `/internal/inventory` (service token; never routed by the gateway, not in Swagger).
 * Used by order-service checkout (docs/oms/05-api.md). Off when INTERNAL_SERVICE_TOKEN is unset.
 */
export const reservationsInternalRoutes: FastifyPluginAsync = async (app) => {
  const guard = internalGuard(app);
  if (guard === null) return;

  app.post<{ Body: ReserveInput }>(
    '/reservations',
    { schema: { hide: true, ...reserveSchema }, onRequest: [guard] },
    async (req, reply) => {
      const result = await svc(req).reserve(idempotencyKeyOf(req), req.body);
      return reply
        .code(result.replayed ? 200 : 201)
        .send(ok({ ...result.reservation, split: result.split }));
    },
  );
  app.get<{ Querystring: { orderRef: string } }>(
    '/reservations',
    { schema: { hide: true, ...byOrderRefSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).byOrderRef(req.query.orderRef)),
  );
  app.get<{ Params: IdParams }>(
    '/reservations/:id',
    { schema: { hide: true, ...getReservationSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).get(req.params.id)),
  );
  app.post<{ Body: AvailabilityCheckInput }>(
    '/availability',
    { schema: { hide: true, ...availabilitySchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).checkAvailability(req.body)),
  );
  // D-57b (warehouse-service): reallocate lines between warehouses; open lines for reconcile.
  app.post<{
    Params: IdParams;
    Body: {
      key: string;
      moves: { variantId: string; fromWarehouseId: string; toWarehouseId: string; qty: number }[];
    };
  }>(
    '/reservations/:id/reallocate',
    { schema: { hide: true, ...reallocateSchema }, onRequest: [guard] },
    async (req) => ok(await svc(req).reallocate(req.params.id, req.body.key, req.body.moves)),
  );
  app.get<{ Querystring: { warehouseId: string; cursor?: string; limit: number } }>(
    '/reservations-open-lines',
    { schema: { hide: true, ...openLinesSchema }, onRequest: [guard] },
    async (req) => {
      const page = await svc(req).openLines(
        req.query.warehouseId,
        req.query.cursor,
        req.query.limit,
      );
      return {
        success: true,
        data: page.items,
        meta: { nextCursor: page.nextCursor, limit: req.query.limit },
      };
    },
  );
};
