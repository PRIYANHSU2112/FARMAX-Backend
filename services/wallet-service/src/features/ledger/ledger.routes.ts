import { UnauthorizedError } from '@farmx/common/errors';
import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { customerRead } from '../../middleware/guards.js';
import { LEDGER_DOCS } from './ledger.docs.js';
import type { WalletCategory } from './ledger.types.js';
import {
  transactionCountsSchema,
  transactionSchema,
  transactionsSchema,
} from './ledger.validation.js';

interface TxQuery {
  category?: WalletCategory;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

/** Mounted at `/wallet` (gateway: `/v1/wallet`). Customers, own wallet only. */
export const ledgerRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    { schema: { ...routeDocs(LEDGER_DOCS.balance) }, preHandler: customerRead },
    async (req) => {
      if (req.user === null) throw new UnauthorizedError();
      return ok(await req.diScope.resolve('ledgerService').balanceOf(req.user.id));
    },
  );

  app.get<{ Querystring: TxQuery }>(
    '/transactions',
    {
      schema: { ...transactionsSchema, ...routeDocs(LEDGER_DOCS.transactions) },
      preHandler: customerRead,
    },
    async (req) => {
      if (req.user === null) throw new UnauthorizedError();
      return paginated(
        await req.diScope.resolve('ledgerService').transactions(req.user.id, req.query),
      );
    },
  );

  app.get<{ Querystring: { from?: Date; to?: Date } }>(
    '/transactions/summary',
    {
      schema: { ...transactionCountsSchema, ...routeDocs(LEDGER_DOCS.transactionCounts) },
      preHandler: customerRead,
    },
    async (req) => {
      if (req.user === null) throw new UnauthorizedError();
      return ok(
        await req.diScope.resolve('ledgerService').transactionCounts(req.user.id, req.query),
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    '/transactions/:id',
    {
      schema: { ...transactionSchema, ...routeDocs(LEDGER_DOCS.transaction) },
      preHandler: customerRead,
    },
    async (req) => {
      if (req.user === null) throw new UnauthorizedError();
      return ok(await req.diScope.resolve('ledgerService').transaction(req.user.id, req.params.id));
    },
  );
};
