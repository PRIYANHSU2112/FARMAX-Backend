import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { IDS, staffDoc, wmsDoc } from '../../docs/shared.js';
import { PAGE_META } from '../../middleware/paging.js';

/** Swagger areas of the gate (D-62). */
export const GATE_AREA = 'Gate · Dashboard & shipments';
export const GATE_ENTRY_AREA = 'Gate · Entries, documents & passes';
export const GATE_WEIGH_AREA = 'Gate · Weighbridge';
export const GATE_YARD_AREA = 'Gate · Dock appointments & ASN';
export const GATE_SECURITY_AREA = 'Gate · Visitors & security';
export const ADMIN_GATE_TAG = 'Admin Warehouses · Gate setup';

const IDEMPOTENCY = {
  'Idempotency-Key': {
    description:
      'Optional (8–64 chars `[A-Za-z0-9._-]`). The response is replayed for 24 h per user + route; the same key with a different request → 422 `IDEMPOTENCY_KEY_REUSED`; while the first is running → 409. Replays carry `idempotent-replayed: true`.',
  },
} as const;
const IF_NONE_MATCH = {
  'If-None-Match': {
    description:
      'ETag of the last response. Unchanged (same gate version and minute) → **304** with no body (30 s auto-refresh).',
  },
} as const;
const ETAG = {
  ETag: {
    description:
      'Weak ETag = gate version + minute bucket + query; send it back as `If-None-Match`.',
  },
} as const;

const ERR = {
  stale: {
    summary: 'STALE_STATE',
    message: 'Not allowed while blocked',
    details: { reason: 'STALE_STATE', status: 'BLOCKED' },
  },
  inside: {
    summary: 'VEHICLE_INSIDE',
    message: 'Vehicle AP 37 BC 2210 is already inside (GE-2611-0041)',
    details: { reason: 'VEHICLE_INSIDE' },
  },
  rebook: {
    summary: 'REBOOKING_REQUIRED',
    message: 'Book a new dock slot for this re-delivery before gate-in',
    details: { reason: 'REBOOKING_REQUIRED' },
  },
  override: {
    summary: 'OVERRIDE_PENDING',
    message: 'A manual weighment is waiting for review',
    details: { reason: 'OVERRIDE_PENDING' },
  },
  security: {
    summary: 'SECURITY_HOLD',
    message: 'A security hold is open for this vehicle',
    details: { reason: 'SECURITY_HOLD' },
  },
  closed: {
    summary: 'ENTRY_CLOSED',
    message: 'The vehicle has left; weighments are closed',
    details: { reason: 'ENTRY_CLOSED' },
  },
  used: {
    summary: 'PASS_ALREADY_USED',
    message: 'Pass GPI-2611-0042 was already used',
    details: { reason: 'PASS_ALREADY_USED' },
  },
  expired: {
    summary: 'PASS_EXPIRED',
    message: 'The gate pass has expired; reissue it',
    details: { reason: 'PASS_EXPIRED' },
  },
  calibration: {
    summary: 'CALIBRATION_EXPIRED',
    message: 'Scale WB-01 calibration expired on 2026-11-01',
    details: { reason: 'CALIBRATION_EXPIRED' },
  },
  docs: {
    summary: 'DOCS_INCOMPLETE',
    message: 'Verify every required document first',
    details: { reason: 'DOCS_INCOMPLETE', missing: ['EWAY_BILL'] },
  },
  eway: {
    summary: 'EWAY_BILL_EXPIRED',
    message: 'The e-way bill expired on 2026-11-24',
    details: { reason: 'EWAY_BILL_EXPIRED' },
  },
  overPo: {
    summary: 'OVER_PO_QTY',
    message: 'More than the open quantity of RST-2611-0003',
    details: {
      reason: 'OVER_PO_QTY',
      issues: [{ variantId: IDS.area, code: 'OVER_PO_QTY', requested: 120, remaining: 100 }],
    },
  },
  dock: {
    summary: 'DOCK_BUSY',
    message: 'The dock door is booked for that time',
    details: { reason: 'DOCK_BUSY' },
  },
  version: {
    summary: 'VERSION_CONFLICT',
    message: 'Changed by someone else; reload it',
    details: { reason: 'VERSION_CONFLICT', currentVersion: 3 },
  },
  idem: {
    summary: 'IDEMPOTENCY_KEY_REUSED',
    message: 'This Idempotency-Key was already used with a different request',
    details: { reason: 'IDEMPOTENCY_KEY_REUSED' },
  },
  same: {
    summary: 'SAME_USER',
    message: 'The person who captured the weight cannot approve it',
    details: { reason: 'SAME_USER' },
  },
} as const;

// ── schemas ──

const named = Joi.object({
  id: Joi.string().allow(null),
  code: Joi.string().allow(null),
  name: Joi.string().allow(null),
});
const bay = Joi.object({
  dockDoorId: Joi.string().allow(null),
  code: Joi.string().allow(null).example('D4'),
});
const stage = Joi.string().valid(
  'EXPECTED',
  'ARRIVED',
  'WEIGHED_IN',
  'APPROVED',
  'UNLOADING',
  'UNLOADED',
  'WEIGHED_OUT',
  'PASS_OUT',
  'BLOCKED',
  'HELD',
  'REJECTED',
  'COMPLETED',
  'CANCELLED',
);
const entryStatus = Joi.string().valid(
  'ARRIVED',
  'WEIGHED_IN',
  'APPROVED',
  'UNLOADING',
  'UNLOADED',
  'WEIGHED_OUT',
  'PASS_OUT',
  'BLOCKED',
  'HELD',
  'REJECTED',
  'EXITED',
  'CANCELLED',
);

