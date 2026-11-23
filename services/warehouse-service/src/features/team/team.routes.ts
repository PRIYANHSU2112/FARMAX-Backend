import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { callerOf, rateLimit, staffRead, staffWrite } from '../../middleware/guards.js';
import { TEAM_DOCS as D } from './team.docs.js';
import type { AddMemberInput, StaffDocType, UpdateMemberInput } from './team.types.js';
import * as V from './team.validation.js';

interface W {
  id: string;
}
type M = W & { userId: string };
const svc = (req: FastifyRequest) => req.diScope.resolve('teamService');
const manage = staffWrite('warehouse.team_manage');

/** Mounted at `/admin/warehouses` (gateway `/v1/admin/warehouses`): W2.06 warehouse team. */
export const teamRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/team/roles',
    { schema: routeDocs(D.roles), preHandler: staffRead('warehouse.view') },
    async (req) => ok(await svc(req).roles(callerOf(req))),
  );
  app.get<{ Params: W }>(
    '/:id/team',
    { schema: { ...V.teamSchema, ...routeDocs(D.list) }, preHandler: staffRead('warehouse.view') },
    async (req) => ok(await svc(req).list(callerOf(req), req.params.id)),
  );
  app.post<{ Params: W; Body: AddMemberInput }>(
    '/:id/team',
    {
      schema: { ...V.addSchema, ...routeDocs(D.add) },
      preHandler: [...manage, rateLimit('invite', 20, 3600)],
    },
    async (req, reply) =>
      reply.code(201).send(ok(await svc(req).add(callerOf(req), req.params.id, req.body))),
  );
  app.patch<{ Params: M; Body: UpdateMemberInput }>(
    '/:id/team/:userId',
    { schema: { ...V.updateSchema, ...routeDocs(D.update) }, preHandler: manage },
    async (req) =>
      ok(await svc(req).update(callerOf(req), req.params.id, req.params.userId, req.body)),
  );
  app.delete<{ Params: M; Body: { reason: string } }>(
    '/:id/team/:userId',
    { schema: { ...V.removeSchema, ...routeDocs(D.remove) }, preHandler: manage },
    async (req) =>
      ok(await svc(req).remove(callerOf(req), req.params.id, req.params.userId, req.body.reason)),
  );
  app.post<{ Params: M }>(
    '/:id/team/:userId/resend-invite',
    { schema: { ...V.memberParams, ...routeDocs(D.resend) }, preHandler: manage },
    async (req) => ok(await svc(req).resend(callerOf(req), req.params.id, req.params.userId)),
  );
  app.put<{ Params: M; Body: { docType: StaffDocType; receipt: string } }>(
    '/:id/team/:userId/documents',
    { schema: { ...V.documentSchema, ...routeDocs(D.putDocument) }, preHandler: manage },
    async (req) =>
      ok(await svc(req).putDocument(callerOf(req), req.params.id, req.params.userId, req.body)),
  );
  app.get<{ Params: M }>(
    '/:id/team/:userId/documents',
    {
      schema: { ...V.memberParams, ...routeDocs(D.documents) },
      preHandler: staffRead('warehouse.team_manage'),
    },
    async (req) => ok(await svc(req).documents(callerOf(req), req.params.id, req.params.userId)),
  );
};
