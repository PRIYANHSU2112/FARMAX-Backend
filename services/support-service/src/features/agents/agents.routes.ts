import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import Joi from 'joi';

import { admin, adminWrite } from '../../middleware/guards.js';
import { APPS, type App, ID, TEAMS, idParams } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import { AGENT_DOCS } from './agents.docs.js';
import type { AgentInput, CannedReplyInput } from './agents.types.js';

const APP = Joi.string().valid(...APPS);
const CODE = Joi.string().pattern(/^[A-Z][A-Z0-9_]{1,39}$/);
const cannedFields = {
  app: APP.allow(null),
  topicCode: CODE.allow(null),
  title: Joi.string().trim().min(2).max(80),
  body: Joi.string().trim().min(2).max(2000),
  isActive: Joi.boolean(),
};

const svc = (req: FastifyRequest) => req.diScope.resolve('agentsService');

/** Mounted at `/support/admin` (gateway: `/v1/support/admin`). Staff only. */
export const agentsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/agents', { schema: routeDocs(AGENT_DOCS.list), preHandler: admin('support.view') }, async (req) => ok(await svc(req).list()));
  app.get('/agents/me', { schema: routeDocs(AGENT_DOCS.me), preHandler: admin('support.manage') }, async (req) =>
    ok(await svc(req).me(req.user?.id ?? '')),
  );
  app.put<{ Body: { acceptingChats: boolean } }>(
    '/agents/me/availability',
    {
      schema: { body: Joi.object({ acceptingChats: Joi.boolean().required() }), ...routeDocs(AGENT_DOCS.availability) },
      preHandler: adminWrite('support.manage'),
    },
    async (req) => ok(await svc(req).setAccepting(req.user?.id ?? '', req.body.acceptingChats)),
  );
  app.put<{ Params: { userId: string }; Body: AgentInput }>(
    '/agents/:userId',
    {
      schema: {
        params: Joi.object({ userId: ID.required() }),
        body: Joi.object({
          displayName: Joi.string().trim().min(2).max(120).required(),
          teams: Joi.array().items(Joi.string().valid(...TEAMS)).min(1).unique().required(),
          apps: Joi.array().items(APP).min(1).unique().required(),
          maxConcurrent: Joi.number().integer().min(1).max(100),
          isActive: Joi.boolean(),
        }),
        ...routeDocs(AGENT_DOCS.save),
      },
      preHandler: adminWrite('support.configure'),
    },
    async (req) => ok(await svc(req).save(actorOf(req), req.params.userId, req.body)),
  );
  app.get<{ Querystring: { app?: App; topicCode?: string } }>(
    '/canned-replies',
    { schema: { querystring: Joi.object({ app: APP, topicCode: CODE }), ...routeDocs(AGENT_DOCS.listCanned) }, preHandler: admin('support.view') },
    async (req) => ok(await svc(req).cannedReplies(req.query.app, req.query.topicCode)),
  );
  app.post<{ Body: CannedReplyInput }>(
    '/canned-replies',
    {
      schema: {
        body: Joi.object({ ...cannedFields, title: cannedFields.title.required(), body: cannedFields.body.required() }),
        ...routeDocs(AGENT_DOCS.createCanned),
      },
      preHandler: adminWrite('support.configure'),
    },
    async (req, reply) => reply.status(201).send(ok(await svc(req).createCanned(actorOf(req), req.body))),
  );
  app.patch<{ Params: { id: string }; Body: Partial<CannedReplyInput> }>(
    '/canned-replies/:id',
    { schema: { ...idParams, body: Joi.object(cannedFields).min(1), ...routeDocs(AGENT_DOCS.updateCanned) }, preHandler: adminWrite('support.configure') },
    async (req) => ok(await svc(req).updateCanned(actorOf(req), req.params.id, req.body)),
  );
};
