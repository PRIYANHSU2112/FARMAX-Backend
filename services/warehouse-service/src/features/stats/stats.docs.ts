import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { staffDoc } from '../../docs/shared.js';

export const ADMIN_STATS_TAG = 'Admin Warehouse Stats';

const trend = Joi.object({
  value: Joi.number().integer(),
  vsLast7DaysPct: Joi.number().allow(null).example(4.2),
});

const overview = Joi.object({
  warehouseId: Joi.string().guid(),
  asOf: Joi.date().iso().allow(null),
  stale: Joi.boolean().description('Snapshot older than 3 refresh intervals'),
  stock: Joi.object({ onHand: trend, available: trend, reserved: trend, skuCount: Joi.number() }),
  activeOrders: Joi.object({
    new: Joi.number(),
    allocated: Joi.number(),
    total: Joi.number(),
    inPicking: Joi.any().valid(null),
    inPacking: Joi.any().valid(null),
    readyToDispatch: Joi.any().valid(null),
  }),
  ordersToProcess: Joi.object({ count: Joi.number(), vsYesterdayPct: Joi.number().allow(null) }),
  capacity: Joi.object({
    totalKg: Joi.string().allow(null),
    usedKg: Joi.string().allow(null),
    availableKg: Joi.string().allow(null),
    usedPct: Joi.number().allow(null),
    weightKnownPct: Joi.number().allow(null),
    unweighedSkus: Joi.number().allow(null),
  }),
  statusBoard: Joi.array().items(
    Joi.object({
      key: Joi.string().valid('RECEIVING_DISPATCH', 'COLD_STORAGE', 'SYSTEM_SYNC'),
      label: Joi.string(),
      state: Joi.string().example('OPERATIONAL'),
      detail: Joi.string().allow(null),
    }),
  ),
  modules: Joi.object().description('false = that card has no backend yet (show "—")'),
}).meta({ className: 'WarehouseOverview' });

export const STATS_DOCS = {
  overview: staffDoc(ADMIN_STATS_TAG, 'Warehouse overview cards (W2.03)', 'warehouse.view', {
    data: overview,
    description:
      'Stock (with "vs last 7 days"), active orders, orders to process ("vs yesterday"), capacity in kg (weight-based; `weightKnownPct` < 100 → show "based on X% of stock with known weight"), status board and the information box. Transfers, picking stages and performance are null until W9 / W11 / W12 (`modules`). Figures come from a snapshot refreshed every minute (`asOf`, `stale`).',
  }),
  stockByCategory: staffDoc(
    ADMIN_STATS_TAG,
    'Stock by category (W2.03 Stock tab + donut)',
    'warehouse.view',
    {
      description:
        'Per root catalog category: SKUs, on hand, reserved, available and share of on-hand units. `rootCategoryId` null = stock not classified yet. `unweighedSkus` = SKUs without a pack weight (excluded from capacity). Near-expiry needs batches (null).',
    },
  ),
} satisfies Record<string, RouteDocs>;
