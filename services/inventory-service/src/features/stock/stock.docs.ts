import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, IDEMPOTENCY, IDS, ok } from '../../docs/shared.js';
import { LEDGER_TYPES, OPERATION_STATUSES, OPERATION_TYPES } from './stock.validation.js';

export const ADMIN_STOCK_TAG = 'Admin Stock';

const WRITE_LIMIT = '60 writes per user per minute';

const lineSchema = Joi.object({ variantId: Joi.string().guid(), qty: Joi.number().integer() });

const levelSchema = Joi.object({
  id: Joi.string().guid(),
  warehouseId: Joi.string().guid(),
  variantId: Joi.string().guid(),
  sku: Joi.string().allow(null),
  name: Joi.string().allow(null),
  onHand: Joi.number()
    .integer()
    .description('Physical good units (includes reserved and safety stock)'),
  reserved: Joi.number().integer().description('Held by ACTIVE / COMMITTED reservations'),
  damaged: Joi.number().integer().description('Out of onHand, waiting for write-off'),
  safetyStock: Joi.number().integer().description('Protected; never sold'),
  reorderLevel: Joi.number().integer().description('Alert threshold (0 = no alerts)'),
  sellable: Joi.number().integer().description('max(0, onHand − reserved − safetyStock)'),
  lowStock: Joi.boolean(),
  lowStockAlerted: Joi.boolean().description('A low_stock event was sent for the current dip'),
  version: Joi.number().integer(),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'StockLevel' });

const operationSchema = Joi.object({
  id: Joi.string().guid(),
  type: Joi.string().valid(...OPERATION_TYPES),
  status: Joi.string().valid(...OPERATION_STATUSES),
  warehouseId: Joi.string().guid(),
  lines: Joi.array().items(lineSchema),
  reference: Joi.string().allow(null),
  reason: Joi.string().allow(null),
  requestedBy: Joi.string().guid(),
  decidedBy: Joi.string().guid().allow(null),
  decidedAt: Joi.date().iso().allow(null),
  decisionReason: Joi.string().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'StockOperation' });

const ledgerSchema = Joi.object({
  id: Joi.string().guid(),
  warehouseId: Joi.string().guid(),
  variantId: Joi.string().guid(),
  type: Joi.string().valid(...LEDGER_TYPES),
  onHandDelta: Joi.number().integer(),
  damagedDelta: Joi.number().integer(),
  onHandAfter: Joi.number().integer(),
  damagedAfter: Joi.number().integer(),
  refType: Joi.string().example('operation'),
  refId: Joi.string().guid(),
  actorUserId: Joi.string().guid().allow(null),
  requestId: Joi.string().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'StockLedgerEntry' });

const level = {
  id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7e01',
  warehouseId: IDS.warehouse,
  variantId: IDS.variant,
  sku: 'NDLS-1000',
  name: 'ND LaSota Live Vaccine 1,000 doses',
  onHand: 240,
  reserved: 24,
  damaged: 2,
  safetyStock: 10,
  reorderLevel: 50,
  sellable: 206,
  lowStock: false,
  lowStockAlerted: false,
  version: 7,
  updatedAt: '2026-11-21T09:00:00.000Z',
};
const receipt = {
  id: IDS.operation,
  type: 'RECEIPT',
  status: 'APPLIED',
  warehouseId: IDS.warehouse,
  lines: [{ variantId: IDS.variant, qty: 240 }],
  reference: 'GRN-26-00412',
  reason: null,
  requestedBy: IDS.admin,
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  createdAt: '2026-11-21T09:00:00.000Z',
};
const short = {
  message: 'Not enough unreserved stock for variant …',
  details: { reason: 'INSUFFICIENT_STOCK', variantId: IDS.variant, requested: 30 },
};

const opDocs = (summary: string, description: string, permission: string, example: object) => ({
  tag: ADMIN_STOCK_TAG,
  summary,
  description: `${description}\n\nOne transaction: operation row + one guarded update per line + ledger rows + audit row. Replays with the same \`Idempotency-Key\` answer **200** with the original operation (nothing moves twice); new operations answer **201**.`,
  auth: AUTH_ADMIN,
  permission,
  rateLimit: WRITE_LIMIT,
  headers: IDEMPOTENCY,
  requestExample: example,
  success: {
    status: 201 as const,
    description: 'Operation (201 new, 200 replay)',
    data: operationSchema,
    example: ok(receipt),
  },
  errors: [404, 409, 422] as const,
  errorExamples: { 409: short },
});

