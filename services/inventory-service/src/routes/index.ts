import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { InventoryConfig } from '../config/index.js';
import { auditModule } from '../features/audit/index.js';
import { projectionsModule } from '../features/projections/index.js';
import {
  ADMIN_RESERVATIONS_TAG,
  reservationsInternalModule,
  reservationsModule,
} from '../features/reservations/index.js';
import { ADMIN_SETTINGS_TAG, settingsModule } from '../features/settings/index.js';
import { ADMIN_STOCK_TAG, stockModule } from '../features/stock/index.js';
import { ADMIN_WAREHOUSES_TAG, warehousesModule } from '../features/warehouses/index.js';

/**
 * inventory-service (D-33): central stock across warehouses. The gateway maps
 *   /v1/admin/inventory/*  → /admin/inventory/*   staff (GLOBAL permission keys)
 * `/internal/inventory/*` (order-service checkout) is never routed by the gateway.
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  settingsModule,
  projectionsModule,
  warehousesModule,
  stockModule,
  reservationsModule,
  reservationsInternalModule,
];

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: InventoryConfig): DocsOptions => ({
  title: 'FarmX Inventory Service API',
  version: config.SERVICE_VERSION,
  description:
    'Central inventory across warehouses: warehouses and PIN coverage, warehouse × variant stock (on hand, reserved, damaged, safety stock), receipts, damage, write-offs, approved adjustments, an append-only stock ledger and atomic reservations for checkout. Not a WMS (no bins, picking or dispatch).',
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    {
      name: ADMIN_WAREHOUSES_TAG,
      description: 'Warehouses (mother warehouse, C&F depots) and the PIN codes each serves.',
    },
    {
      name: ADMIN_STOCK_TAG,
      description:
        'Warehouse stock, receipts, damage, write-offs, approved adjustments (SoD), thresholds and the append-only ledger.',
    },
    {
      name: ADMIN_RESERVATIONS_TAG,
      description:
        'Order stock reservations (ACTIVE → COMMITTED → ISSUED / RELEASED / EXPIRED / REJECTED) and force release.',
    },
    {
      name: ADMIN_SETTINGS_TAG,
      description: 'Business settings: reservation TTL, split allocation, limits.',
    },
  ],
});