const shipmentRow = Joi.object({
  id: Joi.string(),
  shipmentNo: Joi.string().example('INB-2611-0001'),
  poRef: Joi.string().allow(null).example('RST-2611-0003'),
  vendor: named,
  purpose: Joi.string(),
  vehicleRegNo: Joi.string().allow(null).example('AP37BC2210'),
  vehicleDisplay: Joi.string().allow(null).example('AP 37 BC 2210'),
  payloadLabel: Joi.string().example('100 Bag 50 kg'),
  totalUnits: Joi.number().integer(),
  etaAt: Joi.string(),
  delayed: Joi.boolean(),
  bay,
  stage,
  stageLabel: Joi.string().example('Expected'),
  tab: Joi.string().allow(null).example('expected'),
  activeEntryId: Joi.string().allow(null),
  rebookingRequired: Joi.boolean(),
  attemptNo: Joi.number().integer(),
  actions: Joi.object({ view: Joi.boolean(), edit: Joi.boolean(), delete: Joi.boolean() }),
}).meta({ className: 'GateShipmentRow' });

const line = Joi.object({
  lineNo: Joi.number().integer(),
  variantId: Joi.string(),
  sku: Joi.string().allow(null).example('LF-050'),
  name: Joi.string().allow(null).example('Layer Feed 50kg'),
  packLabel: Joi.string().allow(null),
  expectedQty: Joi.number().integer().example(100),
  unitWeightKg: Joi.number().allow(null).example(50),
  declaredNetKg: Joi.number().allow(null).example(5000),
  declaredNetMt: Joi.string().allow(null).example('5.00 MT'),
}).meta({ className: 'GateShipmentLine' });

const manifest = {
  lines: Joi.array().items(line),
  totals: Joi.object({
    lineCount: Joi.number().integer(),
    totalUnits: Joi.number().integer().example(125),
    estimatedWeightKg: Joi.number().allow(null).example(5620),
    estimatedWeightMt: Joi.string().allow(null).example('5.62 MT'),
    weightComplete: Joi.boolean(),
  }),
};

const shipment = shipmentRow
  .keys({
    purposeLabel: Joi.string(),
    restockRequestId: Joi.string().allow(null),
    restockRequestNo: Joi.string().allow(null),
    vendorPoNo: Joi.string().allow(null),
    asnId: Joi.string().allow(null),
    sourceLocation: Joi.string().allow(null).example('Vendor Warehouse, Hyderabad'),
    transportType: Joi.string(),
    transportTypeLabel: Joi.string().example('Heavy Commercial Truck (6-Wheeler+)'),
    plannedVehicleRegNo: Joi.string().allow(null),
    plannedDriver: Joi.object({
      name: Joi.string().allow(null),
      mobile: Joi.string().allow(null).example('+91 98765 43210'),
    }),
    etaWithinMins: Joi.number().integer().allow(null).example(15),
    dockBookingId: Joi.string().allow(null),
    invoiceNetKg: Joi.number().allow(null),
    invoiceGrossKg: Joi.number().allow(null),
    palletCount: Joi.number().integer().allow(null),
    notes: Joi.string().allow(null),
    version: Joi.number().integer(),
    ...manifest,
  })
  .meta({ className: 'GateShipment' });

const weights = Joi.object({
  grossKg: Joi.number().allow(null).example(14250),
  grossAt: Joi.string().allow(null),
  tareKg: Joi.number().allow(null).example(8750),
  tareAt: Joi.string().allow(null),
  netKg: Joi.number().allow(null).example(5500),
  expectedLoadKg: Joi.number().allow(null),
  packagingAllowanceKg: Joi.number().allow(null),
  varianceKg: Joi.number().allow(null),
  toleranceKg: Joi.number().allow(null),
  basis: Joi.string().valid('INVOICE_GROSS', 'NET_PLUS_PACKAGING').allow(null),
  result: Joi.string().valid('WITHIN', 'BREACH', 'NO_DECLARED_WEIGHT').allow(null),
  exitCheckKg: Joi.number().allow(null),
  exitCheckResult: Joi.string().valid('WITHIN', 'MISMATCH').allow(null),
  tareOnRecord: Joi.object({ tareKg: Joi.number(), entryNo: Joi.string() }).allow(null),
});
const stepBar = Joi.object({
  current: Joi.number().integer().example(3),
  pause: Joi.object({
    kind: Joi.string().valid('BLOCKED', 'HELD'),
    reason: Joi.string().allow(null),
    since: Joi.string().allow(null),
  }).allow(null),
  steps: Joi.array().items(
    Joi.object({
      no: Joi.number().integer(),
      key: Joi.string().example('GROSS_WEIGHT'),
      label: Joi.string().example('Gross weight'),
      state: Joi.string().valid('DONE', 'CURRENT', 'PENDING', 'SKIPPED'),
    }),
  ),
}).meta({ className: 'GateStepBar' });

