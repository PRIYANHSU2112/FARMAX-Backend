import Joi from 'joi';

import { IF_VERSION, wmsDoc } from '../../docs/shared.js';
import { PAGE_META } from '../../middleware/paging.js';

export const FULFILMENT_AREA = 'Order fulfilment';
export const FLOOR_AREA = 'Fulfilment floor';
export const EXCEPTIONS_AREA = 'Order exceptions';

const any = Joi.object().unknown(true);
const list = Joi.array().items(any);
const PAGED =
  'Keyset paging: pass `meta.nextCursor` as `cursor`; numbered pagers may send `page` (offset ≤ 2,000 rows; deeper → 422 USE_CURSOR); `meta.total` exact up to 10,000.';
const CACHE =
  'Cached 20 s (`fresh=1` bypasses). `warehouseId` limits to one warehouse (404 outside scope).';
const STATE =
  '409 `TRANSITION_NOT_ALLOWED` / `ON_HOLD` / `INVALID_STATE` when the shipment is not at that step.';

const shipmentState = Joi.object({
  id: Joi.string(),
  shipmentNo: Joi.string().example('SHP-2611-0042'),
  status: Joi.string(),
  qcPassedAt: Joi.string().allow(null),
  palletCount: Joi.number().integer(),
  lines: Joi.array().items(
    Joi.object({
      lineNo: Joi.number().integer(),
      variantId: Joi.string(),
      ordered: Joi.number().integer(),
      allocated: Joi.number().integer(),
      picked: Joi.number().integer(),
      packed: Joi.number().integer(),
    }),
  ),
  version: Joi.number().integer(),
}).meta({ className: 'ShipmentFloorState' });

const lot = Joi.object({
  positionId: Joi.string(),
  batchId: Joi.string(),
  batchNo: Joi.string(),
  expiryDate: Joi.string().allow(null),
  daysLeft: Joi.number().integer().allow(null),
  expiryRisk: Joi.boolean(),
  bin: Joi.object({
    id: Joi.string(),
    code: Joi.string().allow(null),
    zone: Joi.string().allow(null),
    rack: Joi.string().allow(null),
  }).allow(null),
  available: Joi.number().integer(),
  eligible: Joi.boolean(),
  ineligibleReason: Joi.string()
    .valid('UNBINNED', 'EXPIRED', 'BELOW_MIN_SHELF_LIFE', 'EXPIRY_UNKNOWN')
    .allow(null),
  recommended: Joi.boolean().description('Picked by FEFO for the remaining quantity'),
  proposedQty: Joi.number().integer(),
}).meta({ className: 'FefoLot' });

