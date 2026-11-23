import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { callerOf, rateLimit, staffRead, staffWrite } from '../../middleware/guards.js';
import { WAREHOUSE_DOCS } from './warehouses.docs.js';
import type {
  CreateWarehouseInput,
  StatusAction,
  StatusInput,
  UpdateWarehouseInput,
  WarehouseListQuery,
} from './warehouses.types.js';
import {
  codeAvailabilitySchema,
  createWarehouseSchema,
  discardSchema,
  exportWarehousesSchema,
  getWarehouseSchema,
  listWarehousesSchema,
  statusSchema,
  updateWarehouseSchema,
} from './warehouses.validation.js';

interface IdParams {
  id: string;
}

const svc = (req: FastifyRequest) => req.diScope.resolve('warehousesService');

/** A CSV cell: quoted, and never a spreadsheet formula (= + - @ get a leading apostrophe). */
const csvCell = (value: string): string => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
};

/** UTF-8 byte-order mark: Excel then reads ₹ and Indian names correctly. */
const BOM = String.fromCharCode(0xfeff);

const STATUS_ACTIONS: readonly StatusAction[] = ['activate', 'limit', 'deactivate', 'reactivate'];

/** Mounted at `/admin/warehouses` (gateway: `/v1/admin/warehouses`). */
export const warehousesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: WarehouseListQuery }>(
    '/',
    {
      schema: { ...listWarehousesSchema, ...routeDocs(WAREHOUSE_DOCS.list) },
      preHandler: staffRead('warehouse.view'),
    },
    async (req) => {
      const page = await svc(req).list(callerOf(req), req.query);
      return {
        success: true,
        data: page.items,
        meta: { nextCursor: page.nextCursor, limit: page.limit, total: page.total },
      };
    },
  );
  app.get(
    '/summary',
    { schema: routeDocs(WAREHOUSE_DOCS.summary), preHandler: staffRead('warehouse.view') },
    async (req) => ok(await svc(req).summary(callerOf(req))),
  );
  app.get<{ Querystring: Omit<WarehouseListQuery, 'cursor' | 'limit'> }>(
    '/export.csv',
    {
      schema: { ...exportWarehousesSchema, ...routeDocs(WAREHOUSE_DOCS.export) },
      preHandler: [...staffRead('warehouse.view'), rateLimit('export', 5, 60)],
    },
    async (req, reply) => {
      const rows = await svc(req).exportRows(callerOf(req), req.query);
      const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="warehouses.csv"')
        .header('cache-control', 'no-store')
        .send(`${BOM}${csv}\r\n`);
    },
  );
  app.get<{ Querystring: { code: string } }>(
    '/code-availability',
    {
      schema: { ...codeAvailabilitySchema, ...routeDocs(WAREHOUSE_DOCS.codeAvailability) },
      preHandler: staffRead('warehouse.create'),
    },
    async (req) => ok(await svc(req).codeAvailable(req.query.code)),
  );
  app.post<{ Body: CreateWarehouseInput }>(
    '/',
    {
      schema: { ...createWarehouseSchema, ...routeDocs(WAREHOUSE_DOCS.create) },
      preHandler: staffWrite('warehouse.create'),
    },
    async (req, reply) => reply.code(201).send(ok(await svc(req).create(callerOf(req), req.body))),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    {
      schema: { ...getWarehouseSchema, ...routeDocs(WAREHOUSE_DOCS.get) },
      preHandler: staffRead('warehouse.view'),
    },
    async (req) => ok(await svc(req).get(callerOf(req), req.params.id)),
  );
  app.patch<{ Params: IdParams; Body: UpdateWarehouseInput }>(
    '/:id',
    {
      schema: { ...updateWarehouseSchema, ...routeDocs(WAREHOUSE_DOCS.update) },
      preHandler: staffWrite('warehouse.configure'),
    },
    async (req) => ok(await svc(req).update(callerOf(req), req.params.id, req.body)),
  );
  for (const action of STATUS_ACTIONS) {
    app.post<{ Params: IdParams; Body: StatusInput }>(
      `/:id/${action}`,
      {
        schema: { ...statusSchema, ...routeDocs(WAREHOUSE_DOCS[action]) },
        preHandler: staffWrite('warehouse.status_change'),
      },
      async (req) =>
        ok(await svc(req).changeStatus(callerOf(req), req.params.id, action, req.body)),
    );
  }
  app.delete<{ Params: IdParams; Querystring: { expectedVersion: number } }>(
    '/:id',
    {
      schema: { ...discardSchema, ...routeDocs(WAREHOUSE_DOCS.discard) },
      preHandler: staffWrite('warehouse.create'),
    },
    async (req, reply) => {
      await svc(req).discard(callerOf(req), req.params.id, req.query.expectedVersion);
      return reply.code(204).send();
    },
  );
};
