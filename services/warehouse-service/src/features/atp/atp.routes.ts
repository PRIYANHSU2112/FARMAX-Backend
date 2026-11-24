import { Readable } from 'node:stream';

import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { type Audience, audRead, audWrite, callerOf, rateLimit } from '../../middleware/guards.js';
import { type Paging, pageBody } from '../../middleware/paging.js';
import { atpDocs } from './atp.docs.js';
import type { AtpFilter, AtpSort } from './atp.repository.js';
import * as V from './atp.validation.js';

type Q = Record<string, string | number | boolean | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const svc = (req: FastifyRequest) => req.diScope.resolve('atpService');
const filter = (req: FastifyRequest): AtpFilter => {
  const f = q(req);
  return {
    ...(f.warehouseId === undefined ? {} : { warehouseId: String(f.warehouseId) }),
    ...(f.categoryId === undefined ? {} : { categoryId: String(f.categoryId) }),
    ...(f.temperatureClass === undefined ? {} : { temperatureClass: String(f.temperatureClass) }),
    ...(f.q === undefined ? {} : { q: String(f.q) }),
    ...(f.health === undefined ? {} : { health: f.health as AtpFilter['health'] }),
  };
};
const paging = (req: FastifyRequest): Paging => ({
  limit: Number(q(req).limit ?? 20),
  ...(q(req).cursor === undefined ? {} : { cursor: String(q(req).cursor) }),
  ...(q(req).page === undefined ? {} : { page: Number(q(req).page) }),
});

/** D-57b W3.13 Available-to-Promise. Reads on both panels; settings writes on the admin panel. */
export const atpRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = atpDocs(aud);
    const read = audRead(aud, 'inventory.view');

    app.get(
      '/atp/kpis',
      { schema: { ...V.kpisQuery, ...routeDocs(D.kpis) }, preHandler: read },
      async (req) => ok(await svc(req).kpis(callerOf(req), filter(req), q(req).fresh === true)),
    );
    app.get(
      '/atp/categories',
      { schema: { ...V.categoriesQuery, ...routeDocs(D.categories) }, preHandler: read },
      async (req) =>
        ok(await svc(req).categories(callerOf(req), q(req).warehouseId as string | undefined)),
    );
    app.get(
      '/atp/items',
      { schema: { ...V.itemsQuery, ...routeDocs(D.items) }, preHandler: read },
      async (req) =>
        pageBody(
          await svc(req).items(
            callerOf(req),
            filter(req),
            (q(req).sort ?? 'netAtp') as AtpSort,
            q(req).order === 'desc',
            paging(req),
          ),
        ),
    );
    app.get(
      '/atp/items/export.csv',
      {
        schema: { ...V.exportQuery, ...routeDocs(D.csv) },
        preHandler: [...read, rateLimit('export', 5, 60)],
      },
      async (req, reply) =>
        reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="atp-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          .send(Readable.from(svc(req).exportCsv(callerOf(req), filter(req)))),
    );
    app.get('/atp/settings', { schema: routeDocs(D.settings), preHandler: read }, async (req) =>
      ok(await svc(req).settings()),
    );
    app.get(
      '/atp/node-distribution',
      { schema: routeDocs(D.nodes), preHandler: read },
      async (req) => ok(await svc(req).nodeDistribution(callerOf(req))),
    );
    app.post(
      '/atp/sync',
      {
        schema: { ...V.syncSchema, ...routeDocs(D.sync) },
        preHandler: [...read, rateLimit('atp-sync', 6, 60)],
      },
      async (req) =>
        ok(
          await svc(req).sync(
            callerOf(req),
            (req.body as { warehouseId?: string | null }).warehouseId ?? null,
          ),
        ),
    );

    if (aud !== 'admin') return;
    app.put(
      '/atp/settings',
      {
        schema: { ...V.settingsSchema, ...routeDocs(D.settingsSave) },
        preHandler: audWrite(aud, 'inventory.configure'),
      },
      async (req) => ok(await svc(req).putSettings(callerOf(req), req.body as never)),
    );
  };
