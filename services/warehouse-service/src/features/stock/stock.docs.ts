import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';
import { IF_VERSION, wmsDoc } from '../../docs/shared.js';
import { OWNER_TYPES, STOCK_STATUSES } from './stock.rules.js';

export const STOCK_AREA = 'Stock';
export const LIFECYCLE_AREA = 'Stock lifecycle';
export const CUTOVER_AREA = 'Stock cutover';
export const OPS_AREA = 'Ops';
export const VENDORS_AREA = 'Vendors';

const IDEM =
  'Send an `Idempotency-Key` header (8–64 chars): a retry with the same key returns the first result (handheld / offline safe).';
const ENGINE =
  'Runs through the one stock write path: positions locked in id order, the W4.11 lifecycle checked, ledger row(s) written, unit QR updated for serialized batches, and `warehouse.stock_changed.v1` sent to inventory when sellable / damaged totals change. 423 `STOCK_WRITES_FROZEN` / `STOCK_NOT_CUTOVER` until the inventory → warehouse cutover is active.';

const receiptLine = Joi.object({
  lineNo: Joi.number().integer(),
  variantId: Joi.string().guid(),
  sku: Joi.string().allow(null).example('LF-050'),
  productName: Joi.string().allow(null).example('Layer Feed 50 kg'),
  batchId: Joi.string().guid(),
  batchNo: Joi.string().example('LF-2608'),
  expiryDate: Joi.string().allow(null).example('2027-01-15'),
  binId: Joi.string().guid().allow(null),
  qty: Joi.number().integer().example(40),
  ownerType: Joi.string().valid(...OWNER_TYPES),
  ownership: Joi.string().example('Vendor-owned (SOR)'),
  status: Joi.string()
    .valid(...STOCK_STATUSES)
    .example('QC_HOLD'),
});
const receipt = Joi.object({
  id: Joi.string().guid(),
  cnNo: Joi.string().example('CN-2611-0001'),
  warehouseId: Joi.string().guid(),
  sourceType: Joi.string(),
  vendorId: Joi.string().guid().allow(null),
  restockRequestId: Joi.string().guid().allow(null),
  notes: Joi.string().allow(null),
  receivedAt: Joi.date(),
  receivedBy: Joi.string().guid().allow(null),
  lines: Joi.array().items(receiptLine),
}).meta({ className: 'StockReceipt' });

const moveResult = Joi.object({
  qty: Joi.number().integer(),
  movements: Joi.number().integer(),
}).unknown(true);

const adjustment = Joi.object({
  id: Joi.string().guid(),
  adjNo: Joi.string().example('ADJ-2611-0007'),
  warehouseId: Joi.string().guid(),
  lines: Joi.array().items(
    Joi.object({ positionId: Joi.string(), status: Joi.string(), delta: Joi.number() }),
  ),
  totalUnits: Joi.number().integer(),
  reasonCode: Joi.string(),
  note: Joi.string().allow(null),
  status: Joi.string().valid('PENDING_APPROVAL', 'APPLIED', 'REJECTED'),
  requestedBy: Joi.string().guid(),
  decidedBy: Joi.string().guid().allow(null),
  version: Joi.number().integer(),
}).meta({ className: 'StockAdjustment' });

const threshold = Joi.object({
  warehouseId: Joi.string().guid(),
  variantId: Joi.string().guid(),
  safetyStock: Joi.number().integer(),
  reorderLevel: Joi.number().integer().description('Minimum (low-stock line)'),
  targetStock: Joi.number().integer().description('Restock target (par level)'),
  version: Joi.number().integer(),
}).meta({ className: 'StockThreshold' });

const transition = Joi.object({
  from: Joi.string(),
  to: Joi.string(),
  requiredEvent: Joi.string().example('Quality released'),
  authorizedRole: Joi.string().example('Authorized quality approver'),
  permissionKey: Joi.string().allow(null),
  systemOnly: Joi.boolean(),
  isActive: Joi.boolean(),
}).meta({ className: 'StockTransition' });

