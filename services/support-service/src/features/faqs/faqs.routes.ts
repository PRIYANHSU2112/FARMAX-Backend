import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import Joi from 'joi';

import { admin, adminWrite, publicRead, requesterWrite } from '../../middleware/guards.js';
import { APPS, type App, ID, idParams } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import { FAQ_DOCS } from './faqs.docs.js';
import type { CategoryInput, FaqInput, FaqListQuery } from './faqs.types.js';

const APP = Joi.string().valid(...APPS);
const CODE = Joi.string().pattern(/^[A-Z][A-Z0-9_]{1,39}$/);
const TOPIC_CODES = Joi.array().items(CODE).max(20).unique();

const faqFields = {
  categoryId: ID,
  question: Joi.string().trim().min(5).max(300),
  answer: Joi.string().trim().min(2).max(4000),
  tags: Joi.array().items(Joi.string().trim().min(2).max(30)).max(20).unique(),
  topicCodes: TOPIC_CODES,
  sortOrder: Joi.number().integer().min(0).max(9999),
  isActive: Joi.boolean(),
};

const svc = (req: FastifyRequest) => req.diScope.resolve('faqsService');

/** Mounted at the service root: `/faqs/*` and `/support/suggestions` (gateway `/v1/...`). */
export const faqsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { app: App } }>(
    '/faqs/categories',
    {
      schema: {
        querystring: Joi.object({ app: APP.required() }),
        ...routeDocs(FAQ_DOCS.categories),
      },
      preHandler: publicRead,
    },
    async (req, reply) => {
      void reply.header('cache-control', 'public, max-age=60');
      return ok(await svc(req).categories(req.query.app));
    },
  );
  app.get<{ Querystring: FaqListQuery }>(
    '/faqs',
    {
      schema: {
        querystring: Joi.object({
          app: APP.required(),
          categoryId: ID,
          q: Joi.string().trim().min(2).max(100),
          cursor: Joi.string().pattern(/^\d{1,5}$/),
          limit: Joi.number().integer().min(1).max(100).default(20),
        }),
        ...routeDocs(FAQ_DOCS.list),
      },
      preHandler: publicRead,
    },
    async (req, reply) => {
      void reply.header('cache-control', 'public, max-age=60');
      return paginated(await svc(req).list(req.query));
    },
  );
  app.get<{ Querystring: { app: App; topic: string; q?: string } }>(
    '/support/suggestions',
    {
      schema: {
        querystring: Joi.object({
          app: APP.required(),
          topic: CODE.required(),
          q: Joi.string().trim().max(200).allow(''),
        }),
        ...routeDocs(FAQ_DOCS.suggestions),
      },
      preHandler: publicRead,
    },
    async (req) => ok(await svc(req).suggestions(req.query.app, req.query.topic, req.query.q)),
  );
  app.post<{ Params: { id: string }; Body: { helpful: boolean } }>(
    '/faqs/:id/feedback',
    {
      schema: {
        ...idParams,
        body: Joi.object({ helpful: Joi.boolean().required() }),
        ...routeDocs(FAQ_DOCS.feedback),
      },
      preHandler: requesterWrite,
    },
    async (req) => ok(await svc(req).feedback(req.user?.id ?? '', req.params.id, req.body.helpful)),
  );

  // ── Admin (/faqs/admin/*) ──
  app.get<{ Querystring: { app?: App } }>(
    '/faqs/admin/categories',
    {
      schema: { querystring: Joi.object({ app: APP }), ...routeDocs(FAQ_DOCS.adminCategories) },
      preHandler: admin('faq.manage'),
    },
    async (req) => ok(await svc(req).adminCategories(req.query.app)),
  );
  app.post<{ Body: CategoryInput }>(
    '/faqs/admin/categories',
    {
      schema: {
        body: Joi.object({
          app: APP.required(),
          code: CODE.required(),
          title: Joi.string().trim().min(2).max(80).required(),
          sortOrder: Joi.number().integer().min(0).max(999),
          isActive: Joi.boolean(),
        }),
        ...routeDocs(FAQ_DOCS.createCategory),
      },
      preHandler: adminWrite('faq.manage'),
    },
    async (req, reply) =>
      reply.status(201).send(ok(await svc(req).createCategory(actorOf(req), req.body))),
  );
  app.patch<{ Params: { id: string }; Body: Partial<CategoryInput> }>(
    '/faqs/admin/categories/:id',
    {
      schema: {
        ...idParams,
        body: Joi.object({
          title: Joi.string().trim().min(2).max(80),
          sortOrder: Joi.number().integer().min(0).max(999),
          isActive: Joi.boolean(),
        }).min(1),
        ...routeDocs(FAQ_DOCS.updateCategory),
      },
      preHandler: adminWrite('faq.manage'),
    },
    async (req) => ok(await svc(req).updateCategory(actorOf(req), req.params.id, req.body)),
  );
  app.get<{ Querystring: { app?: App; categoryId?: string } }>(
    '/faqs/admin/items',
    {
      schema: {
        querystring: Joi.object({ app: APP, categoryId: ID }),
        ...routeDocs(FAQ_DOCS.adminList),
      },
      preHandler: admin('faq.manage'),
    },
    async (req) => ok(await svc(req).adminList(req.query.app, req.query.categoryId)),
  );
  app.post<{ Body: FaqInput }>(
    '/faqs/admin/items',
    {
      schema: {
        body: Joi.object({
          app: APP.required(),
          ...faqFields,
          categoryId: ID.required(),
          question: faqFields.question.required(),
          answer: faqFields.answer.required(),
        }),
        ...routeDocs(FAQ_DOCS.createFaq),
      },
      preHandler: adminWrite('faq.manage'),
    },
    async (req, reply) =>
      reply.status(201).send(ok(await svc(req).createFaq(actorOf(req), req.body))),
  );
  app.patch<{ Params: { id: string }; Body: Partial<FaqInput> }>(
    '/faqs/admin/items/:id',
    {
      schema: {
        ...idParams,
        body: Joi.object({ app: APP, ...faqFields }).min(1),
        ...routeDocs(FAQ_DOCS.updateFaq),
      },
      preHandler: adminWrite('faq.manage'),
    },
    async (req) =>
      ok(await svc(req).updateFaq(actorOf(req), req.params.id, req.body.app, req.body)),
  );
  app.post<{ Body: { app: App; ids: string[] } }>(
    '/faqs/admin/reorder',
    {
      schema: {
        body: Joi.object({
          app: APP.required(),
          ids: Joi.array().items(ID).min(1).max(500).unique().required(),
        }),
        ...routeDocs(FAQ_DOCS.reorder),
      },
      preHandler: adminWrite('faq.manage'),
    },
    async (req) => ok(await svc(req).reorder(actorOf(req), req.body.app, req.body.ids)),
  );
};
