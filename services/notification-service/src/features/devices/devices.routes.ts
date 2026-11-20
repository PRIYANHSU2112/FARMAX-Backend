import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { requireUser, userWrite } from '../../middleware/guards.js';
import { appOf, userOf } from '../../middleware/http.js';
import { DEVICES_DOCS } from './devices.docs.js';
import type { RegisterDeviceInput } from './devices.types.js';
import { deviceIdSchema, registerDeviceSchema } from './devices.validation.js';

/** Mounted at `/notifications/devices`. The caller's own push tokens. */
export const devicesRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: RegisterDeviceInput }>(
    '/',
    {
      schema: { ...registerDeviceSchema, ...routeDocs(DEVICES_DOCS.register) },
      preHandler: userWrite('devices', 10),
    },
    async (req) =>
      ok(
        await req.diScope
          .resolve('devicesService')
          .register(userOf(req).id, appOf(req, req.body.app), req.body),
      ),
  );
  app.get('/', { schema: routeDocs(DEVICES_DOCS.list), preHandler: requireUser }, async (req) =>
    ok(await req.diScope.resolve('devicesService').list(userOf(req).id)),
  );
  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: { ...deviceIdSchema, ...routeDocs(DEVICES_DOCS.remove) },
      preHandler: userWrite('devices', 10),
    },
    async (req, reply) => {
      await req.diScope.resolve('devicesService').remove(userOf(req).id, req.params.id);
      return reply.code(204).send();
    },
  );
};
