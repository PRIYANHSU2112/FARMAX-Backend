import Joi from 'joi';

import { wmsDoc } from '../../docs/shared.js';
import { PAGE_META } from '../../middleware/paging.js';

export const ATP_AREA = 'Available-to-promise';

const any = Joi.object().unknown(true);

export const atpDocs = (aud: 'panel' | 'admin') => {
  const d = (s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    wmsDoc(aud, ATP_AREA, s, p, o);
  return {
    kpis: d('6 KPI cards (+ availability rate)', 'inventory.view', {
      data: any,
      description:
        'Physical, open demand (+ picking / packing share), net ATP (+ availability rate = net ATP ÷ physical), projected ATP 24 h (+ inbound), safety stock, QC hold / blocked, SKU health counts (Healthy / High Demand / Low Buffer / Throttled / out), storefront sync. Cached 20 s; `fresh=true` bypasses.',
    }),
    categories: d('Category tabs with SKU counts', 'inventory.view', {
      data: any,
      description: 'Root categories with SKUs in stock (names from catalog; `modules.catalog`).',
    }),
    items: d('ATP table', 'inventory.view', {
      paginated: true,
      data: Joi.array().items(any),
      meta: PAGE_META,
      description:
        'One row per warehouse × SKU: physical, open demand, safety, QC hold, blocked, returned, net ATP, inbound 24 h, projected 24 h, health band, throttled (buffer floor), top FEFO lot + expiry, zone / bin label + storage type, storefront published qty. Filters: search, warehouse, category, storage type, health. Sort: netAtp (default, most at risk first), physical, projected, demand, name. Cursor or page (≤ 2,000 rows deep).',
    }),
    csv: d('Export ATP (CSV)', 'inventory.view', {
      description: 'Streamed in batches of 1,000, CSV-injection safe. 5 per minute.',
    }),
    settings: d('Formula, health bands, buffer floor, cart-hold lease', 'inventory.view', {
      data: any,
      description:
        'Formula text, health bands (settings), guardrails (buffer floor > 0), buffer floor % and cart-hold lease (inventory settings, `modules.inventory`), split allocation, storefront channels (`modules.shopify: false`).',
    }),
    settingsSave: d('Save ATP settings', 'inventory.configure', {
      data: any,
      errors: [409, 422, 503],
      description:
        'Admin panel only (GLOBAL `inventory.configure`), reason required, audited. Buffer floor and cart-hold lease are written to inventory-service (their owner); turning guardrails off sets the floor to 0 and remembers the last value for turning them on again.',
    }),
    sync: d('Sync Now (re-send storefront availability)', 'inventory.view', {
      data: any,
      errors: [404, 503],
      description:
        'Inventory re-publishes availability of every SKU (of one warehouse). 6 per minute per user.',
    }),
    nodes: d('Node distribution + transfer pipeline', 'inventory.view', {
      data: any,
      description:
        'Per node: tagline, physical, available, allocated, share %, net / projected ATP, open demand, and inbound transfers (units, count, next ETA).',
    }),
  };
};
