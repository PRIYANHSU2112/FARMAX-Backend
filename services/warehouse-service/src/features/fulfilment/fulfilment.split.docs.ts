import Joi from 'joi';

import { IF_VERSION, wmsDoc } from '../../docs/shared.js';
import { PAGE_META } from '../../middleware/paging.js';

export const SPLIT_AREA = 'Split, partial & backorder';

const any = Joi.object().unknown(true);
const SAGA =
  'Moved legs run the reallocation saga (§2a.4) one at a time; a pending one stops the rest (`next` says so).';

export const splitDocs = (aud: 'panel' | 'admin') => {
  const d = (s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    wmsDoc(aud, SPLIT_AREA, s, p, o);
  return {
    context: d('Order header, shortage banner, node fit', 'fulfilment.view', {
      data: any,
      errors: [404],
      description:
        'Open quantity per item (not dispatched), stock at the assigned node and network-wide, short units, per-node fit (ALL / PARTIAL / NONE) and the order’s backorders.',
    }),
    proposal: d('Proposed legs for a strategy', 'fulfilment.view', {
      data: any,
      errors: [404],
      description:
        'NEAREST (distance), FEWEST_SPLITS (most units per node first), LEAST_COST (no transfer first, then least tonne-km; no fare rates yet). Each leg: node, lines, units, weight, distance, tonne-km, next dispatch slot, fleet suggestion. Units nobody holds → `backorder`.',
    }),
    preview: d('Plan summary, freight policy, customer notice, SOP checks', 'fulfilment.view', {
      data: any,
      errors: [404, 422],
      description:
        'Checks: quantities match, every node serves the PIN, moved legs fit stock, cold chain, max 3 legs, consent for backorders. Nothing changes.',
    }),
    split: d('Save & Execute the split', 'fulfilment.reallocate', {
      data: any,
      errors: [404, 409, 422, 503],
      description: `GLOBAL fulfilment.reallocate. Fails with 422 SPLIT_CHECKS_FAILED when the preview fails. Backorders first, then the moved legs. ${SAGA} \`notifyCustomer\` publishes \`shipment.split_planned.v1\` (customer notice).`,
    }),
    reroute: d('Cancel & re-route the whole order', 'fulfilment.reallocate', {
      data: any,
      errors: [404, 409, 422],
      description: 'Every open line to one node through one reallocation saga.',
    }),
    partial: d('Partial fulfilment', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 422, 503],
      description:
        'Before picking: ship `shipQty` now; the rest is BACKORDER (consent required; keeps its reservation) or CANCEL (order-service cancels + refunds those units).',
    }),
    backorders: d('Backorder queue', 'fulfilment.view', {
      paginated: true,
      data: Joi.array().items(any),
      meta: PAGE_META,
      description:
        'Newest first with order no, customer, node, SKU, promise date, overdue flag; `counts` per status. The backorder job ships OPEN rows when stock arrives.',
    }),
    backorderPatch: d('Change promise date / note', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 422],
      description: IF_VERSION,
    }),
    backorderCancel: d('Cancel a backorder (refund)', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 503],
      description: 'The units are cancelled and refunded through order-service.',
    }),
    slots: d('Dispatch slots of a node', 'fulfilment.view', {
      data: Joi.array().items(any),
      description:
        'Next open days from the D-56 calendar: "Immediate Same-Day" (before today’s cut-off), "Next-Day Scheduled", then dated; docks and dock bookings that day.',
    }),
    map: d('Corridors map', 'fulfilment.view', {
      data: any,
      errors: [404],
      description: 'Delivery point and every node serving it, with distance and active legs.',
    }),
  };
};

export const AMEND_AREA = 'Order hold & edit';

export const amendDocs = (aud: 'panel' | 'admin') => {
  const d = (s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    wmsDoc(aud, AMEND_AREA, s, p, o);
  return {
    quote: d('Amendment quote (what a save would do)', 'fulfilment.view', {
      data: any,
      errors: [404, 422],
      description:
        'Delivery change checked against the assigned warehouse coverage (PIN_NOT_COVERED → re-route first), quantity decreases with the refund estimate, increases (need a balance payment: `modules.balancePayment: false` on prepaid orders), and whether picking has started.',
    }),
    amend: d('Save & update order changes', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 422, 503],
      description:
        'Before picking only. Delivery details go to order-service (it owns them; `order.delivery_updated.v1`); decreases / removals are cancelled there (refund + reservation release). An increase is refused with 409 BALANCE_PAYMENT_NOT_AVAILABLE. Reason ≥ 10 chars; audited.',
    }),
    manifest: d('Shipment manifest', 'fulfilment.view', {
      data: any,
      errors: [404],
      description:
        'Header, ship-to (customer, farm, PO ref, address), FEFO lots per line, packages (type, weight, sealed), totals, vehicle / trip.',
    }),
  };
};