const proposal = Joi.object({
  id: Joi.string().guid(),
  fromStatus: Joi.string(),
  toStatus: Joi.string(),
  action: Joi.string().valid('ADD', 'REMOVE'),
  reasonEvent: Joi.string(),
  status: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED'),
  proposedBy: Joi.string().guid(),
  decidedBy: Joi.string().guid().allow(null),
  decisionNote: Joi.string().allow(null),
  createdAt: Joi.date(),
}).meta({ className: 'StockTransitionProposal' });

/** Docs of the D-57a stock commands for one audience. */
export const stockDocs = (aud: 'panel' | 'admin') => {
  const d = (area: string, s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    wmsDoc(aud, area, s, p, o);
  return {
    receive: d(STOCK_AREA, 'Receive stock (CN) / customer return (RT)', 'inventory.receive', {
      status: 201,
      data: receipt,
      errors: [404, 409, 422],
      description: `Interim goods receipt until the Gate / Receiving screens (W5/W6): creates the CN number and any new batches; lines land in QC hold (setting \`stock.qcOnReceipt\`). Ownership defaults to the vendor ↔ SKU model, else FarmX-owned. \`sourceType: RETURN\` books a customer return: number \`RT-YYMM-####\`, stock lands in RETURNED (then inspection → available / quarantine). \`restockRequestId\` links a procurement receipt to an approved W4.08 request (received quantities and status update in the same transaction). Units of serialized SKUs get unit QR labels. 409 \`BATCH_MISMATCH\` when a batch already exists with another expiry. ${IDEM} ${ENGINE}`,
    }),
    receipts: d(STOCK_AREA, 'Receipts (CN list)', 'inventory.view', {
      paginated: true,
      data: Joi.array().items(Joi.object().unknown(true)),
    }),
    receipt: d(STOCK_AREA, 'Receipt detail', 'inventory.view', { data: receipt }),
    generateUnits: d(STOCK_AREA, 'Generate unit QR for a batch', 'inventory.receive', {
      status: 201,
      data: Joi.object({
        batchId: Joi.string(),
        warehouseId: Joi.string(),
        generated: Joi.number(),
        serialized: Joi.boolean(),
      }),
      errors: [404, 409, 422],
      description:
        'One label per physical unit of the batch at this warehouse (codes `FX-<batchNo>-<seq>`, e.g. FX-LF-2608-0001; the SKU is inserted only when another SKU already uses that batch number); marks the batch serialized so later moves keep unit statuses in step. 409 `QR_ALREADY_GENERATED`.',
    }),
    coa: d(STOCK_AREA, 'Set COA / certificate of a batch', 'quality.hold_create', {
      data: Joi.object().unknown(true),
      description:
        'COA reference, certificate status and the PDF (media-service upload receipt, purpose `wms_document`).',
    }),
    release: d(
      STOCK_AREA,
      'Quality release (QC hold / quarantine / returned → available)',
      'quality.hold_release',
      {
        data: moveResult,
        errors: [404, 409, 422],
        description: `Releases all or \`qty\` units of a batch at a warehouse (optionally one bin). The W4.11 transition permission is checked at that warehouse. ${ENGINE}`,
      },
    ),
    hold: d(STOCK_AREA, 'Quality hold / quarantine', 'quality.hold_create', {
      data: moveResult,
      errors: [404, 409, 422],
      description: `Available → QC hold or quarantined, with a reason. ${ENGINE}`,
    }),
    statusChange: d(STOCK_AREA, 'Change stock status (lifecycle move)', 'per transition (W4.11)', {
      data: moveResult,
      errors: [404, 409, 422],
      description: `Damage, quarantine release, restock of returned stock, write-off … Allowed only when W4.11 lists the move; the caller needs that row's permission at the warehouse (system-only rows are refused). Reserved / picked / packed / in-transit moves belong to fulfilment and transfers. ${ENGINE}`,
    }),
    move: d(STOCK_AREA, 'Move stock to another bin', 'inventory.receive', {
      data: moveResult,
      description: `Put-away or restock to shelf. Clears the "bin" review field of opening stock. ${ENGINE}`,
    }),
    adjust: d(STOCK_AREA, 'Adjust quantities (count correction)', 'inventory.adjust', {
      status: 201,
      data: adjustment,
      errors: [404, 409, 422],
      description: `Above \`stock.adjustApprovalUnits\` the adjustment waits for a second person (PENDING_APPROVAL); otherwise it applies at once. ${IDEM}`,
    }),
    adjustments: d(STOCK_AREA, 'Adjustments', 'inventory.view', {
      paginated: true,
      data: Joi.array().items(adjustment),
    }),
    approveAdjustment: d(STOCK_AREA, 'Approve adjustment', 'inventory.adjust', {
      data: adjustment,
      errors: [404, 409, 422],
      description: `The approver must not be the requester. ${IF_VERSION}`,
    }),
    rejectAdjustment: d(STOCK_AREA, 'Reject adjustment', 'inventory.adjust', {
      data: adjustment,
      description: IF_VERSION,
    }),
    owner: d(STOCK_AREA, 'Fix the owner of a stock position', 'inventory.adjust', {
      data: Joi.object().unknown(true),
      description:
        'Moves every unit of the position to the new owner (SOR / FarmX / JIT + vendor). Clears the "ownerType" review field of opening stock. Audited with the reason.',
    }),
    relabel: d(STOCK_AREA, 'Relabel opening stock into real batches', 'inventory.receive', {
      data: Joi.object().unknown(true),
      errors: [404, 409, 422],
      description:
        'Opening-balance lots have no batch / expiry / bin. Split the available units into real batches (batch no, mfg, expiry, bin) — FEFO then treats them normally.',
    }),
    threshold: d(STOCK_AREA, 'Thresholds of one SKU at a warehouse', 'inventory.view', {
      data: threshold,
    }),
    setThreshold: d(STOCK_AREA, 'Set thresholds (min, safety, target)', 'warehouse.configure', {
      data: Joi.array().items(threshold),
      description:
        'WMS owns thresholds; each change is published one way to inventory (`warehouse.thresholds_changed.v1`) for storefront availability and low-stock.',
    }),
    setThresholdsBulk: d(STOCK_AREA, 'Set thresholds for many SKUs', 'warehouse.configure', {
      data: Joi.array().items(threshold),
    }),
    lifecycle: d(LIFECYCLE_AREA, 'Lifecycle overview (journey + side states)', 'inventory.view', {
      data: Joi.object().unknown(true),
    }),
    transitions: d(LIFECYCLE_AREA, 'Allowed transitions', 'inventory.view', {
      data: Joi.array().items(transition),
    }),
    proposals: d(LIFECYCLE_AREA, 'Rule change history (proposals)', 'inventory.view', {
      paginated: true,
      data: Joi.array().items(proposal),
    }),
    propose: d(LIFECYCLE_AREA, 'Propose a transition rule', 'warehouse.configure', {
      status: 201,
      data: proposal,
      description:
        'A proposed change needs approval by another person in Admin & Governance (admin panel).',
    }),
    approveProposal: d(
      LIFECYCLE_AREA,
      'Approve a transition proposal',
      'inventory.lifecycle_approve',
      {
        data: proposal,
        errors: [404, 409, 422],
        description:
          'Approver ≠ proposer. Approving an ADD needs the permission key that allows the move.',
      },
    ),
    rejectProposal: d(
      LIFECYCLE_AREA,
      'Reject a transition proposal',
      'inventory.lifecycle_approve',
      { data: proposal },
    ),
    settings: d(STOCK_AREA, 'Stock settings', 'inventory.configure', {
      data: Joi.object().unknown(true),
    }),
    setSettings: d(STOCK_AREA, 'Change stock settings', 'inventory.configure', {
      data: Joi.object().unknown(true),
      description:
        'GLOBAL or per-warehouse (`?scope=<warehouseId>`). The writes mode and cutover state change only through the cutover API.',
    }),
    cutoverStatus: d(
      CUTOVER_AREA,
      'Cutover status (inventory → warehouse)',
      'inventory.configure',
      {
        data: Joi.object().unknown(true),
        description:
          'Writes mode on both sides (INVENTORY · FROZEN · WMS), in-flight inventory operations, freeze deadline, last report.',
      },
    ),
    cutoverFreeze: d(CUTOVER_AREA, 'Freeze stock writes (cutover step 2)', 'inventory.configure', {
      data: Joi.object().unknown(true),
      errors: [409, 422, 503],
      description:
        'Both services refuse stock and threshold writes (423 STOCK_WRITES_FROZEN). Checkout, reservations and orders keep running. The freeze ends automatically after `stock.freezeMaxMinutes` (default 120) unless the cutover is activated; `warehouse.stock_cutover.v1` tells the people who edit stock.',
    }),
    cutoverRun: d(CUTOVER_AREA, 'Run the cutover (steps 3–6)', 'inventory.configure', {
      data: Joi.object().unknown(true),
      errors: [409, 503],
      description:
        'Rejects still-pending inventory operations (CUTOVER_MOVED_TO_WMS, listed in the report), snapshots inventory, imports opening balances (batch OPENING, no bin / expiry, FarmX-owned, flagged for review) — or replays inventory ledger rows after a rollback (tables are never truncated) — verifies WMS sellable / damaged = inventory onHand / damaged for every warehouse × SKU, then activates. A mismatch keeps both sides FROZEN (409 CUTOVER_MISMATCH with the list).',
    }),
    cutoverAbort: d(CUTOVER_AREA, 'Abort the freeze', 'inventory.configure', {
      data: Joi.object().unknown(true),
      errors: [409, 503],
    }),
    cutoverRollback: d(CUTOVER_AREA, 'Roll back to inventory (≤ 72 h)', 'inventory.configure', {
      data: Joi.object().unknown(true),
      errors: [409, 503],
      description:
        'Only within `stock.rollbackWindowHours` of activation (409 ROLLBACK_WINDOW_CLOSED after; fix forward). WMS stock tables turn read-only and keep batches, bins, QC hold and quarantine; a later re-cutover replays the inventory changes made meanwhile.',
    }),
    vendors: d(VENDORS_AREA, 'Vendors', 'inventory.view', {
      paginated: true,
      data: Joi.array().items(Joi.object().unknown(true)),
      description:
        'Search by name / code; `variantId` = vendors that supply that SKU (restock form).',
    }),
    vendor: d(VENDORS_AREA, 'Vendor detail (+ supplied SKUs)', 'inventory.view', {
      data: Joi.object().unknown(true),
    }),
    createVendor: d(VENDORS_AREA, 'Add vendor', 'vendors.manage', {
      status: 201,
      data: Joi.object().unknown(true),
      errors: [409, 422],
    }),
    updateVendor: d(VENDORS_AREA, 'Edit vendor', 'vendors.manage', {
      data: Joi.object().unknown(true),
      errors: [404, 409, 422],
      description: IF_VERSION,
    }),
    vendorVariants: d(
      VENDORS_AREA,
      'Set supplied SKUs (ownership, lead time, MOQ, preferred, unit QR)',
      'vendors.manage',
      {
        data: Joi.object().unknown(true),
        description:
          'Replaces the list. Ownership decides how received stock is owned (SOR / FarmX / JIT); `requiresUnitQr` makes its batches serialized.',
      },
    ),
    maintenance: d(OPS_AREA, 'Maintenance banner', 'warehouse.view', {
      data: Joi.object({
        active: Joi.boolean(),
        phase: Joi.string().allow(null),
        startsAt: Joi.string().allow(null),
        endsAt: Joi.string().allow(null),
        message: Joi.string().allow(null),
      }),
      description:
        'Shown on every screen while stock writes are frozen for the cutover (start, deadline, reason).',
    }),
    jobs: d(OPS_AREA, 'Background jobs', 'inventory.configure', {
      data: Joi.object().unknown(true),
      description:
        'Each job: schedule, last success (heartbeat), stale flag; dead-letter count and latest dead letters. Failure policy: 5 tries with exponential backoff → dead-letter (14 days) → `warehouse.job_failed.v1` alert.',
    }),
    replayJob: d(OPS_AREA, 'Replay a dead-lettered job', 'inventory.configure', {
      data: Joi.object({ replayed: Joi.boolean() }),
    }),
    reconcile: d(OPS_AREA, 'Latest reconcile report', 'inventory.configure', {
      data: Joi.object().unknown(true),
      description:
        'type=stock: WMS sellable / damaged vs inventory onHand / damaged per warehouse × SKU, and unit QR vs columns (nightly). type=allocation arrives with fulfilment (D-57b).',
    }),
  } satisfies Record<string, RouteDocs>;
};