export const fulfilmentDocs = (aud: 'panel' | 'admin') => {
  const d = (area: string, s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    wmsDoc(aud, area, s, p, o);
  const F = (s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    d(FULFILMENT_AREA, s, p, o);
  const L = (s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) => d(FLOOR_AREA, s, p, o);
  const E = (s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    d(EXCEPTIONS_AREA, s, p, o);
  return {
    // W3.01
    strip: F('Dashboard: 8-status strip', 'fulfilment.view', {
      data: any,
      description: `NEW = released; ALLOCATED = allocated + assigned; PICKING; PACKING = packing + QC; READY; DISPATCHED = dispatched + out for delivery; DELIVERED; FULFILLED; EXCEPTIONS = open. Plus active pick tasks (tote = task) and orders on hold. Trucks in transit arrive with dispatch (\`modules.dispatch\`). ${CACHE}`,
    }),
    kpis: F('Dashboard: 5 KPI cards', 'fulfilment.view', {
      data: any,
      description: `Orders received, dispatched, on-time dispatch % (today vs yesterday), mean cycle (release → dispatch, last 7 days vs the 7 before), open exceptions. From the daily counters. ${CACHE}`,
    }),
    trend: F('Dashboard: orders vs fulfilled trend', 'fulfilment.view', {
      data: any,
      description:
        'Per IST day in [from, to] (default last 7, max 92): orders received vs dispatched; change vs the previous period; mean turnaround minutes.',
    }),
    rate: F('Dashboard: fulfilment-rate donut', 'fulfilment.view', {
      data: any,
      description:
        'Shipments due in the range: rate = dispatched by the SLA ÷ due; within window (≤ onTimeWindowHours after release), buffer pick delay (late ≤ graceHours), critical (not dispatched + hold or open critical exception), late.',
    }),
    statusMix: F('Dashboard: order status donut', 'fulfilment.view', {
      data: any,
      description: 'Shipments created in the range by bucket (default last 30 days).',
    }),
    recent: F('Dashboard: recent orders', 'fulfilment.view', {
      data: any,
      description:
        'Newest active shipments with ETA (SLA due) and item summary (SKU count, kg). `route` arrives with the route master.',
    }),
    performance: F('Dashboard: warehouse performance', 'fulfilment.view', {
      data: any,
      description:
        'Per warehouse (or per warehouse type with `groupBy=type`) in the range: received, dispatched, on-time %, mean cycle, open shipments, open exceptions.',
    }),
    ops: F('Dashboard: ops footer', 'fulfilment.view', {
      data: any,
      description:
        'Docks in use, active dock doors, refresh hint (`refreshAfterSec`). Vehicle checks arrive with dispatch.',
    }),
    sync: F('Sync status (Live / SYNC)', 'fulfilment.view', {
      data: any,
      description:
        "Unpublished warehouse events and the oldest one's age; healthy when < 100 and < 60 s.",
    }),
    nav: F('Sidebar badges', 'fulfilment.view', {
      data: any,
      description:
        'New orders, open exceptions, compliance pending, orders on hold; backorders arrive with Phase 5.',
    }),
    // W3.02 / W3.03
    orderKpis: F('New Orders: KPIs + tab counts', 'fulfilment.view', {
      data: any,
      description:
        'New (pending release / released), paid, pending payment, needs allocation (open shortage / allocation exception), active count.',
    }),
    orders: F('New Orders: list', 'fulfilment.view', {
      paginated: true,
      data: list,
      meta: PAGE_META,
      description: `Tabs all · new · paid · pending · unassigned; search (order no, customer, farm, PIN, PO ref, phone last 4); payment, warehouse, PIN and date filters. Newest first. ${PAGED}`,
    }),
    orderOptions: F('New Orders: PIN / customer filter options', 'fulfilment.view', { data: list }),
    order: F('Order details (header, totals, actions)', 'fulfilment.view', {
      data: any,
      description:
        'Order info, payment instrument ("UPI · Paid in advance"), totals breakdown, shipments per warehouse, hold, and which actions are allowed now (allocate / hold / edit / cancel — edit and cancel only before picking).',
    }),
    customer: F('Order customer & farm', 'fulfilment.view', {
      data: any,
      description:
        'Name, phone, farm, address snapshot, map point, delivery instructions. Staff with fulfilment.view at the warehouse only.',
    }),
    items: F('Order items', 'fulfilment.view', {
      data: list,
      description:
        'SKU, unit, qty, price, total, stock status (ALLOCATED / IN_STOCK / SHORT) and per-warehouse allocation with ATP.',
    }),
    activity: F('Order activity timeline', 'fulfilment.view', { paginated: true, data: list }),
    audit: F('Order audit trail (W3.15)', 'fulfilment.view', {
      paginated: true,
      data: list,
      description: 'Audit rows of the order, its shipments, tasks and holds, newest first.',
    }),
    holdView: F('Hold parameters', 'fulfilment.view', { data: any }),
    hold: F('Hold order', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 422],
      description:
        'Stops forward moves. Unpicked allocations stay as soft allocations until keepAllocationHours (default 4, max 24) and may be borrowed by short orders; above holdReserveCapPct of sellable stock they are released at once. Picked / packed stock is never released.',
    }),
    holdPatch: F('Update hold (override expiration)', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 422],
      description: IF_VERSION,
    }),
    releaseHold: F('Release hold (back to picking)', 'fulfilment.manage', {
      data: any,
      errors: [404, 409],
    }),
    // W3.04
    candidates: F('Warehouse allocation candidates', 'fulfilment.view', {
      data: any,
      description:
        'Warehouses serving the delivery PIN ranked by score: PIN priority rank, stock fit (ALL / PARTIAL / NONE), distance (km), estimated delivery ("Same day (4–6 hrs)"), cold chain, routable, currently assigned.',
    }),
    map: F('Warehouse allocation map', 'fulfilment.view', { data: any }),
    allocate: F('Assign to a warehouse (reallocate)', 'fulfilment.reallocate', {
      status: 201,
      data: any,
      errors: [404, 409, 422],
      description:
        'GLOBAL fulfilment.reallocate. Saga: a local PENDING row locks the lines, inventory moves the reservation (idempotent key), then lines move to the target shipment → COMPLETED. A refusal → FAILED; a timeout stays PENDING and the recovery job retries; a failing local apply is reversed (COMPENSATED + critical exception). Lines being picked cannot move (409 NOT_EDITABLE_AFTER_PICK).',
    }),
    reallocation: F('Reallocation status', 'fulfilment.view', { data: any }),
    shelfCheck: F('Shelf-life check (W3.15)', 'fulfilment.view', {
      data: any,
      description:
        'Per line: minimum remaining days (most specific rule), earliest eligible expiry, whether allocated lots pass → AUTO-VALIDATED / FAILED.',
    }),
    // W3.05
    shipment: L('Shipment header (FEFO / assign)', 'fulfilment.view', { data: any }),
    lines: L('Shipment lines (allocated x/y)', 'fulfilment.view', { data: list }),
    lots: L('FEFO lots of a line', 'fulfilment.view', {
      data: Joi.object({
        lineNo: Joi.number(),
        remaining: Joi.number(),
        minShelfLifeDays: Joi.number(),
        lots: Joi.array().items(lot),
      }).unknown(true),
      description:
        'AVAILABLE lots at the warehouse, first-expiry-first-out (expiry unknown last); eligibility and the FEFO proposal for the remaining quantity.',
    }),
    summary: L('Allocation summary', 'fulfilment.view', { data: any }),
    allocations: L('Pick list (allocated lots + bins)', 'fulfilment.view', {
      data: list,
      description:
        'Batch, expiry colour (RED expired / AMBER near expiry / GREEN), bin / zone / rack, qty, picked.',
    }),
    reserve: L('Reserve stock (FEFO)', 'fulfilment.manage', {
      status: 201,
      data: any,
      errors: [404, 409, 422],
      description:
        "Lines without `picks` are auto-allocated FEFO. Explicit picks off the FEFO proposal need fulfilment.fefo_override + `overrideReason`. Needs compliance APPROVED / NOT_REQUIRED (409 COMPLIANCE_PENDING) and no hold. Short lines borrow held orders' soft lots, then raise a SHORTAGE exception (cause UNBINNED_STOCK when only unbinned opening stock would cover it). Shipment → ALLOCATED when complete.",
    }),
    changeBatch: L('Change batch', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 422],
      description:
        'Swap one unpicked allocation to another eligible lot (non-FEFO needs the override permission + reason).',
    }),
    release: L('Release allocations', 'fulfilment.manage', {
      data: any,
      errors: [404, 409],
      description:
        'Unpicked lots back to AVAILABLE (optionally one `lineNo`); shipment back to RELEASED; open task cancelled.',
    }),
    // W3.06
    operators: L('Operators (with open-task load)', 'fulfilment.view', { data: list }),
    template: L('Checklist template', 'fulfilment.view', { data: any }),
    assign: L('Assign pick-pack task', 'fulfilment.manage', {
      status: 201,
      data: any,
      errors: [404, 409, 422],
      description:
        'ALLOCATED → ASSIGNED; checklist from the template (cold-chain item only for cold shipments); deadline defaults to the SLA.',
    }),
    batch: L('Create pick batch (waves-lite)', 'fulfilment.manage', {
      status: 201,
      data: any,
      errors: [404, 409, 422],
      description: 'One batch B-YYMM-#### and one task per allocated shipment of one warehouse.',
    }),
    taskPatch: L('Reassign / reprioritise / cancel task', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 422],
      description: IF_VERSION,
    }),
    checklist: L('Tick checklist item', 'fulfilment.view', { data: any, errors: [404, 409] }),
    tasks: L('Tasks (my tasks)', 'fulfilment.view', {
      paginated: true,
      data: list,
      description: '`assignee=me` for the floor handheld.',
    }),
    task: L('Task detail', 'fulfilment.view', { data: any }),
    // W3.07
    pick: L('Pick units', 'inventory.pick', {
      data: shipmentState,
      errors: [404, 409, 422],
      description: `RESERVED → PICKED on the allocated lots (no lines = everything left). First pick → PICKING, task IN_PROGRESS. ${STATE}`,
    }),
    pickComplete: L('Pick complete', 'inventory.pick', {
      data: shipmentState,
      errors: [404, 409],
      description: `Every lot fully picked → PACKING (409 PICK_INCOMPLETE). ${STATE}`,
    }),
    pack: L('Pack', 'fulfilment.manage', {
      data: shipmentState,
      errors: [404, 409, 422],
      description: `PICKED → PACKED; packages (type BAG / BOX / PALLET / DRUM / CAN / CASK / TANK, weight, count) → QC. ${STATE}`,
    }),
    qc: L('QC result', 'fulfilment.manage', {
      data: shipmentState,
      errors: [404, 409, 422],
      description: `All checks of the QC template required. Pass → ready to stage; fail → back to PACKING + QUALITY exception; first-pass recorded. ${STATE}`,
    }),
    stage: L('Stage (ready to dispatch)', 'fulfilment.manage', {
      data: shipmentState,
      errors: [404, 409],
      description: `QC passed → READY_TO_DISPATCH at a staging area; task DONE. ${STATE}`,
    }),
    bulk: L('Processing bulk update', 'fulfilment.manage', {
      data: any,
      errors: [422],
      description:
        'ASSIGN · PICK_ALL · PICK_COMPLETE · STAGE · PRIORITY; each shipment on its own (results per id).',
    }),
    procCounts: L('Processing stage tabs + live batch', 'fulfilment.view', { data: any }),
    processing: L('Processing list', 'fulfilment.view', {
      paginated: true,
      data: list,
      meta: PAGE_META,
      description: `Stage tabs all · allocated · picking · packing · qc · ready; filters: search, release date, warehouse, customer, priority, operator, staging bay. SLA order. ${PAGED}`,
    }),
    procKpis: L('Processing footer KPIs', 'fulfilment.view', {
      data: any,
      description: `Picking velocity (avg pick start → packed today vs pickTargetMin), staging bay load (staged pallets ÷ staging capacity), QC first-pass (+ holds). ${CACHE}`,
    }),
    // W3.11
    exKpis: E('Exceptions KPIs + tabs', 'fulfilment.view', { data: any }),
    exceptions: E('Exceptions list', 'fulfilment.view', {
      paginated: true,
      data: list,
      meta: PAGE_META,
      description: `Default: open + in review, SLA order. Row: PO ref, package summary, cause, reported location, expected ref, struck-through cancelled order. ${PAGED}`,
    }),
    exCsv: E('Export exceptions (CSV)', 'fulfilment.view', {
      description: 'Same filters; streamed; CSV-injection safe. 5 per minute.',
    }),
    exception: E('Exception detail', 'fulfilment.view', { data: any }),
    exCreate: E('Raise an exception', 'inventory.exception_raise', {
      status: 201,
      data: any,
      errors: [404, 422],
    }),
    exPatch: E('Update exception', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 422],
      description: IF_VERSION,
    }),
    resolve: E('Resolve exception', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 422],
      description:
        'REALLOCATE {warehouseId} (saga) · RETRY_ALLOCATION (FEFO again) · RESTOCK / WRITE_OFF {positionId, qty, from?} (lifecycle move) · SPLIT / BACKORDER / PARTIAL_SHIP (planning, Phase 5) · CANCEL_LINES (use the order cancellation) · NO_ACTION.',
    }),
    exBulk: E('Mass re-route / hold / close / assign', 'fulfilment.manage', {
      data: any,
      errors: [422],
    }),
    sop: E('SOP card', 'fulfilment.view', { data: any }),
    sopPut: E('Edit SOP card', 'fulfilment.manage', { data: any, errors: [422] }),
    settings: F('Fulfilment settings', 'warehouse.configure', {
      data: any,
      description:
        'SLA hours, on-time window, grace, pick target, bulk kg, hold keep hours + cap, transit km/h, minimum shelf life, readiness bands, exception SLA hours, checklist + QC templates, SOP, allocation fallback, compliance limits.',
    }),
    settingsPut: F('Change fulfilment settings', 'warehouse.configure', {
      data: any,
      errors: [422],
    }),
    shelfRules: F('Shelf-life rules', 'fulfilment.view', { data: list }),
    shelfCreate: F('Create shelf-life rule', 'fulfilment.manage', {
      status: 201,
      data: any,
      errors: [422],
    }),
    shelfPatch: F('Update shelf-life rule', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 422],
      description: IF_VERSION,
    }),
    shelfDelete: F('Delete shelf-life rule', 'fulfilment.manage', { status: 204, errors: [404] }),
    reconcile: F('Allocation reconcile report', 'warehouse.configure', {
      data: any,
      description:
        'Latest WMS lines vs inventory reservations run (§2a.3): mismatches and the action taken (second-run rule).',
    }),
    // W4.05
    reservedKpis: F('Reserved stock KPIs (W4.05)', 'inventory.view', {
      data: any,
      description: `Reserved packs (allocated + picked), not yet allocated demand, reserved batches, release policy. ${CACHE}`,
    }),
    reservations: F('Reserved stock list (W4.05)', 'inventory.view', {
      paginated: true,
      data: list,
      description: `Tabs active (allocated lots; first page also lists demand not yet allocated as "Not allocated") · picked · released history. ${PAGED}`,
    }),
    reservation: F('Reservation detail', 'inventory.view', { data: any }),
  };
};
