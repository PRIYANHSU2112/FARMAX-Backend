import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, adminWrite } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import { WAREHOUSE_DOCS } from './warehouses.docs.js';
import type {
  CreateWarehouseInput,
  PutCoverageInput,
  UpdateWarehouseInput,
  WarehouseListQuery,
  WarehouseStatusInput,
} from './warehouses.types.js';
import {
  createWarehouseSchema,
  getWarehouseSchema,
  listWarehousesSchema,
  putCoverageSchema,
  updateWarehouseSchema,
  warehouseStatusSchema,
} from './warehouses.validation.js';

interface IdParams {
  id: string;
}

const svc = (req: FastifyRequest) => req.diScope.resolve('warehousesService');

/** Mounted at `/admin/inventory/warehouses` (gateway: `/v1/admin/inventory/warehouses`). */
export const warehousesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: WarehouseListQuery }>(
    '/',
    {
      schema: { ...listWarehousesSchema, ...routeDocs(WAREHOUSE_DOCS.list) },
      preHandler: admin('inventory.view'),
    },
    async (req) => paginated(await svc(req).list(req.query)),
  );
  app.post<{ Body: CreateWarehouseInput }>(
    '/',
    {
      schema: { ...createWarehouseSchema, ...routeDocs(WAREHOUSE_DOCS.create) },
      preHandler: adminWrite('inventory.configure'),
    },
    async (req, reply) => reply.code(201).send(ok(await svc(req).create(actorOf(req), req.body))),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    {
      schema: { ...getWarehouseSchema, ...routeDocs(WAREHOUSE_DOCS.get) },
      preHandler: admin('inventory.view'),
    },
    async (req) => ok(await svc(req).get(req.params.id)),
  );
  app.patch<{ Params: IdParams; Body: UpdateWarehouseInput }>(
    '/:id',
    {
      schema: { ...updateWarehouseSchema, ...routeDocs(WAREHOUSE_DOCS.update) },
      preHandler: adminWrite('inventory.configure'),
    },
    async (req) => ok(await svc(req).update(actorOf(req), req.params.id, req.body)),
  );
  app.post<{ Params: IdParams; Body: WarehouseStatusInput }>(
    '/:id/status',
    {
      schema: { ...warehouseStatusSchema, ...routeDocs(WAREHOUSE_DOCS.status) },
      preHandler: adminWrite('inventory.configure'),
    },
    async (req) => ok(await svc(req).setStatus(actorOf(req), req.params.id, req.body)),
  );
  app.get<{ Params: IdParams }>(
    '/:id/coverage',
    {
      schema: { ...getWarehouseSchema, ...routeDocs(WAREHOUSE_DOCS.getCoverage) },
      preHandler: admin('inventory.view'),
    },
    async (req) => ok(await svc(req).coverage(req.params.id)),
  );
  app.put<{ Params: IdParams; Body: PutCoverageInput }>(
    '/:id/coverage',
    {
      schema: { ...putCoverageSchema, ...routeDocs(WAREHOUSE_DOCS.putCoverage) },
      preHandler: adminWrite('inventory.configure'),
    },
    async (req) => ok(await svc(req).putCoverage(actorOf(req), req.params.id, req.body)),
  );
};
