import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { callerOf, staffRead, staffWrite } from '../../middleware/guards.js';
import { STATES, STATUS_LABELS, TEMP_CLASS_INFO, TYPE_LABELS } from '../warehouses/index.js';
import { SERVICE_AREA_DOCS } from './service-areas.docs.js';
import {
  AREA_PRIORITIES,
  type CreateAreaInput,
  type ReassignInput,
  type UpdateAreaInput,
} from './service-areas.types.js';
import {
  coverageSchema,
  createAreaSchema,
  deleteAreaSchema,
  deleteAreasSchema,
  districtsSchema,
  getAreaSchema,
  listAreasSchema,
  reassignSchema,
  updateAreaSchema,
} from './service-areas.validation.js';

interface WarehouseParams {
  id: string;
}
interface AreaParams extends WarehouseParams {
  areaId: string;
}

const svc = (req: FastifyRequest) => req.diScope.resolve('serviceAreasService');

/** Static: built once. */
const LOOKUPS = {
  states: STATES,
  temperatureClasses: TEMP_CLASS_INFO,
  types: Object.entries(TYPE_LABELS).map(([code, label]) => ({ code, label })),
  statuses: Object.entries(STATUS_LABELS).map(([code, label]) => ({ code, label })),
  areaPriorities: AREA_PRIORITIES.map((code) => ({
    code,
    label: code.charAt(0) + code.slice(1).toLowerCase(),
  })),
};

/** Mounted at `/admin/warehouses` next to the warehouses feature (gateway `/v1/admin/warehouses`). */
export const serviceAreasRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/lookups',
    { schema: routeDocs(SERVICE_AREA_DOCS.lookups), preHandler: staffRead('warehouse.view') },
    () => ok(LOOKUPS),
  );
  app.get<{ Querystring: { stateCode: string } }>(
    '/lookups/districts',
    {
      schema: { ...districtsSchema, ...routeDocs(SERVICE_AREA_DOCS.districts) },
      preHandler: staffRead('warehouse.view'),
    },
    async (req) => ok(await svc(req).districts(req.query.stateCode)),
  );
  app.get<{ Params: { pinCode: string } }>(
    '/coverage/:pinCode',
    {
      schema: { ...coverageSchema, ...routeDocs(SERVICE_AREA_DOCS.coverage) },
      preHandler: staffRead('warehouse.view'),
    },
    async (req) => ok(await svc(req).coverage(callerOf(req), req.params.pinCode)),
  );
  app.get<{ Params: WarehouseParams }>(
    '/:id/service-areas',
    {
      schema: { ...listAreasSchema, ...routeDocs(SERVICE_AREA_DOCS.list) },
      preHandler: staffRead('warehouse.view'),
    },
    async (req) => ok(await svc(req).list(callerOf(req), req.params.id)),
  );
  app.get<{ Params: AreaParams }>(
    '/:id/service-areas/:areaId',
    {
      schema: { ...getAreaSchema, ...routeDocs(SERVICE_AREA_DOCS.get) },
      preHandler: staffRead('warehouse.view'),
    },
    async (req) => ok(await svc(req).get(callerOf(req), req.params.id, req.params.areaId)),
  );
  app.post<{ Params: WarehouseParams; Body: CreateAreaInput }>(
    '/:id/service-areas',
    {
      schema: { ...createAreaSchema, ...routeDocs(SERVICE_AREA_DOCS.create) },
      preHandler: staffWrite('warehouse.configure'),
    },
    async (req, reply) =>
      reply.code(201).send(ok(await svc(req).create(callerOf(req), req.params.id, req.body))),
  );
  app.patch<{ Params: AreaParams; Body: UpdateAreaInput }>(
    '/:id/service-areas/:areaId',
    {
      schema: { ...updateAreaSchema, ...routeDocs(SERVICE_AREA_DOCS.update) },
      preHandler: staffWrite('warehouse.configure'),
    },
    async (req) =>
      ok(await svc(req).update(callerOf(req), req.params.id, req.params.areaId, req.body)),
  );
  app.delete<{ Params: AreaParams; Querystring: { expectedVersion: number } }>(
    '/:id/service-areas/:areaId',
    {
      schema: { ...deleteAreaSchema, ...routeDocs(SERVICE_AREA_DOCS.remove) },
      preHandler: staffWrite('warehouse.configure'),
    },
    async (req) =>
      ok(
        await svc(req).remove(
          callerOf(req),
          req.params.id,
          [req.params.areaId],
          req.query.expectedVersion,
        ),
      ),
  );
  app.delete<{ Params: WarehouseParams; Querystring: { expectedVersion: number; ids: string } }>(
    '/:id/service-areas',
    {
      schema: { ...deleteAreasSchema, ...routeDocs(SERVICE_AREA_DOCS.removeMany) },
      preHandler: staffWrite('warehouse.configure'),
    },
    async (req) =>
      ok(
        await svc(req).remove(
          callerOf(req),
          req.params.id,
          [...new Set(req.query.ids.toLowerCase().split(','))],
          req.query.expectedVersion,
        ),
      ),
  );
  app.post<{ Params: AreaParams; Body: ReassignInput }>(
    '/:id/service-areas/:areaId/reassign',
    {
      schema: { ...reassignSchema, ...routeDocs(SERVICE_AREA_DOCS.reassign) },
      preHandler: staffWrite('warehouse.configure'),
    },
    async (req) =>
      ok(await svc(req).reassign(callerOf(req), req.params.id, req.params.areaId, req.body)),
  );
};
