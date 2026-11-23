import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import Joi from 'joi';

import { admin, adminWrite, publicRead } from '../../middleware/guards.js';
import { APPS, type App, ID, PRIORITIES, REASON, TEAMS, idParams } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import { TOPIC_DOCS } from './topics.docs.js';
import type { Priority } from './topics.rules.js';
import type { RuleInput, SlaPolicyInput, TopicInput } from './topics.types.js';

const APP = Joi.string().valid(...APPS);
const CODE = Joi.string()
  .pattern(/^[A-Z][A-Z0-9_]{1,39}$/)
  .messages({ 'string.pattern.base': 'must be UPPER_SNAKE_CASE (2–40 chars)' });
const PRIORITY = Joi.string().valid(...PRIORITIES);
const TEAM = Joi.string().valid(...TEAMS);

const topicFields = {
  label: Joi.string().trim().min(2).max(80),
  description: Joi.string().trim().max(200).allow(null),
  icon: Joi.string()
    .pattern(/^[a-z0-9-]{1,40}$/)
    .allow(null),
  sortOrder: Joi.number().integer().min(0).max(999),
  defaultPriority: PRIORITY,
  team: TEAM,
  requiresOrder: Joi.boolean(),
  allowsEvidence: Joi.boolean(),
  isCommonIssue: Joi.boolean(),
  isActive: Joi.boolean(),
};

const conditions = Joi.object({
  temperatureClasses: Joi.array()
    .items(Joi.string().valid('AMB', 'AMB_CTL', 'CC_REF', 'CC_FRZ', 'HAZ'))
    .max(5)
    .unique(),
  minOrderAmount: Joi.number().min(0).max(10_000_000),
  keywords: Joi.array().items(Joi.string().trim().min(2).max(40)).max(30).unique(),
  requesterTypes: Joi.array()
    .items(Joi.string().valid('CUSTOMER', 'VENDOR', 'LOGISTICS_PARTNER', 'INTERNAL'))
    .max(4)
    .unique(),
});

const ruleFields = {
  name: Joi.string().trim().min(2).max(80),
  app: APP.allow(null),
  topicCode: CODE.allow(null),
  conditions,
  priority: PRIORITY,
  reasonLabel: Joi.string().trim().min(2).max(40),
  team: TEAM.allow(null),
  sortOrder: Joi.number().integer().min(0).max(9999),
  isActive: Joi.boolean(),
};

const svc = (req: FastifyRequest) => req.diScope.resolve('topicsService');

/** Mounted at `/support` (gateway: `/v1/support`). */
export const topicsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { app: App } }>(
    '/config',
    {
      schema: { querystring: Joi.object({ app: APP.required() }), ...routeDocs(TOPIC_DOCS.config) },
      preHandler: publicRead,
    },
    async (req, reply) => {
      void reply.header('cache-control', 'public, max-age=60');
      return ok(await svc(req).publicConfig(req.query.app));
    },
  );

  // ── Admin ──
  app.get<{ Querystring: { app?: App } }>(
    '/admin/topics',
    {
      schema: { querystring: Joi.object({ app: APP }), ...routeDocs(TOPIC_DOCS.listTopics) },
      preHandler: admin('support.view'),
    },
    async (req) => ok(await svc(req).listTopics(req.query.app)),
  );
  app.post<{ Body: TopicInput }>(
    '/admin/topics',
    {
      schema: {
        body: Joi.object({
          app: APP.required(),
          code: CODE.required(),
          ...topicFields,
          label: topicFields.label.required(),
          reason: REASON,
        }),
        ...routeDocs(TOPIC_DOCS.createTopic),
      },
      preHandler: adminWrite('support.configure'),
    },
    async (req, reply) =>
      reply.status(201).send(ok(await svc(req).createTopic(actorOf(req), req.body))),
  );
  app.patch<{ Params: { id: string }; Body: Partial<TopicInput> }>(
    '/admin/topics/:id',
    {
      schema: {
        ...idParams,
        body: Joi.object({ ...topicFields, reason: REASON.required() }).min(2),
        ...routeDocs(TOPIC_DOCS.updateTopic),
      },
      preHandler: adminWrite('support.configure'),
    },
    async (req) => ok(await svc(req).updateTopic(actorOf(req), req.params.id, req.body)),
  );
  app.get(
    '/admin/priority-rules',
    { schema: routeDocs(TOPIC_DOCS.listRules), preHandler: admin('support.view') },
    async (req) => ok(await svc(req).listRules()),
  );
  app.post<{ Body: RuleInput }>(
    '/admin/priority-rules',
    {
      schema: {
        body: Joi.object({
          ...ruleFields,
          name: ruleFields.name.required(),
          conditions: conditions.required(),
          priority: PRIORITY.required(),
          reasonLabel: ruleFields.reasonLabel.required(),
          reason: REASON,
        }),
        ...routeDocs(TOPIC_DOCS.createRule),
      },
      preHandler: adminWrite('support.configure'),
    },
    async (req, reply) =>
      reply.status(201).send(ok(await svc(req).createRule(actorOf(req), req.body))),
  );
  app.patch<{ Params: { id: string }; Body: Partial<RuleInput> }>(
    '/admin/priority-rules/:id',
    {
      schema: {
        ...idParams,
        body: Joi.object({ ...ruleFields, reason: REASON.required() }).min(2),
        ...routeDocs(TOPIC_DOCS.updateRule),
      },
      preHandler: adminWrite('support.configure'),
    },
    async (req) => ok(await svc(req).updateRule(actorOf(req), req.params.id, req.body)),
  );
  app.get(
    '/admin/sla-policies',
    { schema: routeDocs(TOPIC_DOCS.listPolicies), preHandler: admin('support.view') },
    async (req) => ok(await svc(req).listPolicies()),
  );
  app.put<{ Params: { app: App; priority: Priority }; Body: SlaPolicyInput }>(
    '/admin/sla-policies/:app/:priority',
    {
      schema: {
        params: Joi.object({ app: APP.required(), priority: PRIORITY.required() }),
        body: Joi.object({
          calendarId: ID.allow(null).required(),
          firstResponseMins: Joi.number().integer().min(1).max(43_200).required(),
          resolveMins: Joi.number()
            .integer()
            .min(Joi.ref('firstResponseMins'))
            .max(129_600)
            .required(),
          businessHoursOnly: Joi.boolean().required(),
          reason: REASON.required(),
        }),
        ...routeDocs(TOPIC_DOCS.savePolicy),
      },
      preHandler: adminWrite('support.configure'),
    },
    async (req) =>
      ok(await svc(req).savePolicy(actorOf(req), req.params.app, req.params.priority, req.body)),
  );
};
