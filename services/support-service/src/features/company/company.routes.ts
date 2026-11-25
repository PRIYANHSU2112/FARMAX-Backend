import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { publicRead, rateLimit, requesterRead, requireUser } from '../../middleware/guards.js';
import { COMPANY_DOCS } from './company.docs.js';
import type { ApplyInput } from './company.types.js';
import { applyBody } from './company.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('companyService');
const userId = (req: FastifyRequest): string => req.user?.id ?? '';

/** Mounted at `/support/company` (gateway: `/v1/support/company`). */
export const companyRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/documents',
    { schema: routeDocs(COMPANY_DOCS.publicDocs), preHandler: publicRead },
    async (req, reply) => {
      const { docs, etag } = await svc(req).publicDocs();
      void reply.header('etag', etag).header('cache-control', 'public, max-age=300');
      if (req.headers['if-none-match'] === etag) return reply.status(304).send();
      return ok(docs);
    },
  );

  app.post<{ Body: ApplyInput }>(
    '/applications',
    {
      schema: { body: applyBody, ...routeDocs(COMPANY_DOCS.apply) },
      preHandler: [requireUser, rateLimit('company-apply', 5, 3600)],
    },
    async (req, reply) => reply.status(201).send(ok(await svc(req).apply(userId(req), req.body))),
  );

  app.get(
    '/applications/me',
    { schema: routeDocs(COMPANY_DOCS.mine), preHandler: requesterRead },
    async (req) => ok(await svc(req).mine(userId(req))),
  );
};
