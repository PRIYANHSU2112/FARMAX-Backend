import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { callerOf, staffRead, staffWrite } from '../../middleware/guards.js';
import { STORAGE_DOCS as D } from './storage.docs.js';
import type {
  BinUpdate,
  BinsInput,
  RackInput,
  RackUpdate,
  ZoneInput,
  ZoneUpdate,
} from './storage.types.js';
import * as V from './storage.validation.js';

interface W {
  id: string;
}
const svc = (req: FastifyRequest) => req.diScope.resolve('storageService');
const read = staffRead('warehouse.view');
const write = staffWrite('warehouse.configure');

/** Mounted at `/admin/warehouses` (gateway `/v1/admin/warehouses`): W2.05 storage setup. */
export const storageRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: W }>(
    '/:id/storage/layout',
    { schema: { ...V.layoutSchema, ...routeDocs(D.layout) }, preHandler: read },
    async (req) => ok(await svc(req).layout(callerOf(req), req.params.id)),
  );

  app.get<{ Params: W }>(
    '/:id/zones',
    { schema: { ...V.listZonesSchema, ...routeDocs(D.zones) }, preHandler: read },
    async (req) => ok(await svc(req).zones(callerOf(req), req.params.id)),
  );
  app.post<{ Params: W; Body: ZoneInput }>(
    '/:id/zones',
    { schema: { ...V.createZoneSchema, ...routeDocs(D.createZone) }, preHandler: write },
    async (req, reply) =>
      reply.code(201).send(ok(await svc(req).createZone(callerOf(req), req.params.id, req.body))),
  );
  app.patch<{ Params: W & { zoneId: string }; Body: ZoneUpdate }>(
    '/:id/zones/:zoneId',
    { schema: { ...V.updateZoneSchema, ...routeDocs(D.updateZone) }, preHandler: write },
    async (req) =>
      ok(await svc(req).updateZone(callerOf(req), req.params.id, req.params.zoneId, req.body)),
  );
  app.delete<{ Params: W & { zoneId: string } }>(
    '/:id/zones/:zoneId',
    { schema: { ...V.zoneParamsSchema, ...routeDocs(D.deleteZone) }, preHandler: write },
    async (req, reply) => {
      await svc(req).deleteZone(callerOf(req), req.params.id, req.params.zoneId);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: W; Querystring: { zoneId?: string } }>(
    '/:id/racks',
    { schema: { ...V.listRacksSchema, ...routeDocs(D.racks) }, preHandler: read },
    async (req) => ok(await svc(req).racks(callerOf(req), req.params.id, req.query.zoneId)),
  );
  app.post<{ Params: W & { zoneId: string }; Body: RackInput }>(
    '/:id/zones/:zoneId/racks',
    { schema: { ...V.createRackSchema, ...routeDocs(D.createRack) }, preHandler: write },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          ok(await svc(req).createRack(callerOf(req), req.params.id, req.params.zoneId, req.body)),
        ),
  );
  app.patch<{ Params: W & { rackId: string }; Body: RackUpdate }>(
    '/:id/racks/:rackId',
    { schema: { ...V.updateRackSchema, ...routeDocs(D.updateRack) }, preHandler: write },
    async (req) =>
      ok(await svc(req).updateRack(callerOf(req), req.params.id, req.params.rackId, req.body)),
  );
  app.delete<{ Params: W & { rackId: string } }>(
    '/:id/racks/:rackId',
    { schema: { ...V.rackParamsSchema, ...routeDocs(D.deleteRack) }, preHandler: write },
    async (req, reply) => {
      await svc(req).deleteRack(callerOf(req), req.params.id, req.params.rackId);
      return reply.code(204).send();
    },
  );

  app.get<{
    Params: W;
    Querystring: { rackId?: string; zoneId?: string; cursor?: string; limit: number };
  }>(
    '/:id/bins',
    { schema: { ...V.listBinsSchema, ...routeDocs(D.bins) }, preHandler: read },
    async (req) => {
      const page = await svc(req).bins(callerOf(req), req.params.id, req.query);
      return {
        success: true,
        data: page.items,
        meta: { nextCursor: page.nextCursor, limit: page.limit },
      };
    },
  );
  app.post<{ Params: W & { rackId: string }; Body: BinsInput }>(
    '/:id/racks/:rackId/bins',
    { schema: { ...V.createBinsSchema, ...routeDocs(D.createBins) }, preHandler: write },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          ok(await svc(req).createBins(callerOf(req), req.params.id, req.params.rackId, req.body)),
        ),
  );
  app.patch<{ Params: W & { binId: string }; Body: BinUpdate }>(
    '/:id/bins/:binId',
    { schema: { ...V.updateBinSchema, ...routeDocs(D.updateBin) }, preHandler: write },
    async (req) =>
      ok(await svc(req).updateBin(callerOf(req), req.params.id, req.params.binId, req.body)),
  );
  app.delete<{ Params: W & { binId: string } }>(
    '/:id/bins/:binId',
    { schema: { ...V.binParamsSchema, ...routeDocs(D.deleteBin) }, preHandler: write },
    async (req, reply) => {
      await svc(req).deleteBin(callerOf(req), req.params.id, req.params.binId);
      return reply.code(204).send();
    },
  );
};
