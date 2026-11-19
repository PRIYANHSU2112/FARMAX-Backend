import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { admin, adminWrite } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import { SETTINGS_DOCS } from './settings.docs.js';
import type { UpdateSettingsInput } from './settings.types.js';
import { updateSettingsSchema } from './settings.validation.js';

/** Mounted at `/admin/inventory/settings` (gateway: `/v1/admin/inventory/settings`). */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    { schema: routeDocs(SETTINGS_DOCS.get), preHandler: admin('inventory.view') },
    async (req) => ok(await req.diScope.resolve('settingsService').view()),
  );
  app.patch<{ Body: UpdateSettingsInput }>(
    '/',
    {
      schema: { ...updateSettingsSchema, ...routeDocs(SETTINGS_DOCS.update) },
      preHandler: adminWrite('inventory.configure'),
    },
    async (req) => ok(await req.diScope.resolve('settingsService').update(actorOf(req), req.body)),
  );
};