export const STOCK_DOCS = {
  listLevels: {
    tag: ADMIN_STOCK_TAG,
    summary: 'List warehouse stock',
    description:
      'Filters: `warehouseId`, `variantId`, `lowStock=true` (sellable ≤ reorderLevel > 0).',
    auth: AUTH_ADMIN,
    permission: 'inventory.view',
    success: {
      status: 200,
      description: 'A page of stock levels',
      data: levelSchema,
      paginated: true,
      example: { success: true, data: [level], meta: { nextCursor: null, limit: 20 } },
    },
    errors: [422],
  },
  getLevel: {
    tag: ADMIN_STOCK_TAG,
    summary: 'Stock of one variant in one warehouse',
    auth: AUTH_ADMIN,
    permission: 'inventory.view',
    success: { status: 200, description: 'Stock level', data: levelSchema, example: ok(level) },
    errors: [404, 422],
  },
  thresholds: {
    tag: ADMIN_STOCK_TAG,
    summary: 'Set reorder level and safety stock',
    description:
      '`reorderLevel` is only the low-stock alert threshold; `safetyStock` is protected stock that is never reserved or sold. Creates the row (zero stock) if needed. `reason` required; audited.',
    auth: AUTH_ADMIN,
    permission: 'inventory.configure',
    rateLimit: WRITE_LIMIT,
    requestExample: { reorderLevel: 50, safetyStock: 10, reason: 'Monsoon buffer for ND vaccine' },
    success: { status: 200, description: 'Updated level', data: levelSchema, example: ok(level) },
    errors: [404, 422],
  },
  receipt: opDocs(
    'Receive stock',
    'Adds good stock (`onHand +qty`). Variants must be known and active; the warehouse must be active.',
    'inventory.receive',
    {
      warehouseId: IDS.warehouse,
      reference: 'GRN-26-00412',
      lines: [{ variantId: IDS.variant, qty: 240 }],
    },
  ),
  damage: opDocs(
    'Mark stock damaged',
    'Moves units from `onHand` to `damaged`. Only unreserved units (`onHand − reserved ≥ qty`); may eat into safety stock. `reason` required.',
    'inventory.exception_raise',
    {
      warehouseId: IDS.warehouse,
      lines: [{ variantId: IDS.variant, qty: 2 }],
      reason: 'Two vials cracked during put-away',
    },
  ),
  writeOff: opDocs(
    'Write off damaged stock',
    'Removes units from `damaged` (`damaged ≥ qty`). `reason` required.',
    'inventory.write_off',
    {
      warehouseId: IDS.warehouse,
      lines: [{ variantId: IDS.variant, qty: 2 }],
      reason: 'Destroyed under biosecurity SOP, certificate DS-118',
    },
  ),
  adjustment: opDocs(
    'Request a stock adjustment',
    'Creates a **PENDING** adjustment (signed `qty`, never 0); nothing moves until a different person approves it.',
    'inventory.exception_raise',
    {
      warehouseId: IDS.warehouse,
      lines: [{ variantId: IDS.variant, qty: -3 }],
      reason: 'Cycle count found 3 vials fewer than the system',
    },
  ),
  approve: {
    tag: ADMIN_STOCK_TAG,
    summary: 'Approve a pending adjustment',
    description:
      '**Segregation of duties:** the approver must not be the requester (403). Negative lines may never take `onHand` below `reserved` (409). One transaction; audited.',
    auth: AUTH_ADMIN,
    permission: 'inventory.adjust',
    rateLimit: WRITE_LIMIT,
    requestExample: { reason: 'Verified against the cycle-count sheet' },
    success: {
      status: 200,
      description: 'Applied',
      data: operationSchema,
      example: ok({ ...receipt, type: 'ADJUSTMENT', status: 'APPLIED' }),
    },
    errors: [404, 409, 422],
  },
  reject: {
    tag: ADMIN_STOCK_TAG,
    summary: 'Reject a pending adjustment',
    auth: AUTH_ADMIN,
    permission: 'inventory.adjust',
    rateLimit: WRITE_LIMIT,
    requestExample: { reason: 'Recount matched the system quantity' },
    success: { status: 200, description: 'Rejected', data: operationSchema },
    errors: [404, 409, 422],
  },
  listOperations: {
    tag: ADMIN_STOCK_TAG,
    summary: 'List stock operations',
    description:
      'Newest first. Filters: `warehouseId`, `type`, `status` (e.g. PENDING adjustments).',
    auth: AUTH_ADMIN,
    permission: 'inventory.view',
    success: {
      status: 200,
      description: 'A page of operations',
      data: operationSchema,
      paginated: true,
    },
    errors: [422],
  },
  getOperation: {
    tag: ADMIN_STOCK_TAG,
    summary: 'Get a stock operation',
    auth: AUTH_ADMIN,
    permission: 'inventory.view',
    success: { status: 200, description: 'Operation', data: operationSchema, example: ok(receipt) },
    errors: [404, 422],
  },
  ledger: {
    tag: ADMIN_STOCK_TAG,
    summary: 'Stock ledger',
    description:
      'Append-only record of every physical movement (newest first). For each warehouse × variant, `onHand` equals the sum of `onHandDelta`. Filters: `warehouseId`, `variantId`, `type`, `from` / `to`.',
    auth: AUTH_ADMIN,
    permission: 'inventory.view',
    success: { status: 200, description: 'A page of entries', data: ledgerSchema, paginated: true },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
