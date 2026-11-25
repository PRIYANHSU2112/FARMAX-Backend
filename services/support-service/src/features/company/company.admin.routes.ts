import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, adminWrite } from '../../middleware/guards.js';
import { idParams } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import { COMPANY_DOCS } from './company.docs.js';
import type {
  ApplicationQueueQuery,
  CompanyDocInput,
  DocListQuery,
  ReviewInput,
} from './company.types.js';
import {
  createDocBody,
  deleteDocBody,
  docListQuery,
  queueQuery,
  reviewBody,
  updateDocBody,
} from './company.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('companyService');

interface Id {
  Params: { id: string };
}

/** Mounted at `/admin/support` (gateway: `/v1/admin/support`). Staff only. */
export const companyAdminRoutes: FastifyPluginAsync = async (app) => {
  // ── company documents ──
  app.get<{ Querystring: DocListQuery }>(
    '/company/documents',
    {
      schema: { querystring: docListQuery, ...routeDocs(COMPANY_DOCS.listDocs) },
      preHandler: admin('legal.manage'),
    },
    async (req) => ok(await svc(req).listDocs(req.query)),
  );
  app.post<{ Body: CompanyDocInput }>(
    '/company/documents',
    {
      schema: { body: createDocBody, ...routeDocs(COMPANY_DOCS.createDoc) },
      preHandler: adminWrite('legal.manage'),
    },
    async (req, reply) =>
      reply.status(201).send(ok(await svc(req).createDoc(actorOf(req), req.body))),
  );
  app.patch<Id & { Body: Partial<CompanyDocInput> }>(
    '/company/documents/:id',
    {
      schema: { ...idParams, body: updateDocBody, ...routeDocs(COMPANY_DOCS.updateDoc) },
      preHandler: adminWrite('legal.manage'),
    },
    async (req) => ok(await svc(req).updateDoc(actorOf(req), req.params.id, req.body)),
  );
  app.delete<Id & { Body: { reason: string } }>(
    '/company/documents/:id',
    {
      schema: { ...idParams, body: deleteDocBody, ...routeDocs(COMPANY_DOCS.deleteDoc) },
      preHandler: adminWrite('legal.manage'),
    },
    async (req, reply) => {
      await svc(req).deleteDoc(actorOf(req), req.params.id, req.body.reason);
      return reply.status(204).send();
    },
  );

  // ── applications review queue ──
  app.get<{ Querystring: ApplicationQueueQuery }>(
    '/applications',
    {
      schema: { querystring: queueQuery, ...routeDocs(COMPANY_DOCS.queue) },
      preHandler: admin('support.view'),
    },
    async (req) => paginated(await svc(req).queue(req.query)),
  );
  app.get<Id>(
    '/applications/:id',
    {
      schema: { ...idParams, ...routeDocs(COMPANY_DOCS.detail) },
      preHandler: admin('support.view'),
    },
    async (req) => ok(await svc(req).detail(req.params.id)),
  );
  app.patch<Id & { Body: ReviewInput }>(
    '/applications/:id/status',
    {
      schema: { ...idParams, body: reviewBody, ...routeDocs(COMPANY_DOCS.review) },
      preHandler: adminWrite('support.manage'),
    },
    async (req) => ok(await svc(req).review(actorOf(req), req.params.id, req.body)),
  );
};