const entry = Joi.object({
  id: Joi.string(),
  entryNo: Joi.string().example('GE-2611-0042'),
  shipmentId: Joi.string(),
  shipmentNo: Joi.string(),
  warehouseId: Joi.string(),
  vehicleRegNo: Joi.string(),
  vehicleDisplay: Joi.string().example('MH 12 AB 1234'),
  vehicleType: Joi.string(),
  vehicleTypeLabel: Joi.string(),
  driver: Joi.object({
    name: Joi.string(),
    mobile: Joi.string().allow(null),
    licenceNo: Joi.string().allow(null).example('••••••4321'),
    verified: Joi.boolean(),
  }),
  plateMatched: Joi.boolean(),
  plateNote: Joi.string().allow(null),
  arrivedAt: Joi.string(),
  bay,
  status: entryStatus,
  statusLabel: Joi.string(),
  pausedFromStatus: entryStatus.allow(null),
  outcome: Joi.string().valid('COMPLETED', 'REJECTED').allow(null),
  weights,
  block: Joi.object().allow(null),
  hold: Joi.object().allow(null),
  rejection: Joi.object().allow(null),
  approval: Joi.object().allow(null),
  receiving: Joi.object({
    rcvNo: Joi.string().allow(null).example('RCV-2611-0042'),
    handoverAt: Joi.string().allow(null),
    unloadedAt: Joi.string().allow(null),
    dockInAt: Joi.string().allow(null),
    dockOutAt: Joi.string().allow(null),
    noReceipt: Joi.boolean(),
    noReceiptReason: Joi.string().allow(null),
  }),
  debitNoteRequired: Joi.boolean(),
  passOutAt: Joi.string().allow(null),
  exitedAt: Joi.string().allow(null),
  cancelledAt: Joi.string().allow(null),
  stepBar,
  liveRoute: Joi.object({ status: Joi.string().valid('NOT_AVAILABLE') }),
  version: Joi.number().integer(),
}).meta({ className: 'GateEntry' });

const doc = Joi.object({
  id: Joi.string(),
  docType: Joi.string().example('EWAY_BILL'),
  label: Joi.string().example('E-way bill'),
  refNo: Joi.string().allow(null).example('EWB-2026-9921'),
  validUntil: Joi.string().allow(null).example('2026-11-28'),
  fileName: Joi.string().allow(null),
  sizeBytes: Joi.number().integer().allow(null),
  sizeLabel: Joi.string().allow(null).example('1.2 MB'),
  contentType: Joi.string().allow(null),
  hasFile: Joi.boolean(),
  mediaPurged: Joi.boolean(),
  status: Joi.string().valid('PENDING', 'VERIFIED', 'REJECTED', 'EXEMPTED'),
  required: Joi.boolean(),
  expired: Joi.boolean(),
  carriedForward: Joi.boolean(),
  note: Joi.string().allow(null),
  uploadedAt: Joi.string(),
  verifiedAt: Joi.string().allow(null),
  verifiedBy: Joi.string().allow(null),
  action: Joi.string().valid('VERIFY', 'PREVIEW'),
  version: Joi.number().integer(),
}).meta({ className: 'GateDocument' });

const pass = Joi.object({
  id: Joi.string(),
  passNo: Joi.string().example('GPI-2611-0042'),
  type: Joi.string().valid('INWARD', 'OUTWARD'),
  title: Joi.string(),
  status: Joi.string().valid('ISSUED', 'USED', 'VOID'),
  outcome: Joi.string().allow(null),
  issuedAt: Joi.string(),
  issuedBy: Joi.string(),
  expiresAt: Joi.string(),
  usedAt: Joi.string().allow(null),
  voidedAt: Joi.string().allow(null),
  voidReason: Joi.string().allow(null),
  replacedById: Joi.string().allow(null),
  reissueOfId: Joi.string().allow(null),
  snapshot: Joi.object().description('Immutable print data (mobile masked, no licence number).'),
  qrToken: Joi.string()
    .allow(null)
    .description('Signed QR payload of a live ISSUED pass (render as QR).'),
}).meta({ className: 'GatePass' });

const weighment = Joi.object({
  id: Joi.string(),
  kind: Joi.string().valid('GROSS', 'TARE', 'EXIT_CHECK'),
  kindLabel: Joi.string().example('Second Weight (Gross)'),
  badge: Joi.string().valid('LOADED', 'EMPTY'),
  weightKg: Joi.number().example(14250),
  method: Joi.string().valid('MANUAL', 'OVERRIDE', 'REWEIGH'),
  scale: Joi.object({
    id: Joi.string().allow(null),
    code: Joi.string().allow(null).example('WB-01'),
  }),
  slipNo: Joi.string().allow(null),
  hasSlip: Joi.boolean(),
  status: Joi.string().valid('ACTIVE', 'SUPERSEDED', 'PENDING_APPROVAL', 'REJECTED'),
  reason: Joi.string().allow(null),
  capturedAt: Joi.string(),
  capturedBy: Joi.string(),
  reviewedAt: Joi.string().allow(null),
  reviewedBy: Joi.string().allow(null),
  reviewNote: Joi.string().allow(null),
  supersedesId: Joi.string().allow(null),
}).meta({ className: 'GateWeighment' });

