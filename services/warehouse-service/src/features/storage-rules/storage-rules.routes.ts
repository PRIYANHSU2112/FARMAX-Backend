import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { callerOf, staffRead, staffWrite } from '../../middleware/guards.js';
import { RULE_DOCS as D } from './storage-rules.docs.js';
import type { RuleType } from './storage-rules.rules.js';
import type { RuleInput, RuleUpdate } from './storage-rules.types.js';
import * as V from './storage-rules.validation.js';

interface W {
  id: string;
}
const svc = (req: FastifyRequest) => req.diScope.resolve('storageRulesService');
const conf = staffWrite('warehouse.configure');

/** Mounted at `/admin/warehouses` (gateway `/v1/admin/warehouses`): W2.08 storage rules. */
export const storageRulesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: W; Querystring: { type?: RuleType } }>(
    '/:id/storage-rules',
    {
      schema: { ...V.listRulesSchema, ...routeDocs(D.list) },
      preHandler: staffRead('warehouse.view'),
    },
    async (req) => ok(await svc(req).list(callerOf(req), req.params.id, req.query.type)),
  );
  app.get<{ Params: W }>(
    '/:id/storage-rules/summary',
    {
      schema: { ...V.summarySchema, ...routeDocs(D.summary) },
      preHandler: staffRead('warehouse.view'),
    },
    async (req) => ok(await svc(req).summary(callerOf(req), req.params.id)),
  );
  app.post<{ Params: W; Body: RuleInput }>(
    '/:id/storage-rules',
    { schema: { ...V.createRuleSchema, ...routeDocs(D.create) }, preHandler: conf },
    async (req, reply) =>
      reply.code(201).send(ok(await svc(req).create(callerOf(req), req.params.id, req.body))),
  );
  app.patch<{ Params: W & { ruleId: string }; Body: RuleUpdate }>(
    '/:id/storage-rules/:ruleId',
    { schema: { ...V.updateRuleSchema, ...routeDocs(D.update) }, preHandler: conf },
    async (req) =>
      ok(await svc(req).update(callerOf(req), req.params.id, req.params.ruleId, req.body)),
  );
  app.delete<{ Params: W & { ruleId: string } }>(
    '/:id/storage-rules/:ruleId',
    { schema: { ...V.ruleParams, ...routeDocs(D.remove) }, preHandler: conf },
    async (req, reply) => {
      await svc(req).remove(callerOf(req), req.params.id, req.params.ruleId);
      return reply.code(204).send();
    },
  );
};
