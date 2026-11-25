import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { customerOf, customerRead, customerWrite, publicRead } from '../../middleware/guards.js';
import { certificatesDocs as D } from './certificates.docs.js';
import * as V from './certificates.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('certificatesService');

/** Customer app `/certificates/*`: own consignments and units only. */
export const certificatesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { q?: string; cursor?: string; limit: number } }>(
    '/',
    { schema: { ...V.listSchema, ...routeDocs(D.list) }, preHandler: customerRead },
    async (req) => paginated(await svc(req).list(customerOf(req), req.query)),
  );
  app.get<{ Params: { qrCode: string } }>(
    '/units/:qrCode',
    { schema: { ...V.unitSchema, ...routeDocs(D.unit) }, preHandler: customerRead },
    async (req) => ok(await svc(req).unit(customerOf(req), req.params.qrCode)),
  );
  app.get<{ Params: { cnNo: string } }>(
    '/consignments/:cnNo',
    { schema: { ...V.consignmentSchema, ...routeDocs(D.consignment) }, preHandler: customerRead },
    async (req) => ok(await svc(req).consignment(customerOf(req), req.params.cnNo)),
  );
  app.put<{ Params: { cnNo: string }; Body: { watch: boolean } }>(
    '/consignments/:cnNo/watch',
    { schema: { ...V.watchSchema, ...routeDocs(D.watch) }, preHandler: customerWrite },
    async (req) => ok(await svc(req).watch(customerOf(req), req.params.cnNo, req.body.watch)),
  );
};

/** Public `/verify/:code` (verify.farmx.in): no login. */
export const verifyRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { code: string } }>(
    '/:code',
    { schema: { ...V.verifySchema, ...routeDocs(D.verify) }, preHandler: publicRead },
    async (req) => ok(await svc(req).verify(req.params.code)),
  );
};
