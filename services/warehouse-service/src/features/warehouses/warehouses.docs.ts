import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_STAFF, IDS, IF_VERSION, ok } from '../../docs/shared.js';
import { TEMP_CLASSES, WAREHOUSE_STATUSES, WAREHOUSE_TYPES } from './warehouses.types.js';

export const ADMIN_WAREHOUSES_TAG = 'Admin Warehouses';

const manager = Joi.object({
  userId: Joi.string().guid(),
  fullName: Joi.string().allow(null),
  phone: Joi.string().allow(null),
  email: Joi.string().allow(null),
})
  .allow(null)
  .meta({ className: 'WarehouseManager' });

const step = Joi.object({
  key: Joi.string().valid('details', 'serviceArea', 'review'),
  done: Joi.boolean(),
  issues: Joi.array().items(Joi.string()),
}).meta({ className: 'WarehouseSetupStep' });

const warehouse = Joi.object({
  id: Joi.string().guid(),
  code: Joi.string().example('CW-PUN-01'),
  name: Joi.string().example('Central Warehouse'),
  type: Joi.string().valid(...WAREHOUSE_TYPES),
  status: Joi.string().valid(...WAREHOUSE_STATUSES),
  parentWarehouseId: Joi.string().guid().allow(null),
  managerUserId: Joi.string().guid().allow(null),
  manager,
  phone: Joi.string().allow(null).example('+919876543210'),
  email: Joi.string().allow(null),
  addressLine: Joi.string(),
  landmark: Joi.string().allow(null),
  city: Joi.string(),
  district: Joi.string().allow(null),
  stateCode: Joi.string().example('27'),
  stateName: Joi.string().allow(null).example('Maharashtra'),
  pinCode: Joi.string().example('411001'),
  latitude: Joi.string().allow(null),
  longitude: Joi.string().allow(null),
  totalAreaSqft: Joi.number().integer().allow(null),
  capacityKg: Joi.string().allow(null).example('100000.00'),
  temperatureClasses: Joi.array().items(Joi.string().valid(...TEMP_CLASSES)),
  isAllocatable: Joi.boolean(),
  priority: Joi.number().integer(),
  timezone: Joi.string(),
  statusReason: Joi.string().allow(null),
  statusChangedAt: Joi.date().iso().allow(null),
  activatedAt: Joi.date().iso().allow(null),
  importedAt: Joi.date().iso().allow(null).description('Copied from inventory (D-56 migration)'),
  reviewFields: Joi.array()
    .items(Joi.string())
    .description('Imported data still to confirm: drives the "Imported data to confirm" banner'),
  version: Joi.number().integer().description('Send back as expectedVersion'),
  coverageVersion: Joi.number()
    .integer()
    .description('Send back as expectedVersion on service-area writes'),
  setup: Joi.object({
    done: Joi.number().integer(),
    total: Joi.number().integer(),
    steps: Joi.array().items(step),
  }).description('Wizard progress and what is still missing before activation'),
  createdAt: Joi.date().iso(),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'Warehouse' });

const listItem = Joi.object({
  id: Joi.string().guid(),
  code: Joi.string(),
  name: Joi.string(),
  type: Joi.string().valid(...WAREHOUSE_TYPES),
  status: Joi.string().valid(...WAREHOUSE_STATUSES),
  city: Joi.string(),
  district: Joi.string().allow(null),
  stateCode: Joi.string(),
  stateName: Joi.string().allow(null),
  manager,
  capacityKg: Joi.string().allow(null),
  isAllocatable: Joi.boolean(),
  reviewPending: Joi.boolean(),
  setup: Joi.object({ done: Joi.number().integer(), total: Joi.number().integer() }),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'WarehouseListItem' });

const exampleWarehouse = {
  id: IDS.warehouse,
  code: 'CW-PUN-01',
  name: 'Central Warehouse',
  type: 'MOTHER',
  status: 'SETUP',
  parentWarehouseId: null,
  managerUserId: IDS.manager,
  manager: {
    userId: IDS.manager,
    fullName: 'Rakesh Sharma',
    phone: '+919876543210',
    email: null,
  },
  phone: '+919876543210',
  email: null,
  addressLine: 'Village Pataudi, NH-48',
  landmark: null,
  city: 'Pune',
  district: 'Pune',
  stateCode: '27',
  stateName: 'Maharashtra',
  pinCode: '411001',
  latitude: null,
  longitude: null,
  totalAreaSqft: 120000,
  capacityKg: '100000.00',
  temperatureClasses: ['AMB', 'CC_REF'],
  isAllocatable: true,
  priority: 100,
  timezone: 'Asia/Kolkata',
  statusReason: null,
  statusChangedAt: '2026-11-23T06:00:00.000Z',
  activatedAt: null,
  importedAt: null,
  reviewFields: [],
  version: 0,
  coverageVersion: 0,
  setup: {
    done: 2,
    total: 3,
    steps: [
      { key: 'details', done: true, issues: [] },
      {
        key: 'serviceArea',
        done: false,
        issues: ['Assign at least one district with PIN codes (orders are routed by PIN)'],
      },
      { key: 'review', done: true, issues: [] },
    ],
  },
  createdAt: '2026-11-23T06:00:00.000Z',
  updatedAt: '2026-11-23T06:00:00.000Z',
};

const one = { status: 200 as const, description: 'The warehouse', data: warehouse };

