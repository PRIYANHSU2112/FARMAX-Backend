import Joi from 'joi';
import { IF_VERSION, wmsDoc } from '../../docs/shared.js';
import { PAGE_META } from '../../middleware/paging.js';

export const RESTOCK_AREA = 'Restock & transfers';

const named = Joi.object({
  id: Joi.string(),
  code: Joi.string().allow(null),
  name: Joi.string().allow(null),
});

const summary = Joi.object({
  id: Joi.string(),
  requestNo: Joi.string().example('RST-2611-0007'),
  type: Joi.string().valid('PROCUREMENT', 'TRANSFER'),
  typeLabel: Joi.string().example('Warehouse transfer'),
  destination: named,
  source: named.allow(null),
  requiredBy: Joi.string().allow(null).example('2026-12-05'),
  periodMonth: Joi.string().allow(null).example('2026-11'),
  status: Joi.string(),
  statusLabel: Joi.string().example('Pending approval'),
  products: Joi.number().integer(),
  requestedPacks: Joi.number().integer(),
  createdAt: Joi.string(),
}).meta({ className: 'RestockRequestSummary' });

const request = summary
  .keys({
    vendor: named.allow(null),
    notes: Joi.string().allow(null),
    decisionNote: Joi.string().allow(null),
    submittedAt: Joi.string().allow(null),
    decidedAt: Joi.string().allow(null),
    version: Joi.number().integer(),
    lines: Joi.array().items(
      Joi.object({
        variantId: Joi.string(),
        sku: Joi.string().allow(null),
        name: Joi.string().allow(null),
        available: Joi.number().integer(),
        suggestedQty: Joi.number().integer(),
        requestedQty: Joi.number().integer(),
        approvedQty: Joi.number().integer().allow(null),
        dispatchedQty: Joi.number().integer(),
        receivedQty: Joi.number().integer(),
      }),
    ),
    approvalSummary: Joi.object({
      products: Joi.number().integer(),
      requestedPacks: Joi.number().integer(),
      requestType: Joi.string(),
      status: Joi.string(),
      note: Joi.string(),
    }),
  })
  .meta({ className: 'RestockRequest' });

const transferSummary = Joi.object({
  id: Joi.string(),
  trNo: Joi.string().example('TR-2611-0003'),
  restockRequestId: Joi.string().allow(null),
  source: named,
  destination: named,
  status: Joi.string().valid('IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'),
  dispatchedAt: Joi.string(),
  etaAt: Joi.string().allow(null),
  receivedAt: Joi.string().allow(null),
  units: Joi.number().integer(),
  receivedUnits: Joi.number().integer(),
}).meta({ className: 'TransferSummary' });

const transfer = transferSummary
  .keys({
    lines: Joi.array().items(
      Joi.object({
        lineNo: Joi.number().integer(),
        variantId: Joi.string(),
        sku: Joi.string().allow(null),
        name: Joi.string().allow(null),
        batchId: Joi.string(),
        batchNo: Joi.string().allow(null),
        ownerType: Joi.string(),
        qty: Joi.number().integer(),
        receivedQty: Joi.number().integer(),
      }),
    ),
  })
  .meta({ className: 'Transfer' });

const PAGED =
  'Keyset paging: pass `meta.nextCursor` as `cursor`. Numbered pagers may send `page` (offset ≤ 2,000 rows; deeper → 422 USE_CURSOR); `meta.total` is exact up to 10,000.';
const SOD =
  'Segregation of duties: the creator or submitter cannot approve or reject (403). "Inventory is not updated until approved stock is received."';

