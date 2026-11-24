import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';
import { wmsDoc } from '../../docs/shared.js';
import { PAGE_META } from '../../middleware/paging.js';
import { STOCK_AREA } from './stock.docs.js';

const KEY = 'inventory.view';
const CACHE =
  'Cached 20 s (`fresh=1` bypasses, e.g. the SYNC button). `warehouseId` limits to one warehouse (404 outside scope); without it the whole scope is summed.';
const PAGED =
  'Keyset paging: pass `meta.nextCursor` as `cursor`. Numbered pagers may send `page` (offset ≤ 2,000 rows; deeper → 422 USE_CURSOR). `meta.total` is exact up to 10,000.';

const named = Joi.object({
  id: Joi.string(),
  code: Joi.string().allow(null),
  name: Joi.string().allow(null),
}).unknown(true);
const totals = Joi.object({
  onHand: Joi.number().integer().description('Physical packs (every status in the warehouse)'),
  available: Joi.number().integer(),
  reserved: Joi.number().integer().description('reserved + picked + packed'),
  qcHold: Joi.number().integer(),
  damaged: Joi.number().integer(),
  quarantined: Joi.number().integer(),
  expired: Joi.number().integer(),
  returned: Joi.number().integer(),
  blocked: Joi.number().integer(),
  onHold: Joi.number().integer(),
  asOf: Joi.string(),
}).meta({ className: 'StockTotals' });

const record = Joi.object({
  positionId: Joi.string(),
  product: Joi.object({
    variantId: Joi.string(),
    sku: Joi.string(),
    name: Joi.string(),
    packLabel: Joi.string(),
    imageUrl: Joi.string().allow(null),
  }),
  brand: Joi.string().allow(null),
  vendor: named.allow(null),
  warehouse: named,
  batch: Joi.object({
    id: Joi.string(),
    batchNo: Joi.string(),
    mfgDate: Joi.string().allow(null),
    isOpening: Joi.boolean(),
  }),
  bin: Joi.object({ id: Joi.string(), code: Joi.string().allow(null) }).allow(null),
  onHand: Joi.number().integer(),
  available: Joi.number().integer(),
  reserved: Joi.number().integer(),
  expiryDate: Joi.string().allow(null),
  ownership: Joi.string(),
  reviewFields: Joi.array().items(Joi.string()),
}).meta({ className: 'StockRecord' });

const movement = Joi.object({
  id: Joi.string(),
  at: Joi.date(),
  type: Joi.string(),
  movement: Joi.string().example('Transfer out'),
  sku: Joi.string().allow(null),
  batchNo: Joi.string().allow(null),
  warehouse: named,
  quantity: Joi.number()
    .integer()
    .description('Signed for receipts / issues / transfers; plain qty for status changes'),
  signed: Joi.boolean(),
  reference: Joi.string().allow(null).example('TR-2611-0041'),
}).meta({ className: 'StockMovement' });

const alert = Joi.object({
  product: Joi.object({ variantId: Joi.string(), sku: Joi.string(), name: Joi.string() }),
  warehouse: named,
  vendor: named.allow(null),
  brand: Joi.string().allow(null),
  available: Joi.number().integer(),
  minimum: Joi.number().integer(),
  target: Joi.number().integer(),
  inbound: Joi.number().integer(),
  levelPct: Joi.number().allow(null),
  suggested: Joi.number().integer(),
  state: Joi.string().valid('LOW', 'OUT', 'OK'),
}).meta({ className: 'StockAlert' });

