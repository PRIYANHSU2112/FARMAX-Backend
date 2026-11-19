import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, IDS, ok } from '../../docs/shared.js';
import { RESERVATION_STATUSES } from './reservations.validation.js';

export const ADMIN_RESERVATIONS_TAG = 'Admin Reservations';

const reservationSchema = Joi.object({
  id: Joi.string().guid(),
  orderRef: Joi.string().description('order-service order id'),
  status: Joi.string()
    .valid(...RESERVATION_STATUSES)
    .description(
      'ACTIVE (payment window) → COMMITTED (paid; no expiry) → ISSUED (dispatched); RELEASED, EXPIRED, REJECTED (late payment, stock gone)',
    ),
  pinCode: Joi.string(),
  expiresAt: Joi.date().iso().description('Only meaningful while ACTIVE'),
  paymentRef: Joi.string().allow(null),
  committedAt: Joi.date().iso().allow(null),
  recoveredFromExpiry: Joi.boolean(),
  expiredAt: Joi.date().iso().allow(null),
  rejectedAt: Joi.date().iso().allow(null),
  issuedAt: Joi.date().iso().allow(null),
  releasedAt: Joi.date().iso().allow(null),
  releaseReason: Joi.string().allow(null),
  releasedByUserId: Joi.string().guid().allow(null),
  version: Joi.number().integer(),
  createdAt: Joi.date().iso(),
  lines: Joi.array().items(
    Joi.object({
      warehouseId: Joi.string().guid(),
      variantId: Joi.string().guid(),
      qty: Joi.number().integer(),
      releasedQty: Joi.number().integer(),
      issuedQty: Joi.number().integer(),
      heldQty: Joi.number().integer().description('Units held now (0 unless ACTIVE / COMMITTED)'),
    }),
  ),
}).meta({ className: 'StockReservation' });

const example = {
  id: IDS.reservation,
  orderRef: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9f01',
  status: 'COMMITTED',
  pinCode: '534211',
  expiresAt: '2026-11-21T09:30:00.000Z',
  paymentRef: 'pay_0193a5f2',
  committedAt: '2026-11-21T09:04:12.000Z',
  recoveredFromExpiry: false,
  expiredAt: null,
  rejectedAt: null,
  issuedAt: null,
  releasedAt: null,
  releaseReason: null,
  releasedByUserId: null,
  version: 1,
  createdAt: '2026-11-21T09:00:00.000Z',
  lines: [
    { warehouseId: IDS.warehouse, variantId: IDS.variant, qty: 5, releasedQty: 0, issuedQty: 0, heldQty: 5 },
    { warehouseId: IDS.depot, variantId: IDS.variant, qty: 7, releasedQty: 0, issuedQty: 0, heldQty: 7 },
  ],
};

export const RESERVATION_DOCS = {
  list: {
    tag: ADMIN_RESERVATIONS_TAG,
    summary: 'List reservations',
    description: 'Newest first. Filters: `status`, `orderRef`.',
    auth: AUTH_ADMIN,
    permission: 'inventory.view',
    success: {
      status: 200,
      description: 'A page of reservations',
      data: reservationSchema,
      paginated: true,
      example: { success: true, data: [example], meta: { nextCursor: null, limit: 20 } },
    },
    errors: [422],
  },
  get: {
    tag: ADMIN_RESERVATIONS_TAG,
    summary: 'Get a reservation',
    description: 'One variant may be split across warehouses (several lines, e.g. 5 + 7).',
    auth: AUTH_ADMIN,
    permission: 'inventory.view',
    success: { status: 200, description: 'Reservation', data: reservationSchema, example: ok(example) },
    errors: [404, 422],
  },
  release: {
    tag: ADMIN_RESERVATIONS_TAG,
    summary: 'Force-release a reservation',
    description:
      'For stuck orders and data repair: gives all held units back (ACTIVE / COMMITTED) or closes an EXPIRED one, and emits `inventory.reservation_released.v1`. Normally stock is released by order events (reject / cancel / fail). `reason` required; audited.',
    auth: AUTH_ADMIN,
    permission: 'inventory.adjust',
    rateLimit: '60 writes per user per minute',
    requestExample: { reason: 'Order cancelled by phone; event lost during an outage' },
    success: {
      status: 200,
      description: 'Released',
      data: reservationSchema,
      example: ok({ ...example, status: 'RELEASED', releasedAt: '2026-11-21T11:00:00.000Z' }),
    },
    errors: [404, 409, 422],
  },
} satisfies Record<string, RouteDocs>;
