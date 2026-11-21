import { UnauthorizedError } from '@farmx/common/errors';
import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, adminWrite } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import type { AccountStatus, JournalFilter } from '../ledger/index.js';
import { CONSOLE_DOCS } from './console.docs.js';
import {
  accountSchema,
  accountsSchema,
  freezeSchema,
  journalsSchema,
  settingSchema,
} from './console.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('consoleService');

/** Mounted at `/admin/wallet` (gateway: `/v1/admin/wallet`). Staff only. */
export const consoleRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Querystring: { status?: AccountStatus; userId?: string; cursor?: string; limit: number };
  }>(
    '/accounts',
    {
      schema: { ...accountsSchema, ...routeDocs(CONSOLE_DOCS.accounts) },
      preHandler: admin('wallet.view'),
    },
    async (req) => paginated(await svc(req).accounts(req.query)),
  );

  app.get<{ Params: { userId: string } }>(
    '/accounts/:userId',
    {
      schema: { ...accountSchema, ...routeDocs(CONSOLE_DOCS.account) },
      preHandler: admin('wallet.view'),
    },
    async (req) => ok(await svc(req).account(req.params.userId)),
  );

  for (const [path, status, docs] of [
    ['/accounts/:userId/freeze', 'FROZEN', CONSOLE_DOCS.freeze],
    ['/accounts/:userId/unfreeze', 'ACTIVE', CONSOLE_DOCS.unfreeze],
  ] as const)
    app.post<{ Params: { userId: string }; Body: { reason: string } }>(
      path,
      { schema: { ...freezeSchema, ...routeDocs(docs) }, preHandler: adminWrite('wallet.adjust') },
      async (req) =>
        ok(await svc(req).setStatus(actorOf(req), req.params.userId, status, req.body.reason)),
    );

  app.get<{ Querystring: JournalFilter }>(
    '/journals',
    {
      schema: { ...journalsSchema, ...routeDocs(CONSOLE_DOCS.journals) },
      preHandler: admin('wallet.view'),
    },
    async (req) => paginated(await svc(req).journals(req.query)),
  );

  app.get(
    '/settings',
    { schema: { ...routeDocs(CONSOLE_DOCS.settings) }, preHandler: admin('wallet.view') },
    async (req) => ok(await svc(req).settings()),
  );

  app.put<{ Params: { key: string }; Body: { value: unknown; reason: string } }>(
    '/settings/:key',
    {
      schema: { ...settingSchema, ...routeDocs(CONSOLE_DOCS.setSetting) },
      preHandler: adminWrite('wallet.configure'),
    },
    async (req) => {
      const actor = actorOf(req);
      if (actor.userId === null) throw new UnauthorizedError();
      return ok(
        await svc(req).setSetting(
          { ...actor, userId: actor.userId },
          req.params.key,
          req.body.value,
          req.body.reason,
        ),
      );
    },
  );
};