const scale = Joi.object({
  id: Joi.string(),
  code: Joi.string().example('WB-01'),
  name: Joi.string(),
  maxCapacityKg: Joi.number(),
  divisionKg: Joi.number(),
  captureMethod: Joi.string().valid('MANUAL', 'DEVICE'),
  captureMethodLabel: Joi.string(),
  calibratedAt: Joi.string().allow(null),
  calibrationValidUntil: Joi.string().allow(null),
  calibration: Joi.string().valid('VALID', 'EXPIRED'),
  status: Joi.string(),
  connection: Joi.string().valid('NOT_AVAILABLE', 'UNKNOWN'),
  lastWeighedAt: Joi.string().allow(null),
  version: Joi.number().integer(),
}).meta({ className: 'GateScale' });

const card = Joi.object({ value: Joi.number(), caption: Joi.string() }).unknown(true);
const summary = Joi.object({
  date: Joi.string(),
  cards: Joi.object({ totalWeighments: card, completed: card, activeWeighing: card, held: card }),
  emptyState: Joi.object({
    todaysEntries: Joi.number().integer(),
    totalExit: Joi.number().integer(),
    inProgress: Joi.number().integer(),
    scheduledToday: Joi.number().integer(),
    empty: Joi.boolean(),
  }),
  delayed: Joi.number().integer(),
  rejectedToday: Joi.number().integer(),
  scale: Joi.object({ lastWeighedAt: Joi.string().allow(null), footer: Joi.string().allow(null) }),
  generatedAt: Joi.string(),
}).meta({ className: 'GateSummary' });

const reconciliation = Joi.object({
  entryId: Joi.string(),
  grossKg: Joi.number().allow(null),
  tareKg: Joi.number().allow(null),
  measuredNetKg: Joi.number().allow(null),
  declaredNetKg: Joi.number().allow(null),
  invoiceNetKg: Joi.number().allow(null),
  invoiceGrossKg: Joi.number().allow(null),
  packagingAllowanceKg: Joi.number().allow(null),
  expectedLoadKg: Joi.number().allow(null),
  basis: Joi.string().allow(null),
  varianceKg: Joi.number().allow(null),
  toleranceKg: Joi.number().allow(null),
  tolerance: Joi.object({ pct: Joi.number(), minKg: Joi.number() }),
  result: Joi.string().valid('WITHIN', 'BREACH', 'NO_DECLARED_WEIGHT').allow(null),
  resultLabel: Joi.string().example('0 kg · Within tolerance'),
  status: entryStatus,
  exitCheck: Joi.object({ kg: Joi.number().allow(null), result: Joi.string().allow(null) }),
}).meta({ className: 'GateReconciliation' });

const asn = Joi.object({
  id: Joi.string(),
  asnRef: Joi.string().example('ASN-2026-081'),
  vendor: Joi.object({ id: Joi.string(), name: Joi.string().allow(null) }),
  poRef: Joi.string().allow(null),
  etaAt: Joi.string(),
  arrivalWindow: Joi.string().example('2026-11-26 · 10:30'),
  expectedUnits: Joi.number().integer(),
  convertedUnits: Joi.number().integer(),
  declaredNetKg: Joi.number().allow(null),
  status: Joi.string(),
  statusLabel: Joi.string(),
  action: Joi.string().valid('REVIEW', 'MATCH_PO', 'SHIPMENT', 'VIEW'),
  matchIssues: Joi.array().items(
    Joi.object({ code: Joi.string(), message: Joi.string(), variantId: Joi.string() }),
  ),
  matchBanner: Joi.object({ tone: Joi.string(), title: Joi.string(), text: Joi.string() }),
  lines: Joi.array().items(Joi.object().unknown(true)),
})
  .unknown(true)
  .meta({ className: 'GateAsn' });

const appointment = Joi.object({
  id: Joi.string(),
  dock: Joi.object({ id: Joi.string(), code: Joi.string() }),
  plannedStart: Joi.string(),
  plannedEnd: Joi.string(),
  ref: Joi.string(),
  status: Joi.string().valid('CONFIRMED', 'EXPECTED', 'DELAYED', 'IN_USE', 'DONE', 'CANCELLED'),
  statusLabel: Joi.string(),
})
  .unknown(true)
  .meta({ className: 'GateAppointment' });

const visitor = Joi.object({
  id: Joi.string(),
  visitorNo: Joi.string().example('VIS-2611-0018'),
  name: Joi.string(),
  mobile: Joi.string().allow(null).example('+91 98••• ••210'),
  company: Joi.string().allow(null),
  purpose: Joi.string(),
  host: Joi.string().allow(null),
  status: Joi.string().valid('PENDING', 'ON_SITE', 'CHECKED_OUT', 'DENIED'),
  statusLabel: Joi.string(),
  action: Joi.string().valid('CHECK', 'VIEW'),
  entryAt: Joi.string().allow(null),
  exitAt: Joi.string().allow(null),
})
  .unknown(true)
  .meta({ className: 'GateVisitor' });

const outward = Joi.object({
  id: Joi.string(),
  omNo: Joi.string().example('OM-2611-0012'),
  material: Joi.string().example('Returnable pallets'),
  qty: Joi.number(),
  unit: Joi.string(),
  quantityLabel: Joi.string().example('12 units'),
  vehicleDisplay: Joi.string().allow(null),
  receiver: Joi.string().allow(null),
  status: Joi.string().valid('PENDING_AUTH', 'AUTHORIZED', 'EXITED', 'REJECTED'),
  statusLabel: Joi.string(),
})
  .unknown(true)
  .meta({ className: 'GateOutwardMaterial' });

