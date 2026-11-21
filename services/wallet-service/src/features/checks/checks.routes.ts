import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import Joi from 'joi';
import type { FastifyPluginAsync } from 'fastify';

import { AUTH_ADMIN, ok as okDoc } from '../../docs/shared.js';
import { admin, adminWrite } from '../../middleware/guards.js';
import { PAGE } from '../../middleware/http.js';
import { ADMIN_WALLET_TAG } from '../adjustments/index.js';

const checkSchema = Joi.object({
  id: Joi.string().guid(),
  checkType: Joi.string().valid(
    'WALLET_BALANCE',
    'WALLET_JOURNAL',
    'WALLET_TOTAL',
    'POINTS_BUCKETS',
    'POINTS_LOTS',
    'TOPUP_CREDIT',
  ),
  refId: Joi.string(),
  userId: Joi.string().guid().allow(null),
  expected: Joi.string().allow(null),
  actual: Joi.string().allow(null),
  status: Joi.string().valid('OPEN', 'RESOLVED'),
  detectedAt: Joi.date().iso(),
  lastSeenAt: Joi.date().iso(),
  resolvedAt: Joi.date().iso().allow(null),
}).meta({ className: 'WalletLedgerCheck' });

const LIST_DOCS = {
  tag: ADMIN_WALLET_TAG,
  summary: 'Ledger reconciliation findings',
  description:
    'Findings of the 15-minute ledger check (empty = the ledgers reconcile). `status` OPEN = still seen in the last run.',
  auth: AUTH_ADMIN,
  permission: 'wallet.view',
  success: {
    status: 200 as const,
    description: 'A page of findings',
    data: checkSchema,
    paginated: true,
  },
  errors: [422 as const],
};

const RUN_DOCS = {
  tag: ADMIN_WALLET_TAG,
  summary: 'Run the ledger check now',
  description: 'Same as the scheduled job; read-only on the ledgers. Returns the counts.',
  auth: AUTH_ADMIN,
  permission: 'wallet.view',
  rateLimit: '60 writes per user per minute',
  success: {
    status: 200 as const,
    description: 'Counts',
    data: Joi.object({ open: Joi.number().integer(), resolved: Joi.number().integer() }),
    example: okDoc({ open: 0, resolved: 0 }),
  },
};

/** Mounted at `/admin/wallet/ledger-checks`. */
export const checksRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { status?: string; cursor?: string; limit: number } }>(
    '/',
    {
      schema: {
        querystring: Joi.object({ ...PAGE, status: Joi.string().valid('OPEN', 'RESOLVED') }),
        ...routeDocs(LIST_DOCS),
      },
      preHandler: admin('wallet.view'),
    },
    async (req) => paginated(await req.diScope.resolve('checksService').list(req.query)),
  );
  app.post(
    '/run',
    { schema: { ...routeDocs(RUN_DOCS) }, preHandler: adminWrite('wallet.view') },
    async (req) => ok(await req.diScope.resolve('checksService').run()),
  );
};