export const restockDocs = (aud: 'panel' | 'admin') => {
  const d = (s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    wmsDoc(aud, RESTOCK_AREA, s, p, o);
  return {
    prefill: d('Prefill products to replenish (W4.01 Plan restock / W4.08)', 'inventory.view', {
      data: Joi.array().items(
        Joi.object({
          variantId: Joi.string(),
          sku: Joi.string().allow(null),
          name: Joi.string().allow(null),
          warehouseId: Joi.string(),
          available: Joi.number().integer(),
          minimum: Joi.number().integer(),
          target: Joi.number().integer(),
          inbound: Joi.number().integer(),
          suggestedQty: Joi.number().integer(),
        }),
      ),
      description:
        'Current available, minimum (reorder level), target, open inbound and suggested quantity = max(target − available − inbound, 0) for each SKU (`variantIds` comma-separated, max 100).',
    }),
    create: d('Create a restock request (draft)', 'inventory.restock_request', {
      status: 201,
      data: request,
      errors: [404, 422],
      description:
        'Procurement (vendor required) or warehouse transfer (source warehouse required, ≠ destination). Number `RST-YYMM-####`. Saved as DRAFT; `submit` sends it for approval. Each SKU once; the available and suggested quantities at request time are kept on the line.',
      requestExample: {
        type: 'TRANSFER',
        destWarehouseId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a02',
        sourceWarehouseId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a01',
        requiredBy: '2026-12-05',
        notes: 'Monthly top-up',
        lines: [{ variantId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9a01', requestedQty: 120 }],
      },
    }),
    list: d('Restock requests (W4.07 Submitted)', 'inventory.view', {
      paginated: true,
      data: Joi.array().items(summary),
      meta: PAGE_META,
      description: `Requests for or from the caller's warehouses (destination or source), newest first. Filters: month (YYYY-MM), status, type, warehouseId. ${PAGED}`,
    }),
    view: d('Restock request + approval summary (W4.08)', 'inventory.view', { data: request }),
    update: d('Edit a draft request', 'inventory.restock_request', {
      data: request,
      errors: [404, 409, 422],
      description: `Only a DRAFT. \`lines\` replaces all lines. ${IF_VERSION}`,
    }),
    submit: d('Submit for approval (confirm modal)', 'inventory.restock_request', {
      data: request,
      errors: [404, 409],
      description: 'DRAFT → PENDING_APPROVAL.',
    }),
    cancel: d('Cancel a request', 'inventory.restock_request', {
      data: request,
      errors: [404, 409],
      description:
        'DRAFT, PENDING_APPROVAL or APPROVED (before any dispatch / receipt) → CANCELLED.',
    }),
    approve: d('Approve a restock request', 'inventory.restock_approve', {
      data: request,
      errors: [404, 409, 422],
      description: `Admin panel only (GLOBAL). PENDING_APPROVAL → APPROVED; \`lines\` may lower the approved quantity per SKU (default = requested). ${SOD}`,
    }),
    reject: d('Reject a restock request', 'inventory.restock_approve', {
      data: request,
      errors: [404, 409, 422],
      description: `Admin panel only (GLOBAL). Reason required. ${SOD}`,
    }),
    dispatch: d('Dispatch an approved transfer (source warehouse)', 'inventory.transfer', {
      status: 201,
      data: transfer,
      errors: [404, 409, 422],
      description:
        'FEFO picks from binned, unexpired AVAILABLE lots at the source; stock moves AVAILABLE → IN_TRANSIT (inventory sellable −qty at the source). Creates transfer `TR-YYMM-####`; request → IN_TRANSIT. `lines` may ship less than approved. 409 `INSUFFICIENT_STOCK` / `UNBINNED_STOCK`.',
    }),
    transfers: d('Transfers (in / out)', 'inventory.view', {
      paginated: true,
      data: Joi.array().items(transferSummary),
      description:
        "Transfers from or to the caller's warehouses, newest first. `direction` with `warehouseId`: `in` (to it) or `out` (from it). Keyset paging (`cursor`).",
    }),
    transfer: d('Transfer detail', 'inventory.view', { data: transfer }),
    receive: d('Receive a transfer (destination)', 'inventory.receive', {
      data: transfer,
      errors: [404, 409, 422],
      description:
        'Per transfer line: received qty (≤ remaining) and put-away bin. Same batch and owner land in QC hold at the destination with a CN; request lines get the received qty. `close: true` closes the transfer even if short (the shortfall stays on the transfer as a transit loss, audited). Empty `lines` is allowed only with `close`.',
    }),
  };
};
