import { UnauthorizedError } from '@farmx/common/errors';
import { type RouteDocs, routeDocs } from '@farmx/common/server';
import Joi from 'joi';
import type { FastifyPluginAsync } from 'fastify';

import { AUTH_CUSTOMER } from '../../docs/shared.js';
import { customerWrite } from '../../middleware/guards.js';
import { WALLET_TAG } from '../ledger/index.js';
import type { StatementQuery } from './statements.service.js';

const DAY = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .messages({
    'string.pattern.base': 'must be a date YYYY-MM-DD',
  });

const schema = {
  querystring: Joi.object({
    ledger: Joi.string().valid('WALLET', 'POINTS').default('WALLET'),
    from: DAY,
    to: DAY,
  }),
};

const DOCS: RouteDocs = {
  tag: WALLET_TAG,
  summary: '"Download statement" (PDF)',
  description:
    'Returns **`application/pdf`** (attachment), not JSON. `ledger`: WALLET (Wallet Statement) or POINTS (Points Ledger). `from` / `to`: IST dates, inclusive (default: the last 30 days). Opening and closing balance, every movement with its reference number, Indian number format. 422 `BAD_RANGE` · `RANGE_TOO_LONG` (> 366 days) · `TOO_MANY_ROWS` (> 2,000 entries: choose a shorter range).',
  auth: AUTH_CUSTOMER,
  rateLimit: '5 per user per minute',
  success: {
    status: 200,
    description: 'The PDF file',
    headers: {
      'Content-Type': { description: 'application/pdf', schema: { type: 'string' } },
      'Content-Disposition': {
        description: 'attachment; filename="farmx-wallet-statement-2026-10-01_2026-10-31.pdf"',
        schema: { type: 'string' },
      },
    },
  },
  errors: [422],
};

/** Mounted at `/wallet/statement` (gateway: `/v1/wallet/statement`). Own ledgers only. */
export const statementsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: StatementQuery }>(
    '/',
    { schema: { ...schema, ...routeDocs(DOCS) }, preHandler: customerWrite('statement', 5) },
    async (req, reply) => {
      if (req.user === null) throw new UnauthorizedError();
      const { file, filename } = await req.diScope
        .resolve('statementsService')
        .pdf(req.user.id, req.query);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('cache-control', 'private, no-store')
        .send(file);
    },
  );
};