const check = Joi.object({
  id: Joi.string(),
  subjectType: Joi.string().valid('ENTRY', 'VISITOR', 'OUTWARD'),
  subjectRef: Joi.string(),
  title: Joi.string().example('Gate GE-2611-0042'),
  summary: Joi.string().example('Identity verified · Plate match'),
  result: Joi.string().valid('CLEAR', 'HOLD'),
  status: Joi.string().valid('VERIFIED', 'PENDING', 'RESOLVED'),
  statusLabel: Joi.string(),
  source: Joi.string().valid('MANUAL', 'AUTO'),
})
  .unknown(true)
  .meta({ className: 'GateSecurityCheck' });

const obj = Joi.object().unknown(true);
const pageMeta = PAGE_META;

/** Route docs of one audience (panel `/wms`, admin `/admin/wms`). */
export const gateDocs = (aud: 'panel' | 'admin') => {
  const d = (
    area: string,
    summaryText: string,
    permission: string,
    o: Parameters<typeof wmsDoc>[4] = {},
  ) => wmsDoc(aud, area, summaryText, permission, o);
  const w = (
    area: string,
    summaryText: string,
    permission: string,
    o: Parameters<typeof wmsDoc>[4] & { examples?: RouteDocs['errorExamples'] } = {},
  ): RouteDocs => {
    const base = d(area, summaryText, permission, { errors: [404, 409, 422], ...o });
    return {
      ...base,
      headers: IDEMPOTENCY,
      ...(o.examples === undefined ? {} : { errorExamples: o.examples }),
    };
  };
  const cachedRead = (
    area: string,
    summaryText: string,
    data: Joi.Schema,
    description: string,
  ): RouteDocs => {
    const base = d(area, summaryText, 'gate.view', { data, description, errors: [404, 422] });
    return { ...base, headers: IF_NONE_MATCH, success: { ...base.success, headers: ETAG } };
  };
  return {
    // lookups
    lookups: d(
      GATE_AREA,
      'Gate lookups (types, purposes, documents, reasons, tolerance)',
      'gate.view',
      {
        data: obj,
        description: 'Dropdowns of every gate screen + effective settings. Cache 300 s.',
      },
    ),
    bays: d(GATE_AREA, 'Inbound bays (unloading doors) and status now', 'gate.view', {
      data: Joi.array().items(obj),
    }),
    scales: d(
      GATE_WEIGH_AREA,
      'Weighbridge scales (calibration, method, last weighed)',
      'gate.view',
      { data: Joi.array().items(scale) },
    ),
    purchaseOrders: d(
      GATE_AREA,
      'Open purchase orders (approved procurement requests) with remaining qty',
      'gate.view',
      {
        data: Joi.array().items(obj),
        description: 'Remaining = approved − received − open on the gate (shipments + ASNs).',
      },
    ),
    products: d(
      GATE_AREA,
      'Product search for shipment lines (name / SKU, pack, weight)',
      'gate.view',
      { data: Joi.array().items(obj) },
    ),
    // dashboard
    summary: cachedRead(
      GATE_AREA,
      'W5.01 KPI cards + empty-state cards',
      summary,
      'Total weighments (vs yesterday), completed (throughput), active (avg wait), held. Warehouse-local day.',
    ),
    statusMix: cachedRead(
      GATE_AREA,
      'W5.01 Vehicle Entry Status donut',
      obj,
      'Completed / in progress / pending shares of the day.',
    ),
    activity: d(GATE_AREA, 'W5.01 Recent activity (gate in / out, weighed, blocked)', 'gate.view', {
      data: Joi.array().items(obj),
      paginated: true,
    }),
    shipments: d(
      GATE_AREA,
      'W5.01 Inbound shipments table (tabs, search, bay, dates)',
      'gate.view',
      {
        data: Joi.array().items(shipmentRow),
        paginated: true,
        meta: pageMeta,
        description: 'Keyset by ETA. Trucks inside the gate are listed whatever the date range.',
      },
    ),
    counts: cachedRead(
      GATE_AREA,
      'W5.01 Tab badges (All / Expected / Arrived / In progress / Blocked)',
      obj,
      'Same filters as the table.',
    ),
    // shipments
    preview: w(GATE_AREA, 'W5.02–W5.04 Wizard preview (no write)', 'gate.operate', {
      data: obj,
      description:
        'Totals, expected load incl. packaging, suggested bay + slot, document checklist, PO remaining, per-step issues.',
    }),
    createShipment: w(GATE_AREA, 'W5.04 Save inbound shipment', 'gate.operate', {
      status: 201,
      data: shipment,
      description:
        'INB number, lines, documents (upload receipts) and the dock booking in ONE transaction. With a PO the PO row is locked and every line checked against its remaining qty.',
      examples: { 409: [ERR.overPo, ERR.dock, ERR.idem] },
    }),
    shipment: d(GATE_AREA, 'Inbound shipment (review / view)', 'gate.view', { data: shipment }),
    lines: d(GATE_AREA, 'Products manifest of a shipment', 'gate.view', { data: obj }),
    updateShipment: w(GATE_AREA, 'Edit an expected shipment', 'gate.operate', {
      data: shipment,
      description:
        'Only while EXPECTED. Line changes re-check the PO under its lock; time / door changes move the dock booking.',
      examples: { 409: [ERR.version, ERR.stale, ERR.overPo, ERR.dock] },
    }),
    cancelShipment: w(GATE_AREA, 'Cancel an expected shipment (soft delete)', 'gate.operate', {
      data: shipment,
    }),
    attachDoc: w(GATE_AREA, 'Attach a document (upload receipt and/or reference)', 'gate.operate', {
      status: 201,
      data: doc,
      description:
        'Upload first: `POST /v1/upload?purpose=gate_document` (PDF / JPEG / PNG / TIFF ≤ 25 MB).',
    }),
    removeDoc: {
      ...staffDoc(
        `${aud === 'admin' ? 'WMS Admin' : 'WMS Panel'} · ${GATE_AREA}`,
        'Remove an unverified document',
        'gate.operate',
        { status: 204, errors: [404, 409] },
      ),
    },
    previewDoc: d(GATE_AREA, 'W5.06a Document preview (5-minute signed URL)', 'gate.view', {
      data: obj,
    }),
    verifyDoc: w(GATE_ENTRY_AREA, 'Verify / reject / exempt a document', 'gate.operate', {
      data: doc,
      description:
        'E-way bill: validity date required and must not have passed. Reject / exempt need a note.',
      examples: { 409: [ERR.eway, ERR.stale] },
    }),
    // entries
    arrivals: d(
      GATE_ENTRY_AREA,
      'W5.05 Expected arrivals (shipment dropdown, prefilled)',
      'gate.view',
      { data: Joi.array().items(obj) },
    ),
    createEntry: w(GATE_ENTRY_AREA, 'W5.05 Gate entry (+ optional gross weight)', 'gate.operate', {
      status: 201,
      data: obj,
      description:
        'GE number, plate match (a different vehicle needs `plateNote`), bay; optional gross reading in the same transaction. Response feeds the W5.05a Gate-In confirmation.',
      examples: { 409: [ERR.inside, ERR.rebook, ERR.stale, ERR.calibration] },
    }),
    entry: d(GATE_ENTRY_AREA, 'Gate entry details (W5.05 / W5.08)', 'gate.view', { data: entry }),
    patchEntry: w(
      GATE_ENTRY_AREA,
      'Correct vehicle / driver / bay before approval',
      'gate.operate',
      { data: entry, examples: { 409: [ERR.version, ERR.stale, ERR.inside] } },
    ),
    cancelEntry: w(
      GATE_ENTRY_AREA,
      'Cancel a gate entry created by mistake (ARRIVED only)',
      'gate.operate',
      { data: entry },
    ),
    noReceipt: d(
      GATE_ENTRY_AREA,
      'Entries unloaded without a goods receipt (W6 follow-up)',
      'gate.view',
      { data: Joi.array().items(entry) },
    ),
    entryDocs: d(
      GATE_ENTRY_AREA,
      'W5.06 Document checklist + KPI cards + clearance hint',
      'gate.view',
      { data: obj },
    ),
    approve: w(GATE_ENTRY_AREA, 'W5.06b Approve entry → inward gate pass', 'gate.approve', {
      data: obj,
      description:
        'Guards: required documents verified / exempted, e-way bill in date, gross captured (setting), no pending override. Issues GPI in the same transaction.',
      examples: { 409: [ERR.docs, ERR.eway, ERR.override, ERR.stale] },
    }),
    block: w(GATE_ENTRY_AREA, 'W5.06c Block gate entry', 'gate.operate', {
      data: obj,
      description: 'Remembers the status it paused from; unblock resumes there.',
    }),
    unblock: w(GATE_ENTRY_AREA, 'Unblock (resume where it paused)', 'gate.approve', {
      data: entry,
    }),
    turnAway: w(GATE_ENTRY_AREA, 'Turn the truck away (before unloading)', 'gate.approve', {
      data: entry,
      description:
        'REJECTED; GP-IN voided and dock booking released in the same transaction. `shipmentAction` (REEXPECT → new slot + documents re-checked, or CANCEL) is applied at EXIT.',
    }),
    passes: d(GATE_ENTRY_AREA, 'W5.07 Gate passes + QR + handover chips', 'gate.view', {
      data: obj,
    }),
    handover: w(GATE_ENTRY_AREA, 'W5.07 Proceed to receiving (handover)', 'gate.operate', {
      data: obj,
      description: 'APPROVED → UNLOADING, RCV number, dock booking IN_USE, GP-IN used.',
      examples: { 409: [ERR.stale, ERR.dock] },
    }),
    unloaded: w(GATE_ENTRY_AREA, 'W5.07b Unloading complete (manual)', 'gate.operate', {
      data: obj,
      description:
        'A reason is required when no goods receipt (CN) is linked (sets `noReceipt`). The CN path: `POST /wms/stock/receipts` with `gateEntryId` + `finalForGate: true`.',
    }),
    receipts: d(GATE_ENTRY_AREA, 'Goods receipts (CN) linked to the entry', 'gate.view', {
      data: Joi.array().items(obj),
    }),
    timeline: d(GATE_ENTRY_AREA, 'W5.08 Timeline (gate events)', 'gate.view', { data: obj }),
    passPdf: {
      ...d(GATE_ENTRY_AREA, 'W5.07a Gate pass PDF (print / download)', 'gate.view', {
        errors: [404],
      }),
      success: { status: 200 as const, description: 'application/pdf' },
    },
    scan: w(GATE_ENTRY_AREA, 'Scan a gate pass QR (receiving desk / exit gate)', 'gate.operate', {
      data: obj,
      description:
        'Verifies the signature (key id) and expiry, then ISSUED → USED atomically: GP-IN performs the handover, GP-OUT the exit. Single use.',
      examples: { 409: [ERR.used, ERR.expired, ERR.stale] },
    }),
    reissue: w(GATE_ENTRY_AREA, 'Reissue a gate pass (expired / damaged)', 'gate.approve', {
      status: 201,
      data: pass,
      description:
        'Old pass VOID + new pass number in one transaction; only while the entry still needs it.',
    }),
    // weighbridge
    lookup: d(
      GATE_WEIGH_AREA,
      'W5.09 Find the active entry of a vehicle + next reading',
      'gate.view',
      { data: obj },
    ),
    weighments: d(
      GATE_WEIGH_AREA,
      'W5.09 / W5.10 Weighments (gross, tare, KPI row, history)',
      'gate.view',
      { data: obj },
    ),
    capture: w(GATE_WEIGH_AREA, 'Capture a reading (gross / tare / exit check)', 'gate.operate', {
      status: 201,
      data: obj,
      description:
        'Manual entry (live feed is Future). Refused on an expired calibration, tare ≥ gross, or above capacity. TARE reconciles against the expected load (invoice gross, else declared net + packaging); a breach or a missing declared weight → HELD. EXIT_CHECK (turned-away truck) must be ≈ gross, else an AUTO security hold blocks exit.',
      examples: { 409: [ERR.calibration, ERR.override, ERR.stale] },
    }),
    reconciliation: d(
      GATE_WEIGH_AREA,
      'W5.09b / W5.10 Net weight reconciliation + tolerance',
      'gate.view',
      { data: reconciliation },
    ),
    hold: w(GATE_WEIGH_AREA, 'W5.10b Record a weight hold', 'gate.operate', { data: entry }),
    resolveHold: w(
      GATE_WEIGH_AREA,
      'Resolve a hold (accept / reweigh / debit note)',
      'gate.approve',
      {
        data: entry,
        description:
          'Accept → WEIGHED_OUT (maker ≠ checker: not the tare capturer). REWEIGH supersedes the active reading in the same transaction and reconciles again. Debit note flags W6.12.',
        examples: { 409: [ERR.stale] },
      },
    ),
    override: w(
      GATE_WEIGH_AREA,
      'W5.10c Manual weighment override (save for review)',
      'gate.operate',
      { status: 201, data: weighment, examples: { 409: [ERR.override, ERR.closed] } },
    ),
    review: w(GATE_WEIGH_AREA, 'Approve / reject a manual weighment', 'gate.approve', {
      data: obj,
      description:
        'Maker ≠ checker. Approval supersedes the old reading and reconciles again (a late breach voids a live outward pass and holds the truck).',
    }),
    approvals: d(
      GATE_WEIGH_AREA,
      'Supervisor inbox (overrides, holds, security holds)',
      'gate.view',
      { data: obj },
    ),
    slipPdf: {
      ...d(GATE_WEIGH_AREA, 'Weighment slip PDF', 'gate.view', { errors: [404] }),
      success: { status: 200 as const, description: 'application/pdf' },
    },
    outwardPass: w(GATE_WEIGH_AREA, 'W5.09c Issue the outward gate pass', 'gate.operate', {
      data: obj,
      description:
        'Completed truck: confirm it was checked empty. Turned-away truck: exit check first (setting).',
      examples: { 409: [ERR.override, ERR.security, ERR.stale] },
    }),
    exit: w(GATE_WEIGH_AREA, 'W5.09d Confirm exit', 'gate.operate', {
      data: obj,
      description:
        'PASS_OUT → EXITED; applies a turned-away shipment action (REEXPECT / CANCEL) and re-checks documents for the re-delivery.',
      examples: { 409: [ERR.override, ERR.security, ERR.stale] },
    }),
    // appointments
    apptSummary: d(
      GATE_YARD_AREA,
      'W5.11 KPI cards (slots, booked, available, delayed)',
      'gate.view',
      { data: obj },
    ),
    apptSlots: d(GATE_YARD_AREA, 'W5.11 Time-slot strip of a day', 'gate.view', { data: obj }),
    appointments: d(GATE_YARD_AREA, 'W5.11 Booked vendor appointments', 'gate.view', {
      data: Joi.array().items(appointment),
      paginated: true,
      meta: pageMeta,
    }),
    apptBays: d(GATE_YARD_AREA, 'W5.11 Bay cards', 'gate.view', { data: Joi.array().items(obj) }),
    book: w(GATE_YARD_AREA, 'W5.11a Book a dock appointment', 'gate.operate', {
      status: 201,
      data: appointment,
      description: 'Also clears `rebookingRequired` of a turned-away shipment.',
      examples: { 409: [ERR.dock, ERR.stale] },
    }),
    appointment: d(GATE_YARD_AREA, 'One dock appointment', 'gate.view', { data: appointment }),
    reschedule: w(GATE_YARD_AREA, 'Reschedule a dock appointment', 'gate.operate', {
      data: appointment,
      examples: { 409: [ERR.dock, ERR.stale] },
    }),
    confirm: w(GATE_YARD_AREA, 'Mark an appointment confirmed by the vendor', 'gate.operate', {
      data: appointment,
    }),
    cancelAppt: w(GATE_YARD_AREA, 'Cancel a dock appointment', 'gate.operate', {
      data: appointment,
    }),
    // ASN
    asnSummary: d(GATE_YARD_AREA, 'W5.12 ASN KPI cards', 'gate.view', { data: obj }),
    asns: d(GATE_YARD_AREA, 'W5.12 Incoming advance shipping notices', 'gate.view', {
      data: Joi.array().items(asn),
      paginated: true,
      meta: pageMeta,
    }),
    asn: d(GATE_YARD_AREA, 'W5.12 ASN detail card', 'gate.view', { data: asn }),
    createAsn: w(GATE_YARD_AREA, 'Record a vendor ASN', 'gate.operate', {
      status: 201,
      data: asn,
      description: 'With a PO it is matched at once (PO row locked).',
    }),
    match: w(GATE_YARD_AREA, 'W5.12a Match ASN to purchase order', 'gate.operate', {
      data: asn,
      description:
        'PO row FOR UPDATE; vendor, SKUs and open qty checked → MATCHED / UNMATCHED with issues.',
    }),
    convert: w(GATE_YARD_AREA, 'Create shipment from ASN (all or some lines)', 'gate.operate', {
      status: 201,
      data: obj,
      description:
        'One shipment per truck (split consignments). ASN row locked; converted qty and the PO re-checked in one transaction.',
      examples: { 409: [ERR.overPo, ERR.stale] },
    }),
    // security
    secSummary: d(GATE_SECURITY_AREA, 'W5.13 KPI cards', 'gate.view', { data: obj }),
    visitors: d(GATE_SECURITY_AREA, 'W5.13 Visitor and contractor register', 'gate.view', {
      data: Joi.array().items(visitor),
      paginated: true,
      meta: pageMeta,
    }),
    visitor: d(GATE_SECURITY_AREA, 'One visitor', 'gate.view', { data: visitor }),
    createVisitor: w(GATE_SECURITY_AREA, 'W5.13a Record visitor entry', 'gate.security', {
      status: 201,
      data: visitor,
    }),
    visitorMove: w(GATE_SECURITY_AREA, 'Visitor check-in / check-out / deny', 'gate.security', {
      data: visitor,
    }),
    outward: d(GATE_SECURITY_AREA, 'W5.13 Outward material register', 'gate.view', {
      data: Joi.array().items(outward),
      paginated: true,
      meta: pageMeta,
    }),
    createOutward: w(
      GATE_SECURITY_AREA,
      'W5.13b Record outward material (OM pass)',
      'gate.security',
      { status: 201, data: outward },
    ),
    authorizeOutward: w(GATE_SECURITY_AREA, 'Authorize / reject outward material', 'gate.approve', {
      data: outward,
      description: 'Maker ≠ checker (not the person who recorded it).',
      examples: { 409: [ERR.stale] },
    }),
    exitOutward: w(GATE_SECURITY_AREA, 'Outward material leaves', 'gate.security', {
      data: outward,
      examples: { 409: [ERR.security, ERR.stale] },
    }),
    checks: d(GATE_SECURITY_AREA, 'W5.13 Recent security checks', 'gate.view', {
      data: Joi.array().items(check),
      paginated: true,
      meta: pageMeta,
    }),
    createCheck: w(GATE_SECURITY_AREA, 'W5.13c Save a security check', 'gate.security', {
      status: 201,
      data: check,
      description: 'Any FAIL → HOLD (remarks required); a clear visitor check admits the visitor.',
    }),
    resolveCheck: w(GATE_SECURITY_AREA, 'Resolve a security hold', 'gate.approve', { data: check }),
  };
};

