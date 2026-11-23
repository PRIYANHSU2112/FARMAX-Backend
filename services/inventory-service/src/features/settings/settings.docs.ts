import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, ok } from '../../docs/shared.js';

export const ADMIN_SETTINGS_TAG = 'Admin Inventory Settings';

const settingsSchema = Joi.object({
  reservationTtlSeconds: Joi.number()
    .integer()
    .example(600)
    .description('ACTIVE reservations hold stock this long (60–3600 s)'),
  defaultReorderLevel: Joi.number()
    .integer()
    .example(0)
    .description('reorderLevel of a new warehouse × variant row (0 = no low-stock alerts)'),
  maxReservationLines: Joi.number().integer().example(50),
  allowSplitAllocation: Joi.boolean()
    .example(true)
    .description('Serve one order from several warehouses (a variant may be split, e.g. 5 + 7)'),
  updatedAt: Joi.date().iso().allow(null),
}).meta({ className: 'InventorySettings' });

const example = {
  reservationTtlSeconds: 600,
  defaultReorderLevel: 0,
  maxReservationLines: 50,
  allowSplitAllocation: true,
  updatedAt: '2026-11-20T09:00:00.000Z',
};

export const SETTINGS_DOCS = {
  get: {
    tag: ADMIN_SETTINGS_TAG,
    summary: 'Get inventory settings',
    auth: AUTH_ADMIN,
    permission: 'inventory.view',
    success: { status: 200, description: 'Settings', data: settingsSchema, example: ok(example) },
  },
  update: {
    tag: ADMIN_SETTINGS_TAG,
    summary: 'Change inventory settings',
    description:
      'Send only the keys to change, plus a `reason` (10–500 chars). Audited (before / after). Every instance picks the new values up within 15 s; a new TTL applies to reservations created after that.',
    auth: AUTH_ADMIN,
    permission: 'inventory.configure',
    rateLimit: '60 writes per user per minute',
    requestExample: {
      reservationTtlSeconds: 900,
      reason: 'Festival rush: slower UPI confirmations',
    },
    success: {
      status: 200,
      description: 'Updated settings',
      data: settingsSchema,
      example: ok({ ...example, reservationTtlSeconds: 900 }),
    },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
