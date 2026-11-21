import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import Joi from 'joi';

import { admin, adminWrite, publicRead } from '../../middleware/guards.js';
import { APPS, type App, REASON, idParams } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import { LEGAL_DOCS } from './legal.docs.js';
import { LEGAL_KINDS, type LegalDraftInput, type LegalKind } from './legal.types.js';

const APP = Joi.string().valid(...APPS);
const KIND = Joi.string().valid(...LEGAL_KINDS);
const SECTIONS = Joi.array()
  .items(Joi.object({ heading: Joi.string().trim().min(2).max(120).required(), body: Joi.string().trim().min(1).max(10_000).required() }))
  .min(1)
  .max(40);
const draftFields = {
  title: Joi.string().trim().min(2).max(160),
  intro: Joi.string().trim().max(2000).allow(null),
  sections: SECTIONS,
  effectiveFrom: Joi.date().iso().allow(null),
};

const svc = (req: FastifyRequest) => req.diScope.resolve('legalService');

/** Mounted at `/legal` (gateway: `/v1/legal`). */
export const legalRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { kind: LegalKind }; Querystring: { app: App } }>(
    '/:kind',
    {
      schema: {
        params: Joi.object({ kind: KIND.required() }),
        querystring: Joi.object({ app: APP.required() }),
        ...routeDocs(LEGAL_DOCS.published),
      },
      preHandler: publicRead,
    },
    async (req, reply) => {
      const doc = await svc(req).published(req.params.kind, req.query.app);
      const etag = `"${doc.id}.${String(doc.version)}"`;
      void reply.header('etag', etag).header('cache-control', 'public, max-age=300');
      if (req.headers['if-none-match'] === etag) return reply.status(304).send();
      return ok(doc);
    },
  );

  // ── Admin (/legal/admin/*) ──
  app.get<{ Querystring: { kind?: LegalKind; app?: App } }>(
    '/admin/documents',
    { schema: { querystring: Joi.object({ kind: KIND, app: APP }), ...routeDocs(LEGAL_DOCS.list) }, preHandler: admin('legal.manage') },
    async (req) => ok(await svc(req).list(req.query.kind, req.query.app)),
  );
  app.post<{ Body: LegalDraftInput }>(
    '/admin/documents',
    {
      schema: {
        body: Joi.object({ kind: KIND.required(), app: APP.allow(null), ...draftFields, title: draftFields.title.required(), sections: SECTIONS.required() }),
        ...routeDocs(LEGAL_DOCS.createDraft),
      },
      preHandler: adminWrite('legal.manage'),
    },
    async (req, reply) => reply.status(201).send(ok(await svc(req).createDraft(actorOf(req), req.body))),
  );
  app.patch<{ Params: { id: string }; Body: Partial<LegalDraftInput> }>(
    '/admin/documents/:id',
    { schema: { ...idParams, body: Joi.object(draftFields).min(1), ...routeDocs(LEGAL_DOCS.updateDraft) }, preHandler: adminWrite('legal.manage') },
    async (req) => ok(await svc(req).updateDraft(actorOf(req), req.params.id, req.body)),
  );
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/admin/documents/:id/publish',
    {
      schema: { ...idParams, body: Joi.object({ reason: REASON.required() }), ...routeDocs(LEGAL_DOCS.publish) },
      preHandler: adminWrite('legal.manage'),
    },
    async (req) => ok(await svc(req).publish(actorOf(req), req.params.id, req.body.reason)),
  );
};
