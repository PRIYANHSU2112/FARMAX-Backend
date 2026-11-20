import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { requireUser, userWrite } from '../../middleware/guards.js';
import { userOf } from '../../middleware/http.js';
import { PREFERENCES_DOCS } from './preferences.docs.js';
import type { PreferenceChange } from './preferences.service.js';
import { updatePreferencesSchema } from './preferences.validation.js';

/** Mounted at `/notifications/preferences`. The caller's own preferences (all apps). */
export const preferencesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { schema: routeDocs(PREFERENCES_DOCS.get), preHandler: requireUser }, async (req) =>
    ok(await req.diScope.resolve('preferencesService').getForUser(userOf(req).id)),
  );
  app.put<{ Body: { changes: PreferenceChange[] } }>(
    '/',
    {
      schema: { ...updatePreferencesSchema, ...routeDocs(PREFERENCES_DOCS.update) },
      preHandler: userWrite('preferences', 20),
    },
    async (req) =>
      ok(await req.diScope.resolve('preferencesService').update(userOf(req).id, req.body.changes)),
  );
};
