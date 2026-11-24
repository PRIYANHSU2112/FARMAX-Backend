import Joi from 'joi';

import { ID, REASON, VERSION } from '../../middleware/http.js';
import { PAGING } from '../../middleware/paging.js';

const DATE = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .messages({ 'string.pattern.base': 'must be a date YYYY-MM-DD' });
const FRESH = Joi.boolean().truthy('1').falsy('0').default(false);
const Q = Joi.string().trim().min(1).max(80);
const NOTE = Joi.string().trim().max(500).allow(null, '');
const PRIORITY = Joi.string().valid('STANDARD', 'PRIORITY');
const QTY = Joi.number().integer().min(1).max(1_000_000);

export const whQuery = { querystring: Joi.object({ warehouseId: ID, fresh: FRESH }) };
export const rangeQuery = {
  querystring: Joi.object({ warehouseId: ID, from: DATE, to: DATE, fresh: FRESH }),
};
export const recentQuery = {
  querystring: Joi.object({
    warehouseId: ID,
    limit: Joi.number().integer().min(1).max(50).default(10),
  }),
};
export const perfQuery = {
  querystring: Joi.object({
    from: DATE,
    to: DATE,
    groupBy: Joi.string().valid('warehouse', 'type').default('warehouse'),
  }),
};

export const ordersQuery = {
  querystring: Joi.object({
    tab: Joi.string().valid('all', 'new', 'paid', 'pending', 'unassigned').default('all'),
    q: Q,
    payment: Joi.string().valid('paid', 'pending', 'refunded'),
    warehouseId: ID,
    pin: Joi.string().pattern(/^\d{6}$/),
    from: DATE,
    to: DATE,
    ...PAGING,
  }),
};
export const orderOptionsQuery = {
  querystring: Joi.object({ field: Joi.string().valid('pin', 'customer').required(), q: Q }),
};
export const orderParams = { params: Joi.object({ orderId: ID.required() }) };
export const orderCursor = {
  ...orderParams,
  querystring: Joi.object({
    cursor: ID,
    limit: Joi.number().integer().min(1).max(100).default(30),
  }),
};

const HOLD_REASON = Joi.string().valid(
  'CUSTOMER_REQUEST',
  'PAYMENT_ISSUE',
  'COMPLIANCE',
  'QUALITY',
  'OPERATIONS',
  'OTHER',
);
export const holdSchema = {
  ...orderParams,
  body: Joi.object({
    reasonCode: HOLD_REASON.required(),
    note: NOTE,
    autoReleaseAt: Joi.date().iso().greater('now').allow(null),
    keepAllocationHours: Joi.number().integer().min(0).max(24),
  }),
};
export const holdPatchSchema = {
  ...orderParams,
  body: Joi.object({
    autoReleaseAt: Joi.date().iso().allow(null),
    note: NOTE,
    expectedVersion: VERSION.required(),
  }).min(2),
};
export const releaseHoldSchema = {
  ...orderParams,
  body: Joi.object({ note: NOTE }).empty(null).default({}),
};

export const allocateSchema = {
  ...orderParams,
  body: Joi.object({
    warehouseId: ID.required(),
    reason: REASON.required(),
    variantIds: Joi.array().items(ID).min(1).max(200),
    lines: Joi.array()
      .items(Joi.object({ variantId: ID.required(), qty: QTY.required() }))
      .min(1)
      .max(200),
  }).oxor('variantIds', 'lines'),
};

export const idParams = { params: Joi.object({ id: ID.required() }) };
export const lineParams = {
  params: Joi.object({ id: ID.required(), lineNo: Joi.number().integer().min(1).required() }),
  querystring: Joi.object({
    recommendedOnly: Joi.boolean().truthy('1').falsy('0').default(false),
    sort: Joi.string().valid('fefo', 'available', 'bin').default('fefo'),
  }),
};

export const reserveSchema = {
  ...idParams,
  body: Joi.object({
    lines: Joi.array()
      .items(
        Joi.object({
          lineNo: Joi.number().integer().min(1).required(),
          picks: Joi.array()
            .items(
              Joi.object({
                positionId: ID.required(),
                qty: QTY.required(),
                overrideReason: Joi.string().trim().min(5).max(300),
              }),
            )
            .max(50),
        }),
      )
      .max(200),
  })
    .empty(null)
    .default({}),
};
export const changeBatchSchema = {
  ...idParams,
  body: Joi.object({
    allocationId: ID.required(),
    positionId: ID.required(),
    qty: QTY,
    reason: REASON.required(),
  }),
};
export const releaseAllocSchema = {
  ...idParams,
  querystring: Joi.object({
    lineNo: Joi.number().integer().min(1),
    reason: Joi.string().trim().max(300),
  }),
};

