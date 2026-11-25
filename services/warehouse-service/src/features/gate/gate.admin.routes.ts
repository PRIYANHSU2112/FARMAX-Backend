import { NotFoundError } from '@farmx/common/errors';
import { internalAuth } from '@farmx/common/middleware';
import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { callerOf, staffRead, staffWrite } from '../../middleware/guards.js';
import { sendIdempotent } from '../../middleware/idempotency.js';
import type { ScaleInput } from './gate.admin.service.js';
import type { AsnInput } from './gate.asn.service.js';
import { GATE_ADMIN_DOCS as D } from './gate.docs.js';
import type { GateSettings } from './gate.rules.js';
import * as V from './gate.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('gateAdmin');
const p = (req: FastifyRequest) => req.params as { id: string; scaleId?: string };

/** Mounted at `/admin/warehouses` (gateway `/v1/admin/warehouses`): weighbridge scales + gate settings. */
export const gateAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/:id/weigh-scales',
    { schema: { ...V.idParam, ...routeDocs(D.scales) }, preHandler: staffRead('gate.view') },
    async (req) => ok(await svc(req).scales(callerOf(req), p(req).id)),
  );
  app.post(
    '/:id/weigh-scales',
    {
      schema: { ...V.scaleCreateSchema, ...routeDocs(D.createScale) },
      preHandler: staffWrite('gate.configure'),
    },
    async (req, reply) =>
      sendIdempotent(req, reply, 'gate.scales.create', 201, () =>
        svc(req).createScale(callerOf(req), p(req).id, req.body as ScaleInput),
      ),
  );
  app.patch(
    '/:id/weigh-scales/:scaleId',
    {
      schema: { ...V.scaleUpdateSchema, ...routeDocs(D.updateScale) },
      preHandler: staffWrite('gate.configure'),
    },
    async (req, reply) =>
      sendIdempotent(req, reply, 'gate.scales.update', 200, () =>
        svc(req).updateScale(
          callerOf(req),
          p(req).id,
          String(p(req).scaleId),
          req.body as Partial<ScaleInput> & { expectedVersion: number },
        ),
      ),
  );
  app.delete(
    '/:id/weigh-scales/:scaleId',
    {
      schema: { ...V.scaleParams, ...routeDocs(D.deleteScale) },
      preHandler: staffWrite('gate.configure'),
    },
    async (req, reply) => {
      await svc(req).deleteScale(callerOf(req), p(req).id, String(p(req).scaleId));
      return reply.code(204).send();
    },
  );
  app.get(
    '/:id/gate-settings',
    { schema: { ...V.idParam, ...routeDocs(D.settings) }, preHandler: staffRead('gate.view') },
    async (req) => ok(await svc(req).settings(callerOf(req), p(req).id)),
  );
  app.put(
    '/:id/gate-settings',
    {
      schema: { ...V.settingsSchema, ...routeDocs(D.putSettings) },
      preHandler: staffWrite('gate.configure'),
    },
    async (req, reply) =>
      sendIdempotent(req, reply, 'gate.settings.put', 200, () =>
        svc(req).putSettings(callerOf(req), p(req).id, req.body as Partial<GateSettings>),
      ),
  );
};

/**
 * `/internal/wms/gate/*` (service token, never routed by the gateway, not in Swagger): vendor
 * portal / EDI ASN intake, idempotent on (vendor, ASN ref).
 */
export const gateInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;
  app.post(
    '/gate/asns',
    { schema: { hide: true, ...V.asnInternalSchema }, onRequest: [internalAuth(token)] },
    async (req, reply) => {
      const input = req.body as AsnInput;
      const [w] = await req.diScope.resolve('warehousesService').findMany([input.warehouseId]);
      if (w === undefined) throw new NotFoundError('Warehouse');
      return reply
        .code(201)
        .send(ok(await req.diScope.resolve('gateAsn').createFromVendor(input, w)));
    },
  );
};