/** Docs of the W4 reads for one audience. */
export const stockReadDocs = (aud: 'panel' | 'admin') => {
  const d = (s: string, o: Parameters<typeof wmsDoc>[4] = {}) => wmsDoc(aud, STOCK_AREA, s, KEY, o);
  const list = (s: string, data: Joi.Schema, description = '') =>
    d(s, {
      paginated: true,
      data: Joi.array().items(data),
      meta: PAGE_META,
      description: `${description} ${PAGED}`.trim(),
    });
  return {
    landingKpis: d('W4.00 In-stock KPIs (total, available, reserved, on hold)', {
      data: Joi.object({
        totalStock: Joi.number(),
        available: Joi.number(),
        reserved: Joi.number(),
        onHold: Joi.number(),
        unit: Joi.string(),
        asOf: Joi.string(),
      }),
      description: `On hold = QC hold + quarantined + damaged + expired + returned. ${CACHE}`,
    }),
    landingByCategory: d('W4.00 Stock by category (+ location text, top mover)', {
      data: Joi.object().unknown(true),
      description: `Top root categories by physical qty with share %, the zones / rack ranges holding them ("Racks B-01–B-08 · Dry Zone"), an "Others" bucket, active segment count and the most issued SKU of the last 7 days. ${CACHE}`,
    }),
    landingStatusMix: d('W4.00 Stock by status + fulfilment readiness', {
      data: Joi.object().unknown(true),
      description: `Available / reserved / on hold shares. \`readiness\` (Optimal ≥ 90 · Watch 75–90 · Critical < 75) is filled once fulfilment is live (modules.fulfilment). ${CACHE}`,
    }),
    categoryMatrix: d('Inspect matrix (category × warehouse)', {
      data: Joi.object().unknown(true),
      description: CACHE,
    }),
    products: list(
      'Product list (one row per SKU)',
      Joi.object().unknown(true),
      'Search (SKU / name / brand), category (incl. sub-categories), brand, vendor, stock state (ok / low / out), warehouse; sort by name / available / on hand.',
    ),
    overviewKpis: d('W4.01 KPIs (on hand, available, reserved, QC hold, damaged, quarantined)', {
      data: totals,
      description: CACHE,
    }),
    overviewWarehouses: d('W4.01 Warehouse stock table (+ share of stock)', {
      data: Joi.array().items(Joi.object().unknown(true)),
      description: CACHE,
    }),
    overviewStatusMix: d('W4.01 Stock status donut', {
      data: Joi.object().unknown(true),
      description: `Blocked = damaged + quarantined + expired (+ returned awaiting inspection). ${CACHE}`,
    }),
    records: list(
      'W4.02 All stock (warehouse × batch × bin × owner)',
      record,
      'Filters: search (SKU, product, batch or bin code), brand, category, vendor, batch, bin, expiry bucket, stock status, min / max available, date type (receipt / expiry / mfg) + from / to.',
    ),
    recordsCsv: d('W4.02 Export CSV (same filters)', {
      description:
        'Streamed `text/csv`; cells starting with = + - @ are neutralised. 5 exports / minute.',
    }),
    filterOptions: d('Filter dropdown options (typeahead)', { data: Joi.array().items(named) }),
    productHeader: d('W4.03 Product header (image, SKU, brand, category, vendor)', {
      data: Joi.object().unknown(true),
    }),
    productKpis: d('W4.03 Product KPIs', { data: totals }),
    productWarehouses: d('W4.03 Stock by warehouse', {
      data: Joi.array().items(Joi.object().unknown(true)),
    }),
    productBatches: d('W4.03 Batches tab', {
      data: Joi.array().items(Joi.object().unknown(true)),
      description: 'FEFO order; opening balances (no expiry) last.',
    }),
    productAvailability: d('W4.03 Availability tab', {
      data: Joi.object().unknown(true),
      description: 'Only released (AVAILABLE) stock can be promised to customer orders.',
    }),
    productMovements: list('W4.03 Movement history', movement),
    productUnits: list('Unit QR records of a product', Joi.object().unknown(true)),
    batchHeader: d('W4.04 Batch header (CN, warehouse, mfg, expiry, bins, ownership, quality)', {
      data: Joi.object().unknown(true),
    }),
    batchKpis: d('W4.04 Batch KPIs', { data: totals }),
    batchTraceability: d('W4.04 Batch overview / traceability', {
      data: Joi.object().unknown(true),
      description: 'Receipt (CN) → bins → transfers / issues.',
    }),
    batchUnits: list(
      'W4.04 QR units tab',
      Joi.object().unknown(true),
      'Unit QR (FX-<batch>-<seq>), bin and status; serialized batches only.',
    ),
    unit: d('View one unit (QR)', { data: Joi.object().unknown(true) }),
    batchQuality: d('W4.04 COA & quality tab', {
      data: Joi.object().unknown(true),
      description:
        'COA reference, certificate status, quality review and a 5-minute signed link to the COA PDF.',
    }),
    batchMovements: list('W4.04 Batch movement history', movement),
    movements: list(
      'W4.09 Movement ledger',
      movement,
      'Filter by movement type, warehouse, SKU, batch, reference, dates.',
    ),
    movementsCsv: d('W4.09 Export ledger CSV', {
      description: 'Streamed `text/csv`. 5 exports / minute.',
    }),
    movement: d('W4.09 Movement details', {
      data: Joi.object().unknown(true),
      description: 'Statuses, bin, deltas sent to inventory, reason and actor.',
    }),
    ownershipKpis: d('W4.10 Ownership KPIs (SOR, FarmX, JIT)', {
      data: Joi.object().unknown(true),
      description: CACHE,
    }),
    ownership: list('W4.10 Stock by ownership', Joi.object().unknown(true)),
    alertKpis: d('W4.06 Depletion KPIs', { data: Joi.object().unknown(true), description: CACHE }),
    alerts: list(
      'W4.06 SKU depletion alerts (all / low / out)',
      alert,
      'Low = 0 < available ≤ minimum; out = no sellable stock where a minimum or target is set. Suggested = target (or minimum) − available − open inbound.',
    ),
    alertCount: d('Header badge "Alerts · n"', {
      data: Joi.object({ count: Joi.number(), low: Joi.number(), out: Joi.number() }),
    }),
    restockPlan: list(
      'W4.07 Monthly restock plan',
      alert,
      'Filters: month, vendor, brand, warehouse.',
    ),
    restockPlanItem: d('W4.07 Review one plan line', {
      data: Joi.object().unknown(true),
      description: 'Last 3 months of issues, open inbound, lead time, target and suggestion.',
    }),
  } satisfies Record<string, RouteDocs>;
};
