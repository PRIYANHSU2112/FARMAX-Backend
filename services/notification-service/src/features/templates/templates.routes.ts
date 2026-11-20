import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, adminWrite } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import type { CreateTemplateInput, NewVersionInput } from './templates.admin.service.js';
import { TEMPLATE_DOCS } from './templates.docs.js';
import type { Channel, TemplateVars } from './templates.types.js';
import {
  activateSchema,
  createTemplateSchema,
  listTemplatesSchema,
  newVersionSchema,
  previewSchema,
  templateIdSchema,
} from './templates.validation.js';

interface IdParams {
  id: string;
}
const svc = (req: FastifyRequest) => req.diScope.resolve('templatesAdminService');

/** Mounted at `/admin/notification-templates` (gateway: `/v1/admin/notification-templates`). */
export const templatesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { key?: string; channel?: Channel; active?: boolean } }>(
    '/',
    {
      schema: { ...listTemplatesSchema, ...routeDocs(TEMPLATE_DOCS.list) },
      preHandler: admin('notifications.view'),
    },
    async (req) =>
      ok(
        await svc(req).list({
          ...(req.query.key === undefined ? {} : { key: req.query.key }),
          ...(req.query.channel === undefined ? {} : { channel: req.query.channel }),
          activeOnly: req.query.active === true,
        }),
      ),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    {
      schema: { ...templateIdSchema, ...routeDocs(TEMPLATE_DOCS.get) },
      preHandler: admin('notifications.view'),
    },
    async (req) => ok(await svc(req).get(req.params.id)),
  );
  app.post<{ Body: CreateTemplateInput }>(
    '/',
    {
      schema: { ...createTemplateSchema, ...routeDocs(TEMPLATE_DOCS.create) },
      preHandler: adminWrite('notifications.manage'),
    },
    async (req, reply) => reply.code(201).send(ok(await svc(req).create(actorOf(req), req.body))),
  );
  app.post<{ Params: IdParams; Body: NewVersionInput }>(
    '/:id/versions',
    {
      schema: { ...newVersionSchema, ...routeDocs(TEMPLATE_DOCS.newVersion) },
      preHandler: adminWrite('notifications.manage'),
    },
    async (req, reply) =>
      reply.code(201).send(ok(await svc(req).newVersion(actorOf(req), req.params.id, req.body))),
  );
  app.post<{ Params: IdParams; Body: { reason: string } }>(
    '/:id/activate',
    {
      schema: { ...activateSchema, ...routeDocs(TEMPLATE_DOCS.activate) },
      preHandler: adminWrite('notifications.manage'),
    },
    async (req) => ok(await svc(req).activate(actorOf(req), req.params.id, req.body.reason)),
  );
  app.post<{ Params: IdParams; Body: { vars: TemplateVars } }>(
    '/:id/preview',
    {
      schema: { ...previewSchema, ...routeDocs(TEMPLATE_DOCS.preview) },
      preHandler: admin('notifications.view'),
    },
    async (req) => ok(await svc(req).preview(req.params.id, req.body.vars)),
  );
};