/** Admin warehouse setup: scales + gate settings (`/admin/warehouses/:id/...`). */
export const GATE_ADMIN_DOCS = {
  scales: staffDoc(ADMIN_GATE_TAG, 'Weighbridge scales of a warehouse', 'gate.view', {
    data: Joi.array().items(scale),
  }),
  createScale: staffDoc(ADMIN_GATE_TAG, 'Add a weighbridge scale', 'gate.configure', {
    status: 201,
    data: scale,
    errors: [404, 409, 422],
  }),
  updateScale: staffDoc(ADMIN_GATE_TAG, 'Edit a scale (calibration, status)', 'gate.configure', {
    data: scale,
    errors: [404, 409, 422],
  }),
  deleteScale: staffDoc(ADMIN_GATE_TAG, 'Delete an unused scale', 'gate.configure', {
    status: 204,
    errors: [404, 409],
  }),
  settings: staffDoc(ADMIN_GATE_TAG, 'Gate settings (effective values)', 'gate.view', {
    data: obj,
  }),
  putSettings: staffDoc(
    ADMIN_GATE_TAG,
    'Override gate settings for this warehouse',
    'gate.configure',
    {
      data: obj,
      errors: [404, 422],
      description:
        'Tolerance, packaging allowance per purpose, required documents per purpose, slot length, delay grace, gross required, exit check on reject, pass validity, retention days.',
    },
  ),
};

export const GATE_INTERNAL_DOCS = {
  createAsn: { hide: true },
};
