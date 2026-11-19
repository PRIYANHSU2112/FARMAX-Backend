import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, IDS, IF_VERSION, ok } from '../../docs/shared.js';
import { MAX_COVERAGE, WAREHOUSE_TYPES } from './warehouses.validation.js';

export const ADMIN_WAREHOUSES_TAG = 'Admin Warehouses';

const warehouseSchema = Joi.object({
  id: Joi.string().guid(),
  code: Joi.string().example('RJY-MW').description('UPPERCASE, unique, immutable'),
  name: Joi.string().example('Rajahmundry Mother Warehouse'),
  type: Joi.string().valid(...WAREHOUSE_TYPES),
  addressLine: Joi.string(),
  city: Joi.string(),
  stateCode: Joi.string().example('37').description('2-digit GST state code'),
  pinCode: Joi.string().example('533101'),
  isActive: Joi.boolean().description('Inactive: no stock movements, never allocated'),
  isAllocatable: Joi.boolean().description(
    'Counted in network availability and offered to reservations',
  ),
  hasColdChain: Joi.boolean().description(
    'Stores and ships 2–8 °C / frozen stock; cold-chain variants are allocated only here',
  ),
  priority: Joi.number()
    .integer()
    .example(100)
    .description('Lower = preferred when coverage priorities tie'),
  statusReason: Joi.string().allow(null),
  version: Joi.number().integer().description('Send back as `expectedVersion`'),
  createdAt: Joi.date().iso(),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'Warehouse' });

const coverageSchema = Joi.object({
  warehouseId: Joi.string().guid(),
  version: Joi.number().integer(),
  entries: Joi.array().items(
    Joi.object({ pinCode: Joi.string().example('534101'), priority: Joi.number().integer() }),
  ),
}).meta({ className: 'WarehouseCoverage' });

const mother = {
  id: IDS.warehouse,
  code: 'RJY-MW',
  name: 'Rajahmundry Mother Warehouse',
  type: 'MOTHER',
  addressLine: 'Plot 12, Industrial Estate, Bommuru',
  city: 'Rajahmundry',
  stateCode: '37',
  pinCode: '533124',
  isActive: true,
  isAllocatable: true,
  hasColdChain: true,
  priority: 100,
  statusReason: null,
  version: 0,
  createdAt: '2026-11-20T09:00:00.000Z',
  updatedAt: '2026-11-20T09:00:00.000Z',
};

const versionConflict = {
  message: 'The warehouse was changed by someone else; reload and retry',
  details: { reason: 'VERSION_CONFLICT', currentVersion: 3 },
};

export const WAREHOUSE_DOCS = {
  list: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'List warehouses',
    description: 'Filters: `isActive`, `type`, `q` (code or name prefix). Cursor pagination.',
    auth: AUTH_ADMIN,
    permission: 'inventory.view',
    success: {
      status: 200,
      description: 'A page of warehouses',
      data: warehouseSchema,
      paginated: true,
      example: { success: true, data: [mother], meta: { nextCursor: null, limit: 20 } },
    },
    errors: [422],
  },
  get: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Get a warehouse',
    auth: AUTH_ADMIN,
    permission: 'inventory.view',
    success: { status: 200, description: 'Warehouse', data: warehouseSchema, example: ok(mother) },
    errors: [404, 422],
  },
  create: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Create a warehouse',
    description:
      'A mother warehouse or a C&F depot. `code` is stored UPPERCASE and cannot change later. It serves no PIN codes until coverage is set (`PUT /{id}/coverage`). Audited.',
    auth: AUTH_ADMIN,
    permission: 'inventory.configure',
    rateLimit: '60 writes per user per minute',
    requestExample: {
      code: 'RJY-MW',
      name: 'Rajahmundry Mother Warehouse',
      type: 'MOTHER',
      addressLine: 'Plot 12, Industrial Estate, Bommuru',
      city: 'Rajahmundry',
      stateCode: '37',
      pinCode: '533124',
      priority: 100,
    },
    success: { status: 201, description: 'Created', data: warehouseSchema, example: ok(mother) },
    errors: [409, 422],
    errorExamples: { 409: { message: 'code already exists', details: { fields: ['code'] } } },
  },
  update: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Edit a warehouse',
    description: `Any field except \`code\`; optional \`reason\`. ${IF_VERSION} Audited (changed fields only).`,
    auth: AUTH_ADMIN,
    permission: 'inventory.configure',
    rateLimit: '60 writes per user per minute',
    requestExample: { expectedVersion: 0, priority: 50, reason: 'Primary node for Godavari belt' },
    success: {
      status: 200,
      description: 'Updated',
      data: warehouseSchema,
      example: ok({ ...mother, priority: 50, version: 1 }),
    },
    errors: [404, 409, 422],
    errorExamples: { 409: versionConflict },
  },
  status: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Activate or deactivate a warehouse',
    description: `Deactivating stops new receipts / damage / adjustments there and removes it from allocation at once. Existing reservations stay valid. \`reason\` required. ${IF_VERSION}`,
    auth: AUTH_ADMIN,
    permission: 'inventory.configure',
    rateLimit: '60 writes per user per minute',
    requestExample: { expectedVersion: 1, isActive: false, reason: 'Flooded — closed until audit' },
    success: {
      status: 200,
      description: 'Updated',
      data: warehouseSchema,
      example: ok({ ...mother, isActive: false, version: 2 }),
    },
    errors: [404, 409, 422],
  },
  getCoverage: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'PIN codes a warehouse serves',
    description: 'Lower `priority` = tried first for that PIN.',
    auth: AUTH_ADMIN,
    permission: 'inventory.view',
    success: {
      status: 200,
      description: 'Coverage',
      data: coverageSchema,
      example: ok({
        warehouseId: IDS.warehouse,
        version: 1,
        entries: [
          { pinCode: '533101', priority: 10 },
          { pinCode: '534101', priority: 20 },
        ],
      }),
    },
    errors: [404, 422],
  },
  putCoverage: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Replace the PIN codes a warehouse serves',
    description: `Replaces the whole list (max ${String(MAX_COVERAGE)}, unique PINs; \`priority\` 1–10000, default 100). An empty list removes the warehouse from allocation everywhere. Allocation sees the change immediately. \`reason\` required. ${IF_VERSION}`,
    auth: AUTH_ADMIN,
    permission: 'inventory.configure',
    rateLimit: '60 writes per user per minute',
    requestExample: {
      expectedVersion: 0,
      entries: [
        { pinCode: '533101', priority: 10 },
        { pinCode: '534101', priority: 20 },
      ],
      reason: 'Initial East Godavari coverage',
    },
    success: {
      status: 200,
      description: 'New coverage (warehouse version bumped)',
      data: coverageSchema,
    },
    errors: [404, 409, 422],
    errorExamples: { 409: versionConflict },
  },
} satisfies Record<string, RouteDocs>;