export const operatorsQuery = {
  querystring: Joi.object({
    warehouseId: ID.required(),
    workArea: Joi.string().valid('RECEIVING', 'STORAGE', 'PICKING', 'DISPATCH'),
    q: Q,
  }),
};
export const templateParams = {
  params: Joi.object({ type: Joi.string().valid('PICK_PACK').required() }),
  querystring: Joi.object({ warehouseId: ID }),
};
export const assignSchema = {
  ...idParams,
  body: Joi.object({
    assigneeUserId: ID.required(),
    priority: PRIORITY,
    deadlineAt: Joi.date().iso(),
    note: NOTE,
  }),
};
export const batchSchema = {
  body: Joi.object({
    shipmentIds: Joi.array().items(ID).min(1).max(50).unique().required(),
    assigneeUserId: ID.required(),
    priority: PRIORITY,
    deadlineAt: Joi.date().iso(),
  }),
};
export const taskParams = { params: Joi.object({ taskId: ID.required() }) };
export const taskPatchSchema = {
  ...taskParams,
  body: Joi.object({
    assigneeUserId: ID,
    priority: PRIORITY,
    deadlineAt: Joi.date().iso().allow(null),
    status: Joi.string().valid('CANCELLED'),
    note: NOTE,
    expectedVersion: VERSION.required(),
  }).min(2),
};
export const checklistSchema = {
  params: Joi.object({ taskId: ID.required(), key: Joi.string().trim().max(40).required() }),
  body: Joi.object({ done: Joi.boolean().required() }),
};
export const tasksQuery = {
  querystring: Joi.object({
    assignee: Joi.alternatives(Joi.string().valid('me'), ID),
    status: Joi.string().valid('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'),
    warehouseId: ID,
    pickBatchId: ID,
    cursor: ID,
    limit: Joi.number().integer().min(1).max(100).default(20),
  }),
};

export const pickSchema = {
  ...idParams,
  body: Joi.object({
    lines: Joi.array()
      .items(
        Joi.object({
          allocationId: ID.required(),
          qty: Joi.number().integer().min(0).max(1_000_000).required(),
        }),
      )
      .max(200),
  })
    .empty(null)
    .default({}),
};
export const emptyBody = { ...idParams, body: Joi.object({}).empty(null).default({}) };
export const packSchema = {
  ...idParams,
  body: Joi.object({
    packages: Joi.array()
      .items(
        Joi.object({
          packageType: Joi.string()
            .valid('BAG', 'BOX', 'PALLET', 'DRUM', 'CAN', 'CASK', 'TANK')
            .required(),
          weightKg: Joi.number().min(0).max(100_000).allow(null),
          count: Joi.number().integer().min(1).max(500).default(1),
        }),
      )
      .min(1)
      .max(100)
      .required(),
  }),
};
export const qcSchema = {
  ...idParams,
  body: Joi.object({
    checks: Joi.array()
      .items(
        Joi.object({
          key: Joi.string().trim().max(40).required(),
          passed: Joi.boolean().required(),
        }),
      )
      .min(1)
      .max(50)
      .required(),
    tempC: Joi.number().min(-40).max(80).allow(null),
    note: NOTE,
  }),
};
export const stageSchema = {
  ...idParams,
  body: Joi.object({
    stagingAreaId: ID.allow(null),
    palletCount: Joi.number().integer().min(0).max(500),
  })
    .empty(null)
    .default({}),
};
export const processingBulkSchema = {
  body: Joi.object({
    ids: Joi.array().items(ID).min(1).max(100).unique().required(),
    action: Joi.string()
      .valid('ASSIGN', 'PICK_ALL', 'PICK_COMPLETE', 'STAGE', 'PRIORITY')
      .required(),
    assigneeUserId: ID,
    priority: PRIORITY,
    stagingAreaId: ID,
  }),
};

export const processingQuery = {
  querystring: Joi.object({
    stage: Joi.string()
      .valid('all', 'allocated', 'picking', 'packing', 'qc', 'ready')
      .default('all'),
    q: Q,
    date: DATE,
    warehouseId: ID,
    customerId: ID,
    priority: PRIORITY,
    operatorId: ID,
    stagingAreaId: ID,
    ...PAGING,
  }),
};
export const processingDayQuery = {
  querystring: Joi.object({ warehouseId: ID, date: DATE, fresh: FRESH }),
};