export const WAREHOUSE_DOCS = {
  list: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'All warehouses (W2.01 table)',
    description:
      'Warehouses the caller may see: GLOBAL viewers see all (drafts too); warehouse-scoped staff see their own (never drafts). Search matches code, name or city. Cursor pagination; `meta.total` gives "Showing 1–6 of 6". Stock and utilisation columns arrive with the stock snapshots (D-56 P3).',
    auth: AUTH_STAFF,
    permission: 'warehouse.view',
    success: {
      status: 200,
      description: 'A page of warehouses',
      data: listItem,
      paginated: true,
      meta: Joi.object({ total: Joi.number().integer() }),
    },
    errors: [422],
  },
  summary: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'KPI cards (W2.01)',
    description:
      'Counts by type and status, total capacity. Stock and used capacity are null until the stock snapshots (D-56 P3).',
    auth: AUTH_STAFF,
    permission: 'warehouse.view',
    success: {
      status: 200,
      description: 'Summary',
      data: Joi.object({
        total: Joi.number().integer(),
        byType: Joi.object({ MOTHER: Joi.number(), DEPOT: Joi.number() }),
        byStatus: Joi.object({
          SETUP: Joi.number(),
          ACTIVE: Joi.number(),
          LIMITED: Joi.number(),
          INACTIVE: Joi.number(),
        }),
        totalCapacityKg: Joi.string(),
        totalStockUnits: Joi.number().allow(null),
        usedCapacityKg: Joi.string().allow(null),
        capacityUsedPct: Joi.number().allow(null),
      }).meta({ className: 'WarehouseSummary' }),
    },
  },
  export: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Export (CSV)',
    description:
      'The visible warehouses matching the same filters as the list (max 5,000 rows), as `text/csv`. Cells that start with = + - @ are prefixed with an apostrophe (spreadsheet formula injection).',
    auth: AUTH_STAFF,
    permission: 'warehouse.view',
    rateLimit: '5 per user per minute',
    success: { status: 200, description: 'CSV file' },
    errors: [422],
  },
  codeAvailability: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Is a warehouse code free?',
    description: 'Inline check for the Add Warehouse form. Codes are never reused.',
    auth: AUTH_STAFF,
    permission: 'warehouse.create',
    success: {
      status: 200,
      description: 'Availability',
      data: Joi.object({ code: Joi.string(), available: Joi.boolean() }),
      example: ok({ code: 'CW-PUN-01', available: true }),
    },
    errors: [422],
  },
  create: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Add warehouse (W2.02 step 1)',
    description:
      'Creates a SETUP draft (resumable wizard). Central administration only (GLOBAL grant). A depot gets the live central warehouse as parent by default. Capacity may be given in kg or tonnes (stored in kg). 409 `DUPLICATE_CODE` or `CENTRAL_EXISTS`.',
    auth: AUTH_STAFF,
    permission: 'warehouse.create',
    requestExample: {
      code: 'CW-PUN-01',
      name: 'Central Warehouse',
      type: 'MOTHER',
      managerUserId: IDS.manager,
      phone: '9876543210',
      addressLine: 'Village Pataudi, NH-48',
      city: 'Pune',
      district: 'Pune',
      stateCode: '27',
      pinCode: '411001',
      totalAreaSqft: 120000,
      capacity: { value: 100, unit: 'TONNES' },
      temperatureClasses: ['AMB', 'CC_REF'],
    },
    success: { ...one, status: 201, description: 'Draft created', example: ok(exampleWarehouse) },
    errors: [409, 422, 503],
  },
  get: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Warehouse details (W2.03 header, W2.02 review)',
    description: 'Includes the manager contact, the setup checklist and imported data to confirm.',
    auth: AUTH_STAFF,
    permission: 'warehouse.view',
    success: { ...one, example: ok(exampleWarehouse) },
    errors: [404, 422],
  },
  update: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Edit warehouse',
    description: `Changes details (the code never changes; the type only while in setup). Editing or confirming an imported value removes it from reviewFields. ${IF_VERSION}`,
    auth: AUTH_STAFF,
    permission: 'warehouse.configure',
    success: one,
    errors: [400, 404, 409, 422, 503],
  },
  activate: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Activate (W2.02 step 5)',
    description: `SETUP → ACTIVE. Needs the setup checklist (422 lists what is missing, path \`setup.<step>\`). The warehouse starts receiving allocations. ${IF_VERSION}`,
    auth: AUTH_STAFF,
    permission: 'warehouse.status_change',
    success: one,
    errors: [404, 409, 422],
  },
  limit: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Limit',
    description: `ACTIVE → LIMITED with a reason: stock still moves, but no new orders are allocated here. ${IF_VERSION}`,
    auth: AUTH_STAFF,
    permission: 'warehouse.status_change',
    success: one,
    errors: [404, 409, 422],
  },
  deactivate: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Deactivate',
    description: `ACTIVE / LIMITED → INACTIVE with a reason: no stock movements, no allocation. ${IF_VERSION}`,
    auth: AUTH_STAFF,
    permission: 'warehouse.status_change',
    success: one,
    errors: [404, 409, 422],
  },
  reactivate: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Reactivate',
    description: `LIMITED / INACTIVE → ACTIVE. Re-runs the checklist; an imported warehouse needs its imported data confirmed first (issue path \`setup.review\`). ${IF_VERSION}`,
    auth: AUTH_STAFF,
    permission: 'warehouse.status_change',
    success: one,
    errors: [404, 409, 422],
  },
  discard: {
    tag: ADMIN_WAREHOUSES_TAG,
    summary: 'Discard a draft',
    description:
      'Soft-deletes a SETUP draft (the code stays taken). Any other status → 409; deactivate instead.',
    auth: AUTH_STAFF,
    permission: 'warehouse.create',
    success: { status: 204, description: 'Discarded' },
    errors: [404, 409, 422],
  },
} satisfies Record<string, RouteDocs>;
