import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { admin, customer, rateLimit } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import { GEO_DOCS } from './geo.docs.js';
import type { PinInput, PinListQuery, TerritoryInput } from './geo.types.js';
import {
  createTerritorySchema,
  listPinsSchema,
  lookupPinSchema,
  updateTerritorySchema,
  upsertPinSchema,
} from './geo.validation.js';

type Reasoned<T> = T & { reason: string };

/** Mounted at `/farms/geo` (customer). Controller logic is a one-liner, so routes call the service. */
export const geoRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { pin: string } }>(
    '/pincodes/:pin',
    {
      schema: { ...lookupPinSchema, ...routeDocs(GEO_DOCS.lookupPin) },
      preHandler: [...customer, rateLimit('pin-lookup', 60, 60)],
    },
    async (request) =>
      ok(await request.diScope.resolve('geoService').lookupPin(request.params.pin)),
  );
};

/** Mounted at `/admin/farms/geo`. */
export const geoAdminRoutes: FastifyPluginAsync = async (app) => {
  const guard = admin('territories.manage');

  app.get<{ Querystring: PinListQuery }>(
    '/pincodes',
    { schema: { ...listPinsSchema, ...routeDocs(GEO_DOCS.listPins) }, preHandler: guard },
    async (request) =>
      paginated(await request.diScope.resolve('geoService').listPins(request.query)),
  );

  app.put<{ Params: { pin: string }; Body: PinInput }>(
    '/pincodes/:pin',
    { schema: { ...upsertPinSchema, ...routeDocs(GEO_DOCS.upsertPin) }, preHandler: guard },
    async (request) =>
      ok(
        await request.diScope
          .resolve('geoService')
          .upsertPin(request.params.pin, request.body, actorOf(request)),
      ),
  );

  app.get(
    '/territories',
    { schema: routeDocs(GEO_DOCS.listTerritories), preHandler: guard },
    async (request) => ok(await request.diScope.resolve('geoService').listTerritories()),
  );

  app.post<{ Body: Reasoned<TerritoryInput> }>(
    '/territories',
    {
      schema: { ...createTerritorySchema, ...routeDocs(GEO_DOCS.createTerritory) },
      preHandler: guard,
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          ok(
            await request.diScope
              .resolve('geoService')
              .createTerritory(request.body, actorOf(request)),
          ),
        ),
  );

  app.patch<{ Params: { id: string }; Body: Reasoned<Partial<TerritoryInput>> }>(
    '/territories/:id',
    {
      schema: { ...updateTerritorySchema, ...routeDocs(GEO_DOCS.updateTerritory) },
      preHandler: guard,
    },
    async (request) =>
      ok(
        await request.diScope
          .resolve('geoService')
          .updateTerritory(request.params.id, request.body, actorOf(request)),
      ),
  );
};