const EX_TYPES = [
  'SHORTAGE',
  'PARTIAL',
  'CANCELLATION',
  'ALLOCATION_ISSUE',
  'QUALITY',
  'DELIVERY',
  'STOCK_DRIFT',
  'ALLOCATION_MISMATCH',
  'ISSUE_MISMATCH',
];
const SEVERITY = Joi.string().valid('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
export const exceptionsQuery = {
  querystring: Joi.object({
    type: Joi.string().valid('all', ...EX_TYPES),
    status: Joi.string().valid('all', 'OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED'),
    severity: SEVERITY,
    q: Q,
    from: DATE,
    to: DATE,
    warehouseId: ID,
    customerId: ID,
    ...PAGING,
  }),
};
export const exceptionKpisQuery = {
  querystring: Joi.object({ warehouseId: ID, from: DATE, to: DATE }),
};
export const exceptionCreateSchema = {
  body: Joi.object({
    type: Joi.string()
      .valid(...EX_TYPES)
      .required(),
    cause: Joi.string().valid(
      'STOCK_SHORT',
      'COLD_BREACH',
      'DAMAGED',
      'QC_FAIL',
      'UNBINNED_STOCK',
      'ZERO_STOCK_AT_NODE',
      'CUSTOMER_CANCEL',
      'DRIFT',
      'OTHER',
    ),
    severity: SEVERITY.default('MEDIUM'),
    warehouseId: ID.required(),
    orderId: ID,
    shipmentId: ID,
    variantId: ID,
    batchId: ID,
    requiredQty: Joi.number().integer().min(0),
    availableQty: Joi.number().integer().min(0),
    impactedQty: Joi.number().integer().min(0),
    reportedLocation: Joi.string().trim().max(60),
    expectedRef: Joi.string().trim().max(60),
    title: Joi.string().trim().min(5).max(200).required(),
  }),
};
export const exceptionPatchSchema = {
  ...idParams,
  body: Joi.object({
    status: Joi.string().valid('OPEN', 'IN_REVIEW', 'CLOSED'),
    severity: SEVERITY,
    assignedTo: ID.allow(null),
    expectedRef: Joi.string().trim().max(60).allow(null),
    reportedLocation: Joi.string().trim().max(60).allow(null),
    note: NOTE,
    expectedVersion: VERSION.required(),
  }).min(2),
};
export const resolveSchema = {
  ...idParams,
  body: Joi.object({
    action: Joi.string()
      .valid(
        'REALLOCATE',
        'RETRY_ALLOCATION',
        'RESTOCK',
        'WRITE_OFF',
        'SPLIT',
        'BACKORDER',
        'PARTIAL_SHIP',
        'CANCEL_LINES',
        'NO_ACTION',
      )
      .required(),
    params: Joi.object().unknown(true).default({}),
    note: NOTE,
  }),
};
export const exceptionBulkSchema = {
  body: Joi.object({
    ids: Joi.array().items(ID).min(1).max(100).unique().required(),
    action: Joi.string().valid('HOLD', 'REROUTE', 'CLOSE', 'ASSIGN').required(),
    warehouseId: ID.when('action', { is: 'REROUTE', then: Joi.required() }),
    assignedTo: ID.when('action', { is: 'ASSIGN', then: Joi.required() }),
    note: NOTE,
  }),
};

export const sopSchema = {
  body: Joi.object({
    title: Joi.string().trim().max(120).allow(null),
    steps: Joi.array().items(Joi.string().trim().min(2).max(300)).max(30).required(),
    documentUrl: Joi.string()
      .uri({ scheme: ['https'] })
      .max(500)
      .allow(null),
  }),
};
export const settingsSchema = {
  querystring: Joi.object({
    scope: Joi.alternatives(ID, Joi.string().valid('GLOBAL')).default('GLOBAL'),
  }),
  body: Joi.object()
    .pattern(/^fulfilment\./, Joi.any())
    .min(1),
};
export const settingsQuery = {
  querystring: Joi.object({
    scope: Joi.alternatives(ID, Joi.string().valid('GLOBAL')).default('GLOBAL'),
  }),
};

const SHELF = {
  name: Joi.string().trim().min(3).max(120),
  stateCode: Joi.string().trim().max(4).allow(null),
  rootCategoryId: ID.allow(null),
  farmCategory: Joi.string().trim().max(60).allow(null),
  minRemainingDays: Joi.number().integer().min(0).max(3650),
  isActive: Joi.boolean(),
};
export const shelfCreateSchema = {
  body: Joi.object({
    ...SHELF,
    name: SHELF.name.required(),
    minRemainingDays: SHELF.minRemainingDays.required(),
  }),
};
export const shelfPatchSchema = {
  ...idParams,
  body: Joi.object({ ...SHELF, expectedVersion: VERSION.required() }).min(2),
};

export const reservationsQuery = {
  querystring: Joi.object({
    tab: Joi.string().valid('active', 'picked', 'released').default('active'),
    warehouseId: ID,
    variantId: ID,
    q: Q,
    ...PAGING,
  }),
};
export const allocationParams = { params: Joi.object({ allocationId: ID.required() }) };

// ── Phase 4b delivery (W3.09 / W3.10, D-40) ──

const RECEIPT = Joi.string().trim().min(20).max(4000);
const RECEIVED = Joi.array()
  .items(
    Joi.object({
      lineNo: Joi.number().integer().min(1).required(),
      qty: Joi.number().integer().min(0).required(),
    }),
  )
  .max(200);
const GEO = {
  lat: Joi.number().min(-90).max(90).allow(null),
  lng: Joi.number().min(-180).max(180).allow(null),
};

export const deliverSchema = {
  ...idParams,
  body: Joi.object({
    otp: Joi.string()
      .pattern(/^\d{6}$/)
      .required(),
    receiverName: Joi.string().trim().min(2).max(120).required(),
    receivedLines: RECEIVED,
    podReceipts: Joi.array().items(RECEIPT).max(10),
    signatureReceipt: RECEIPT.allow(null),
    ...GEO,
  }),
};
export const overrideSchema = {
  ...idParams,
  body: Joi.object({
    reason: REASON.required(),
    receiverName: Joi.string().trim().min(2).max(120).required(),
    receivedLines: RECEIVED,
    podReceipts: Joi.array().items(RECEIPT).max(10),
    signatureReceipt: RECEIPT.allow(null),
    ...GEO,
  }),
};
export const failedSchema = {
  ...idParams,
  body: Joi.object({ reason: Joi.string().trim().min(3).max(300).required(), note: NOTE }),
};
export const returnSchema = { ...idParams, body: Joi.object({ reason: REASON.required() }) };
export const settleSchema = {
  ...idParams,
  body: Joi.object({
    resolution: Joi.string()
      .valid('REFUND_SHORTAGE', 'CONFIRM_FULL', 'ATTACH_POD', 'APPROVE_OVERRIDE')
      .required(),
    receipts: Joi.array().items(RECEIPT).max(10),
    note: NOTE,
    expectedVersion: VERSION.required(),
  }),
};
export const deliveredKpisQuery = {
  querystring: Joi.object({ warehouseId: ID, from: DATE, to: DATE }),
};
export const deliveredQuery = {
  querystring: Joi.object({
    q: Q,
    from: DATE,
    to: DATE,
    customerId: ID,
    warehouseId: ID,
    status: Joi.string().valid('DELIVERED', 'DELIVERY_FAILED', 'RETURNED_TO_WAREHOUSE'),
    ...PAGING,
  }),
};
const MONTH = Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/);
export const fulfilledKpisQuery = { querystring: Joi.object({ warehouseId: ID, month: MONTH }) };
export const fulfilledQuery = {
  querystring: Joi.object({
    tab: Joi.string().valid('all', 'settled', 'pending', 'overdue').default('all'),
    q: Q,
    month: MONTH,
    warehouseId: ID,
    settlementType: Joi.string().valid('SETTLED', 'PENDING'),
    ...PAGING,
  }),
};
export const exportCreateSchema = {
  body: Joi.object({
    type: Joi.string().valid('POD_ARCHIVE', 'DELIVERED_CSV', 'FULFILLED_CSV').required(),
    filters: Joi.object({ warehouseId: ID, from: DATE, to: DATE }).default({}),
    shipmentIds: Joi.array().items(ID).min(1).max(5000),
  }),
};
export const exportsQuery = {
  querystring: Joi.object({ cursor: ID, limit: Joi.number().integer().min(1).max(50).default(20) }),
};
export const customerShipmentsQuery = { querystring: Joi.object({ orderId: ID }) };
export const driverLinkSchema = {
  ...idParams,
  body: Joi.object({
    phone: Joi.string()
      .trim()
      .pattern(/^\+?\d{10,15}$/)
      .required(),
  }),
};
const TOKEN = Joi.string()
  .pattern(/^[A-Za-z0-9_-]{40,60}$/)
  .required();
export const driverTokenParams = { params: Joi.object({ token: TOKEN }) };
export const driverShipmentParams = { params: Joi.object({ token: TOKEN, id: ID.required() }) };
export const driverPingSchema = {
  ...driverTokenParams,
  body: Joi.object({
    lat: Joi.number().min(-90).max(90).required(),
    lng: Joi.number().min(-180).max(180).required(),
    speedKmh: Joi.number().min(0).max(200).allow(null),
    remainingKm: Joi.number().min(0).max(5000).allow(null),
    network: Joi.string().trim().max(10).allow(null),
    at: Joi.date().iso().max('now').allow(null),
  }),
};
export const driverDeliverSchema = {
  ...driverShipmentParams,
  body: Joi.object({
    otp: Joi.string()
      .pattern(/^\d{6}$/)
      .required(),
    receiverName: Joi.string().trim().min(2).max(120).required(),
    receivedLines: RECEIVED,
    ...GEO,
  }),
};
export const driverFailedSchema = {
  ...driverShipmentParams,
  body: Joi.object({ reason: Joi.string().trim().min(3).max(300).required(), note: NOTE }),
};
