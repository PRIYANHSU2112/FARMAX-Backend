import Joi from 'joi';

import { ID, REASON, RES_CODE, VERSION } from '../../middleware/http.js';
import { PAGING } from '../../middleware/paging.js';

/** Joi request schemas of the gate & weighbridge routes (D-62). */

const DATE = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .messages({ 'string.pattern.base': 'must be a date YYYY-MM-DD' });
const ISO = Joi.string().isoDate();
const REG = Joi.string()
  .trim()
  .min(4)
  .max(16)
  .pattern(/^[A-Za-z0-9 -]+$/)
  .messages({ 'string.pattern.base': 'must be a vehicle number, e.g. AP 37 BC 2210' });
const MOBILE = Joi.string()
  .trim()
  .pattern(/^(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/)
  .messages({ 'string.pattern.base': 'must be a 10-digit Indian mobile number' });
const NAME = Joi.string().trim().min(2).max(120);
const NOTE = Joi.string().trim().max(500).allow(null, '');
const KG = Joi.number().positive().max(200_000).precision(2);
const QTY = Joi.number().integer().min(1).max(1_000_000);
const VEHICLE_TYPE = Joi.string().valid(
  'MINI_TRUCK',
  'LCV',
  'TRUCK',
  'HEAVY_TRUCK',
  'MULTI_AXLE',
  'REEFER',
  'TRACTOR_TRAILER',
  'OTHER',
);
const PURPOSE = Joi.string().valid(
  'INBOUND_CONSIGNMENT',
  'STOCK_TRANSFER',
  'CUSTOMER_RETURN',
  'OTHER',
);
export const DOC_TYPES = [
  'PURCHASE_ORDER',
  'DELIVERY_CHALLAN',
  'INVOICE',
  'EWAY_BILL',
  'RC_BOOK',
  'PERMIT',
  'INSURANCE',
  'DRIVER_LICENCE',
  'OTHER',
] as const;
const DOC_TYPE = Joi.string().valid(...DOC_TYPES);
const RECEIPT = Joi.string()
  .max(2048)
  .description('Signed receipt of `POST /v1/upload?purpose=gate_document`.');
const PAGE = { cursor: PAGING.cursor, limit: PAGING.limit };

const wh = { warehouseId: ID.required() };
export const whQuery = { querystring: Joi.object(wh) };
export const whDateQuery = { querystring: Joi.object({ ...wh, date: DATE }) };
export const whPageQuery = { querystring: Joi.object({ ...wh, ...PAGE }) };
export const idParam = { params: Joi.object({ id: ID.required() }) };
const passNoParam = Joi.object({
  passNo: Joi.string()
    .pattern(/^GP[IO]-\d{4}-\d{4,}$/)
    .required()
    .messages({ 'string.pattern.base': 'must be a gate pass number, e.g. GPI-2611-0042' }),
});
export const passNoParams = { params: passNoParam };
const reasonBody = Joi.object({ reason: REASON.required() });

// ── lookups ──

export const purchaseOrdersQuery = {
  querystring: Joi.object({
    ...wh,
    vendorId: ID,
    q: Joi.string().trim().max(40),
    limit: PAGING.limit,
  }),
};
export const productsQuery = {
  querystring: Joi.object({
    ...wh,
    q: Joi.string().trim().min(2).max(60).required(),
    limit: PAGING.limit,
  }),
};

// ── dashboard ──

const TAB = Joi.string().valid('all', 'expected', 'arrived', 'inProgress', 'blocked', 'completed');
const listFilters = {
  ...wh,
  statuses: Joi.string()
    .pattern(
      /^(expected|arrived|inProgress|blocked|completed)(,(expected|arrived|inProgress|blocked|completed))*$/,
    )
    .messages({
      'string.pattern.base':
        'comma-separated tabs: expected, arrived, inProgress, blocked, completed',
    }),
  q: Joi.string().trim().max(60),
  bayId: ID,
  from: DATE,
  to: DATE,
};
export const shipmentsQuery = { querystring: Joi.object({ ...listFilters, tab: TAB, ...PAGE }) };
export const countsQuery = { querystring: Joi.object(listFilters) };

// ── shipments ──

const LINES = Joi.array()
  .items(Joi.object({ variantId: ID.required(), expectedQty: QTY.required() }))
  .min(1)
  .max(100);
const DOCS = Joi.array()
  .items(
    Joi.object({
      docType: DOC_TYPE.required(),
      receipt: RECEIPT.allow(null),
      refNo: Joi.string().trim().max(60).allow(null, ''),
      validUntil: DATE.allow(null),
      note: NOTE,
    }),
  )
  .max(20);
const shipmentFields = {
  purpose: PURPOSE,
  vendorId: ID.allow(null),
  restockRequestId: ID.allow(null).description('PO = approved PROCUREMENT restock request.'),
  vendorPoNo: Joi.string().trim().max(40).allow(null, ''),
  transferId: ID.allow(null),
  sourceLocation: Joi.string().trim().max(160).allow(null, ''),
  transportType: VEHICLE_TYPE,
  etaAt: ISO,
  plannedVehicleRegNo: REG.allow(null, ''),
  plannedDriverName: NAME.allow(null, ''),
  plannedDriverMobile: MOBILE.allow(null, ''),
  dockDoorId: ID.allow(null),
  invoiceNetKg: KG.allow(null),
  invoiceGrossKg: KG.allow(null),
  palletCount: Joi.number().integer().min(0).max(500).allow(null),
  notes: NOTE,
};
export const shipmentSchema = {
  body: Joi.object({
    ...wh,
    ...shipmentFields,
    transportType: VEHICLE_TYPE.required(),
    etaAt: ISO.required(),
    lines: LINES.required(),
    documents: DOCS,
  }),
};
export const previewSchema = {
  body: Joi.object({
    ...wh,
    ...shipmentFields,
    transportType: VEHICLE_TYPE.default('TRUCK'),
    etaAt: ISO.required(),
    lines: Joi.array()
      .items(Joi.object({ variantId: ID.required(), expectedQty: QTY.required() }))
      .max(100)
      .default([]),
    documents: DOCS,
  }),
};
export const shipmentUpdateSchema = {
  ...idParam,
  body: Joi.object({ ...shipmentFields, lines: LINES, expectedVersion: VERSION.required() }).min(2),
};
export const cancelSchema = { ...idParam, body: reasonBody };
export const attachDocSchema = {
  ...idParam,
  body: Joi.object({
    docType: DOC_TYPE.required(),
    receipt: RECEIPT.allow(null),
    refNo: Joi.string().trim().max(60).allow(null, ''),
    validUntil: DATE.allow(null),
    note: NOTE,
  }).or('receipt', 'refNo'),
};
export const docParams = { params: Joi.object({ id: ID.required(), docId: ID.required() }) };
export const docIdParams = { params: Joi.object({ docId: ID.required() }) };
export const verifyDocSchema = {
  ...docIdParams,
  body: Joi.object({
    decision: Joi.string().valid('VERIFIED', 'REJECTED', 'EXEMPTED').required(),
    refNo: Joi.string().trim().max(60).allow(null, ''),
    validUntil: DATE.allow(null),
    note: NOTE,
  }),
};

// ── entries ──

export const arrivalsQuery = {
  querystring: Joi.object({ ...wh, q: Joi.string().trim().max(60), limit: PAGING.limit }),
};
const GROSS = Joi.object({
  weightKg: KG.required(),
  scaleId: ID.allow(null),
  slipNo: Joi.string().trim().max(40).allow(null, ''),
  slipReceipt: RECEIPT.allow(null),
});
export const entrySchema = {
  body: Joi.object({
    shipmentId: ID.required(),
    vehicleRegNo: REG.required(),
    vehicleType: VEHICLE_TYPE.required(),
    driverName: NAME.required(),
    driverMobile: MOBILE.required(),
    driverLicenceNo: Joi.string().trim().max(30).allow(null, ''),
    driverVerified: Joi.boolean(),
    arrivedAt: ISO,
    dockDoorId: ID.allow(null),
    plateNote: Joi.string().trim().max(300).allow(null, ''),
    gross: GROSS,
  }),
};
export const entryPatchSchema = {
  ...idParam,
  body: Joi.object({
    expectedVersion: VERSION.required(),
    vehicleRegNo: REG,
    vehicleType: VEHICLE_TYPE,
    driverName: NAME,
    driverMobile: MOBILE,
    driverLicenceNo: Joi.string().trim().max(30).allow(null, ''),
    driverVerified: Joi.boolean(),
    dockDoorId: ID.allow(null),
    plateNote: Joi.string().trim().max(300).allow(null, ''),
  }).min(2),
};
export const entriesQuery = {
  querystring: Joi.object({
    ...wh,
    flag: Joi.string().valid('NO_RECEIPT').required(),
    limit: PAGING.limit,
  }),
};
export const approveSchema = {
  ...idParam,
  body: Joi.object({
    remarks: NOTE,
    driverVerified: Joi.boolean(),
    ewayBill: Joi.object({
      refNo: Joi.string().trim().min(4).max(60).required(),
      validUntil: DATE.required(),
    }).allow(null),
  }),
};
export const blockSchema = {
  ...idParam,
  body: Joi.object({
    reason: Joi.string()
      .valid(
        'MISSING_DOCUMENT',
        'INVALID_DOCUMENT',
        'EWAY_BILL_EXPIRED',
        'VEHICLE_MISMATCH',
        'DRIVER_UNVERIFIED',
        'SECURITY_CONCERN',
        'OTHER',
      )
      .required(),
    holdLocation: Joi.string().trim().max(120).allow(null, ''),
    remarks: REASON.required(),
  }),
};
export const remarksSchema = { ...idParam, body: Joi.object({ remarks: REASON.required() }) };
export const turnAwaySchema = {
  ...idParam,
  body: Joi.object({
    reason: REASON.required(),
    shipmentAction: Joi.string().valid('REEXPECT', 'CANCEL').required(),
  }),
};
export const unloadedSchema = {
  ...idParam,
  body: Joi.object({ reason: Joi.string().trim().max(500).allow(null, '') })
    .empty(null)
    .default({}),
};
export const emptyBody = { ...idParam, body: Joi.object({}).empty(null).default({}) };

// ── passes ──

export const scanSchema = { body: Joi.object({ qrToken: Joi.string().max(1024).required() }) };
export const reissueSchema = { ...passNoParams, body: reasonBody };

// ── weighbridge ──

export const lookupQuery = { querystring: Joi.object({ ...wh, regNo: REG.required() }) };
export const weighSchema = {
  ...idParam,
  body: Joi.object({
    kind: Joi.string().valid('GROSS', 'TARE', 'EXIT_CHECK').required(),
    weightKg: KG.required(),
    scaleId: ID.allow(null),
    slipNo: Joi.string().trim().max(40).allow(null, ''),
    slipReceipt: RECEIPT.allow(null),
  }),
};
export const holdSchema = { ...idParam, body: Joi.object({ note: REASON.required() }) };
export const resolveSchema = {
  ...idParam,
  body: Joi.object({
    resolution: Joi.string()
      .valid('ACCEPT_VARIANCE', 'REWEIGH', 'ACCEPT_WITH_DEBIT_NOTE')
      .required(),
    note: REASON.required(),
    reweigh: Joi.object({
      kind: Joi.string().valid('GROSS', 'TARE').required(),
      weightKg: KG.required(),
      scaleId: ID.allow(null),
      slipNo: Joi.string().trim().max(40).allow(null, ''),
    })
      .allow(null)
      .when('resolution', { is: 'REWEIGH', then: Joi.required() }),
  }),
};
export const overrideSchema = {
  ...idParam,
  body: Joi.object({ weightKg: KG.required(), reason: REASON.required(), scaleId: ID.allow(null) }),
};
export const reviewSchema = {
  ...idParam,
  body: Joi.object({ decision: Joi.string().valid('APPROVE', 'REJECT').required(), note: NOTE }),
};
export const approvalsQuery = { querystring: Joi.object({ ...wh, limit: PAGING.limit }) };
export const outwardPassSchema = {
  ...idParam,
  body: Joi.object({ emptyTruckVerified: Joi.boolean(), remarks: NOTE }).empty(null).default({}),
};

// ── appointments ──

export const bookSchema = {
  body: Joi.object({
    ...wh,
    vendorId: ID.required(),
    restockRequestId: ID.allow(null),
    asnId: ID.allow(null),
    inboundShipmentId: ID.allow(null),
    slotStart: ISO.required(),
    dockDoorId: ID.required(),
    loadQty: Joi.number().positive().max(100_000).allow(null),
  }),
};
export const apptQuery = { ...idParam, querystring: Joi.object(wh) };
export const apptListQuery = { querystring: Joi.object({ ...wh, date: DATE, ...PAGE }) };
export const rescheduleSchema = {
  ...idParam,
  body: Joi.object({ ...wh, slotStart: ISO.required(), dockDoorId: ID.allow(null) }),
};
export const apptActionSchema = { ...idParam, body: Joi.object(wh) };
export const apptCancelSchema = {
  ...idParam,
  body: Joi.object({ ...wh, reason: REASON.required() }),
};

// ── ASN ──

const ASN_STATUS = Joi.string().valid(
  'RECEIVED',
  'PENDING',
  'MATCHED',
  'UNMATCHED',
  'PARTIALLY_CONVERTED',
  'CONVERTED',
  'CANCELLED',
);
export const asnListQuery = {
  querystring: Joi.object({
    ...wh,
    status: ASN_STATUS,
    q: Joi.string().trim().max(60),
    from: DATE,
    to: DATE,
    ...PAGE,
  }),
};
const asnBody = {
  vendorId: ID.required(),
  vendorAsnRef: Joi.string()
    .trim()
    .max(40)
    .pattern(/^[A-Za-z0-9/_-]+$/)
    .required()
    .messages({ 'string.pattern.base': 'letters, digits, "-", "_" or "/"' }),
  restockRequestId: ID.allow(null),
  vehicleRegNo: REG.allow(null, ''),
  etaAt: ISO.required(),
  declaredNetKg: KG.allow(null),
  notes: NOTE,
  lines: Joi.array()
    .items(
      Joi.object({ variantId: ID.required(), qty: QTY.required(), declaredNetKg: KG.allow(null) }),
    )
    .min(1)
    .max(100)
    .required(),
};
export const asnSchema = { body: Joi.object({ ...wh, ...asnBody }) };
export const asnInternalSchema = { body: Joi.object({ ...wh, ...asnBody }) };
export const matchSchema = { ...idParam, body: Joi.object({ restockRequestId: ID.required() }) };
export const convertSchema = {
  ...idParam,
  body: Joi.object({
    lines: Joi.array()
      .items(Joi.object({ lineNo: Joi.number().integer().min(1).required(), qty: QTY.required() }))
      .min(1)
      .max(100),
    vehicleRegNo: REG.allow(null, ''),
    transportType: VEHICLE_TYPE,
    etaAt: ISO,
    dockDoorId: ID.allow(null),
    plannedDriverName: NAME.allow(null, ''),
    plannedDriverMobile: MOBILE.allow(null, ''),
  })
    .empty(null)
    .default({}),
};

// ── visitors & security ──

export const visitorsQuery = {
  querystring: Joi.object({
    ...wh,
    status: Joi.string().valid('PENDING', 'ON_SITE', 'CHECKED_OUT', 'DENIED'),
    date: DATE,
    q: Joi.string().trim().max(60),
    ...PAGE,
  }),
};
export const visitorSchema = {
  body: Joi.object({
    ...wh,
    name: NAME.required(),
    mobile: MOBILE.allow(null, ''),
    company: Joi.string().trim().max(120).allow(null, ''),
    purpose: Joi.string().trim().min(2).max(80).required(),
    hostLabel: Joi.string().trim().max(120).allow(null, ''),
    hostUserId: ID.allow(null),
    gateEntryId: ID.allow(null),
    checkIn: Joi.boolean(),
  }),
};
export const outwardQuery = {
  querystring: Joi.object({
    ...wh,
    status: Joi.string().valid('PENDING_AUTH', 'AUTHORIZED', 'EXITED', 'REJECTED'),
    date: DATE,
    ...PAGE,
  }),
};
export const outwardSchema = {
  body: Joi.object({
    ...wh,
    material: Joi.string().trim().min(2).max(160).required(),
    qty: Joi.number().positive().max(1_000_000).precision(2).required(),
    unit: Joi.string().trim().min(1).max(20).required(),
    vehicleRegNo: REG.allow(null, ''),
    receiver: Joi.string().trim().max(120).allow(null, ''),
    remarks: NOTE,
  }),
};
export const noteSchema = { ...idParam, body: Joi.object({ note: NOTE }).empty(null).default({}) };
const CHECK = Joi.string().valid('PASS', 'FAIL', 'NA');
export const checksQuery = {
  querystring: Joi.object({
    ...wh,
    result: Joi.string().valid('CLEAR', 'HOLD'),
    open: Joi.boolean(),
    ...PAGE,
  }),
};
export const checkSchema = {
  body: Joi.object({
    ...wh,
    subjectType: Joi.string().valid('ENTRY', 'VISITOR', 'OUTWARD').required(),
    subjectId: ID.required(),
    identityCheck: CHECK,
    plateCheck: CHECK,
    outwardCheck: CHECK,
    remarks: NOTE,
  }),
};
export const resolveCheckSchema = {
  ...idParam,
  body: Joi.object({ note: REASON.required(), deny: Joi.boolean() }),
};

// ── admin: scales + settings ──

const scaleFields = {
  code: RES_CODE,
  name: Joi.string().trim().min(2).max(80),
  maxCapacityKg: Joi.number().positive().max(200_000),
  divisionKg: Joi.number().positive().max(1_000),
  calibratedAt: DATE.allow(null),
  calibrationValidUntil: DATE.allow(null),
  status: Joi.string().valid('ACTIVE', 'INACTIVE', 'MAINTENANCE'),
};
export const scaleCreateSchema = {
  ...idParam,
  body: Joi.object({
    ...scaleFields,
    code: RES_CODE.required(),
    name: scaleFields.name.required(),
    maxCapacityKg: scaleFields.maxCapacityKg.required(),
  }),
};
export const scaleParams = { params: Joi.object({ id: ID.required(), scaleId: ID.required() }) };
export const scaleUpdateSchema = {
  ...scaleParams,
  body: Joi.object({ ...scaleFields, expectedVersion: VERSION.required() }).min(2),
};
const PCT = Joi.number().min(0).max(25);
const purposeMap = (item: Joi.Schema) =>
  Joi.object({
    INBOUND_CONSIGNMENT: item,
    STOCK_TRANSFER: item,
    CUSTOMER_RETURN: item,
    OTHER: item,
  });
export const settingsSchema = {
  ...idParam,
  body: Joi.object({
    'gate.weightTolerance': Joi.object({
      pct: PCT.required(),
      minKg: Joi.number().min(0).max(5_000).required(),
    }),
    'gate.packagingAllowance': purposeMap(
      Joi.object({ pct: PCT.required(), perPalletKg: Joi.number().min(0).max(200).required() }),
    ),
    'gate.requiredDocs': purposeMap(Joi.array().items(DOC_TYPE).unique().max(9)),
    'gate.slotMinutes': Joi.number().integer().valid(30, 45, 60, 90, 120),
    'gate.delayGraceMinutes': Joi.number().integer().min(0).max(240),
    'gate.grossRequired': Joi.boolean(),
    'gate.exitCheckOnReject': Joi.boolean(),
    'gate.passValidityHours': Joi.number().integer().min(1).max(168),
    'gate.visitorRetentionDays': Joi.number().integer().min(7).max(3650),
    'gate.driverRetentionDays': Joi.number().integer().min(30).max(3650),
  }).min(1),
};
