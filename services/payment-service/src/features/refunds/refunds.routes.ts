import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { RouteDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import Joi from 'joi';

import { AUTH_ADMIN, IDS, ok as okDoc } from '../../docs/shared.js';
import { admin, adminWrite } from '../../middleware/guards.js';
import { ID, PAGE, REASON, idParams } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import type { DecisionInput, RefundListQuery } from './refunds.types.js';

export const ADMIN_REFUNDS_TAG = 'Admin Refunds';

const STATUSES = [
  'CREATED',
  'PENDING_APPROVAL',
  'APPROVED',
  'PROCESSING',
  'RETRYING',
  'PROCESSED',
  'FAILED_FINAL',
] as const;

const refundSchema = Joi.object({
  id: Joi.string().guid(),
  refundNo: Joi.string().example('RF-261121-7C1E2B9A'),
  paymentId: Joi.string().guid(),
  orderId: Joi.string().guid(),
  sourceRef: Joi.string().example('reject:0193a5f2-…').description('order-service decision key'),
  amountPaise: Joi.number().integer(),
  amount: Joi.string().example('8960.00'),
  reason: Joi.string(),
  isSystem: Joi.boolean(),
  status: Joi.string()
    .valid(...STATUSES)
    .description(
      'APPROVED → PROCESSING (gateway accepted) → PROCESSED; RETRYING with backoff 1 m … 24 h; FAILED_FINAL needs a person (retry)',
    ),
  requestedBy: Joi.string().guid().allow(null),
  approvedBy: Joi.string().guid().allow(null),
  providerRefundId: Joi.string().allow(null),
  arn: Joi.string().allow(null).description('Bank reference once processed'),
  attempts: Joi.number().integer(),
  nextRetryAt: Joi.date().iso().allow(null),
  lastError: Joi.string().allow(null),
  initiatedAt: Joi.date().iso().allow(null),
  expectedBy: Joi.date().iso().allow(null),
  processedAt: Joi.date().iso().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'Refund' });

const DOCS = {
  list: {
    tag: ADMIN_REFUNDS_TAG,
    summary: 'List refunds',
    description: 'Newest first. Filters: `status` (e.g. FAILED_FINAL, PENDING_APPROVAL), `orderId`.',
    auth: AUTH_ADMIN,
    permission: 'payments.view',
    success: { status: 200, description: 'A page of refunds', data: refundSchema, paginated: true },
    errors: [422],
  },
  get: {
    tag: ADMIN_REFUNDS_TAG,
    summary: 'Get a refund',
    auth: AUTH_ADMIN,
    permission: 'payments.view',
    success: { status: 200, description: 'Refund', data: refundSchema },
    errors: [404, 422],
  },
  approve: {
    tag: ADMIN_REFUNDS_TAG,
    summary: 'Approve a large manual refund',
    description:
      'Only PENDING_APPROVAL refunds (manual decisions above the approval threshold). **Segregation of duties:** the approver must not be the person who requested it (403). `reason` required; audited.',
    auth: AUTH_ADMIN,
    permission: 'refunds.approve',
    rateLimit: '60 writes per user per minute',
    requestExample: { reason: 'Verified the return QC report RT-26-00418' },
    success: {
      status: 200,
      description: 'Approved (sent to the gateway within seconds)',
      data: refundSchema,
      example: okDoc({ id: IDS.refund, status: 'APPROVED' }),
    },
    errors: [404, 409, 422],
  },
  retry: {
    tag: ADMIN_REFUNDS_TAG,
    summary: 'Retry a failed refund',
    description:
      'FAILED_FINAL → RETRYING. The same refund (same `sourceRef`) is sent again; if the gateway already has it, it is adopted, so money is never refunded twice. `reason` required; audited.',
    auth: AUTH_ADMIN,
    permission: 'refunds.initiate',
    rateLimit: '60 writes per user per minute',
    requestExample: { reason: 'Bank outage resolved; retrying' },
    success: { status: 200, description: 'Queued for retry', data: refundSchema },
    errors: [404, 409, 422],
  },
} satisfies Record<string, RouteDocs>;

const decision = { ...idParams, body: Joi.object({ reason: REASON.required() }) };
const listSchema = {
  querystring: Joi.object({ ...PAGE, status: Joi.string().valid(...STATUSES), orderId: ID }),
};

interface IdParams {
  id: string;
}
const svc = (req: FastifyRequest) => req.diScope.resolve('refundsService');

/** Mounted at `/admin/refunds` (gateway: `/v1/admin/refunds`). Staff only. */
export const refundsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: RefundListQuery }>(
    '/',
    { schema: { ...listSchema, ...routeDocs(DOCS.list) }, preHandler: admin('payments.view') },
    async (req) => paginated(await svc(req).list(req.query)),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { ...idParams, ...routeDocs(DOCS.get) }, preHandler: admin('payments.view') },
    async (req) => ok(await svc(req).get(req.params.id)),
  );
  app.post<{ Params: IdParams; Body: DecisionInput }>(
    '/:id/approve',
    { schema: { ...decision, ...routeDocs(DOCS.approve) }, preHandler: adminWrite('refunds.approve') },
    async (req) => ok(await svc(req).approve(actorOf(req), req.params.id, req.body)),
  );
  app.post<{ Params: IdParams; Body: DecisionInput }>(
    '/:id/retry',
    { schema: { ...decision, ...routeDocs(DOCS.retry) }, preHandler: adminWrite('refunds.initiate') },
    async (req) => ok(await svc(req).retry(actorOf(req), req.params.id, req.body)),
  );
};
