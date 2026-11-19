import { ok, paginated } from '@farmx/common/response';
import { type RouteDocs, routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import Joi from 'joi';

import { AUTH_ADMIN, IDS } from '../../docs/shared.js';
import { admin, rateLimit } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import { SETTING_RULES, type SettingsPatch } from '../settings/index.js';
import type { AdminOrderQuery, CancelInput, ExceptionType } from './orders.types.js';
import {
  REJECT_REASONS,
  STAFF_CANCEL_REASONS,
  adminCancelSchema,
  adminListSchema,
  bulkConfirmSchema,
  confirmSchema,
  exceptionsSchema,
  noteSchema,
  orderIdSchema,
  quoteSchema,
  refundOfflineSchema,
  refundRetrySchema,
  rejectSchema,
} from './orders.validation.js';

export const ADMIN_ORDERS_TAG = 'Admin Orders';

const WRITE = '60 writes per user per minute';
const VERSION_NOTE = '`expectedVersion` from the last read is required (stale → 409 VERSION_CONFLICT).';
const doc = (d: Omit<RouteDocs, 'tag' | 'auth'> & { permission: string }): RouteDocs => ({
  tag: ADMIN_ORDERS_TAG,
  auth: AUTH_ADMIN,
  ...d,
});

const DOCS = {
  list: doc({
    summary: 'Search orders',
    description:
      'Newest first. Filters: `status`, `paymentStatus`, `stockStatus`, `refundStatus`, `orderNo` (prefix), `farmId`, `userId`, `placedFrom` / `placedTo`.',
    permission: 'orders.view',
    success: { status: 200, description: 'A page of orders', paginated: true },
    errors: [422],
  }),
  queue: doc({
    summary: 'Review queue',
    description:
      'Orders awaiting confirmation that are PAID with stock COMMITTED, oldest payment first, with `waitingMinutes` and `overdue` (review SLA). Orders with a payment exception appear here but cannot be confirmed (reject them).',
    permission: 'orders.view',
    success: { status: 200, description: 'Queue' },
  }),
  stats: doc({
    summary: 'Order dashboard counters',
    description: 'Awaiting payment / review, overdue reviews, today’s placed / confirmed / rejected / cancelled / failed, net GMV, refunds needing action. Cached 30 s.',
    permission: 'orders.view',
    success: { status: 200, description: 'Counters' },
  }),
  exceptions: doc({
    summary: 'Recovery work queues',
    description:
      '`refund_failed` (refund needs a person), `stock_release_pending` (release not confirmed after 15 min), `amount_mismatch` (captured ≠ total), `late_payment` (money taken on a closed order, refund in progress).',
    permission: 'orders.view',
    success: { status: 200, description: 'Orders' },
    errors: [422],
  }),
  get: doc({
    summary: 'Order detail (staff)',
    description: 'Everything the buyer sees plus ids, version, notes and the full history with WHO did each change.',
    permission: 'orders.view',
    success: { status: 200, description: 'Order' },
    errors: [404, 422],
  }),
  confirm: doc({
    summary: 'Confirm an order',
    description: `Allowed only when PENDING_ADMIN_CONFIRMATION, payment PAID, stock COMMITTED and no payment exception (else 409 with \`reason\`: NOT_PENDING · NOT_PAID · STOCK_NOT_COMMITTED · PAYMENT_EXCEPTION). Emits \`order.confirmed.v1\`. ${VERSION_NOTE} Audited.`,
    permission: 'orders.confirm',
    rateLimit: WRITE,
    requestExample: { expectedVersion: 3, note: 'Verified farm and vaccine schedule' },
    success: { status: 200, description: 'Confirmed order' },
    errors: [404, 409, 422],
  }),
  reject: doc({
    summary: 'Reject an order',
    description: `Only while awaiting confirmation. Offers are given back, stock released, and everything paid is refunded automatically (\`order.refund_requested.v1\`). \`reasonCode\`: ${REJECT_REASONS.join(' · ')}. ${VERSION_NOTE} Audited.`,
    permission: 'orders.confirm',
    rateLimit: WRITE,
    requestExample: { expectedVersion: 3, reasonCode: 'OUT_OF_STOCK_PHYSICAL', reason: 'Cold room failure at Tanuku C&F' },
    success: { status: 200, description: 'Rejected order' },
    errors: [404, 409, 422],
  }),
  bulk: doc({
    summary: 'Confirm many orders',
    description: 'Each order is confirmed in its own transaction (one failure never blocks the others); the result lists every order with `ok` / `reason`.',
    permission: 'orders.confirm',
    rateLimit: WRITE,
    requestExample: { orderIds: [IDS.order] },
    success: { status: 200, description: 'Per-order results' },
    errors: [422],
  }),
  quote: doc({
    summary: 'Cancellation preview (staff)',
    description: 'What a staff cancel would release and refund now (no fee for staff cancellations). Nothing changes.',
    permission: 'orders.cancel',
    success: { status: 200, description: 'Quote' },
    errors: [404, 422],
  }),
  cancel: doc({
    summary: 'Cancel an order or some of its items',
    description: `Whole order (no \`lines\`) or per item (\`lines\`: variantId + qty). Released stock and refunds follow automatically; staff refunds above the approval threshold wait for a second approver in payment-service. \`reasonCode\`: ${STAFF_CANCEL_REASONS.join(' · ')}; \`note\` required. ${VERSION_NOTE} Audited.`,
    permission: 'orders.cancel',
    rateLimit: WRITE,
    requestExample: { expectedVersion: 4, reasonCode: 'CUSTOMER_REQUEST', note: 'Farmer called: flock placement postponed' },
    success: { status: 200, description: 'Order after cancellation' },
    errors: [404, 409, 422],
  }),
  notes: doc({ summary: 'Internal notes', permission: 'orders.view', success: { status: 200, description: 'Notes, oldest first' }, errors: [404, 422] }),
  addNote: doc({
    summary: 'Add an internal note',
    description: 'Staff-only, append-only (never shown to the buyer).',
    permission: 'orders.update',
    rateLimit: WRITE,
    requestExample: { body: 'Called the farmer; confirmed delivery address' },
    success: { status: 201, description: 'Note' },
    errors: [404, 422],
  }),
  refundRetry: doc({
    summary: 'Retry a failed refund',
    description: 'FAILED → RETRY_REQUESTED: the same decision (same `sourceRef`) is sent again; payment-service retries the same refund, never a second one. `reason` required; audited.',
    permission: 'refunds.initiate',
    rateLimit: WRITE,
    success: { status: 200, description: 'Order' },
    errors: [404, 409, 422],
  }),
  refundOffline: doc({
    summary: 'Mark a failed refund as paid offline',
    description:
      'For money returned outside the gateway (bank transfer): FAILED → MANUALLY_RESOLVED with the bank reference; the order’s refunded amount and payment status are updated. **Segregation of duties:** not by the person who requested the refund (403). Audited.',
    permission: 'refunds.approve',
    rateLimit: WRITE,
    requestExample: { reason: 'Bank closed the UPI account; paid by NEFT', bankReference: 'NEFT-SBIN-2611-88231' },
    success: { status: 200, description: 'Order' },
    errors: [404, 409, 422],
  }),
  settings: doc({
    summary: 'Order settings',
    permission: 'orders.view',
    success: { status: 200, description: 'Settings' },
  }),
  updateSettings: doc({
    summary: 'Change order settings',
    description:
      'Payment window (5–55 min), grace (30–300 s), max lines, review SLA (h), auto-reject after (h, 0 = never), free-cancel minutes, cancellation fee %, max bulk confirm. Send only the keys to change + `reason`. Live on every instance within 15 s; audited.',
    permission: 'orders.configure',
    rateLimit: WRITE,
    requestExample: { adminReviewSlaHours: 2, reason: 'Festival rush: tighter review SLA' },
    success: { status: 200, description: 'Settings' },
    errors: [422],
  }),
} satisfies Record<string, RouteDocs>;

const settingsSchema = {
  body: Joi.object({ ...SETTING_RULES, reason: Joi.string().trim().min(10).max(500).required() })
    .or(...Object.keys(SETTING_RULES))
    .messages({ 'object.missing': 'change at least one setting' }),
};

interface IdParams {
  id: string;
}
interface RefundParams {
  id: string;
  refundId: string;
}

const svc = (req: FastifyRequest) => req.diScope.resolve('ordersAdminService');
const ctx = (req: FastifyRequest) => ({ correlationId: req.id });
const write = (permission: string) => [...admin(permission), rateLimit('admin-orders', 60, 60)];

/** Mounted at `/admin/orders` (gateway: `/v1/admin/orders`). INTERNAL staff + MFA + permission. */
export const ordersAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: AdminOrderQuery }>(
    '/',
    { schema: { ...adminListSchema, ...routeDocs(DOCS.list) }, preHandler: admin('orders.view') },
    async (req) => paginated(await svc(req).list(req.query)),
  );
  app.get('/review-queue', { schema: routeDocs(DOCS.queue), preHandler: admin('orders.view') }, async (req) =>
    ok(await svc(req).reviewQueue()),
  );
  app.get('/stats', { schema: routeDocs(DOCS.stats), preHandler: admin('orders.view') }, async (req) =>
    ok(await svc(req).stats()),
  );
  app.get<{ Querystring: { type: ExceptionType } }>(
    '/exceptions',
    { schema: { ...exceptionsSchema, ...routeDocs(DOCS.exceptions) }, preHandler: admin('orders.view') },
    async (req) => ok(await svc(req).exceptions(req.query.type)),
  );
  app.get('/settings', { schema: routeDocs(DOCS.settings), preHandler: admin('orders.view') }, async (req) =>
    ok(await svc(req).settings()),
  );
  app.patch<{ Body: SettingsPatch }>(
    '/settings',
    { schema: { ...settingsSchema, ...routeDocs(DOCS.updateSettings) }, preHandler: write('orders.configure') },
    async (req) => ok(await svc(req).updateSettings(actorOf(req), req.body)),
  );
  app.post<{ Body: { orderIds: string[] } }>(
    '/bulk-confirm',
    { schema: { ...bulkConfirmSchema, ...routeDocs(DOCS.bulk) }, preHandler: write('orders.confirm') },
    async (req) => ok(await svc(req).bulkConfirm(actorOf(req), req.body.orderIds, ctx(req))),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { ...orderIdSchema, ...routeDocs(DOCS.get) }, preHandler: admin('orders.view') },
    async (req) => ok(await svc(req).detail(req.params.id)),
  );
  app.post<{ Params: IdParams; Body: { expectedVersion: number; note?: string } }>(
    '/:id/confirm',
    { schema: { ...confirmSchema, ...routeDocs(DOCS.confirm) }, preHandler: write('orders.confirm') },
    async (req) => ok(await svc(req).confirm(actorOf(req), req.params.id, req.body, ctx(req))),
  );
  app.post<{ Params: IdParams; Body: { expectedVersion: number; reasonCode: string; reason: string } }>(
    '/:id/reject',
    { schema: { ...rejectSchema, ...routeDocs(DOCS.reject) }, preHandler: write('orders.confirm') },
    async (req) => ok(await svc(req).reject(actorOf(req), req.params.id, req.body, ctx(req))),
  );
  app.post<{ Params: IdParams; Body: Pick<CancelInput, 'lines'> }>(
    '/:id/cancellation-quote',
    { schema: { ...quoteSchema, ...routeDocs(DOCS.quote) }, preHandler: admin('orders.cancel') },
    async (req) => ok(await svc(req).quoteCancel(req.params.id, req.body.lines, actorOf(req))),
  );
  app.post<{ Params: IdParams; Body: CancelInput & { expectedVersion: number } }>(
    '/:id/cancel',
    { schema: { ...adminCancelSchema, ...routeDocs(DOCS.cancel) }, preHandler: write('orders.cancel') },
    async (req) => ok(await svc(req).cancel(actorOf(req), req.params.id, req.body, ctx(req))),
  );
  app.get<{ Params: IdParams }>(
    '/:id/notes',
    { schema: { ...orderIdSchema, ...routeDocs(DOCS.notes) }, preHandler: admin('orders.view') },
    async (req) => ok(await svc(req).notes(req.params.id)),
  );
  app.post<{ Params: IdParams; Body: { body: string } }>(
    '/:id/notes',
    { schema: { ...noteSchema, ...routeDocs(DOCS.addNote) }, preHandler: write('orders.update') },
    async (req, reply) => reply.code(201).send(ok(await svc(req).addNote(actorOf(req), req.params.id, req.body.body))),
  );
  app.post<{ Params: RefundParams; Body: { reason: string } }>(
    '/:id/refunds/:refundId/retry',
    { schema: { ...refundRetrySchema, ...routeDocs(DOCS.refundRetry) }, preHandler: write('refunds.initiate') },
    async (req) =>
      ok(await svc(req).retryRefund(actorOf(req), req.params.id, req.params.refundId, req.body.reason, ctx(req))),
  );
  app.post<{ Params: RefundParams; Body: { reason: string; bankReference: string } }>(
    '/:id/refunds/:refundId/resolve-offline',
    { schema: { ...refundOfflineSchema, ...routeDocs(DOCS.refundOffline) }, preHandler: write('refunds.approve') },
    async (req) => ok(await svc(req).resolveOffline(actorOf(req), req.params.id, req.params.refundId, req.body)),
  );
};
