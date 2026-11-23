import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { WarehouseConfig } from '../config/index.js';
import { auditModule } from '../features/audit/index.js';
import { ADMIN_CALENDAR_TAG, calendarModule } from '../features/calendar/index.js';
import { ADMIN_DOCKS_TAG, docksModule } from '../features/docks/index.js';
import { ADMIN_ORDERS_TAG, ordersModule } from '../features/orders/index.js';
import { ADMIN_STATS_TAG, statsModule } from '../features/stats/index.js';
import { ADMIN_STORAGE_TAG, storageModule } from '../features/storage/index.js';
import { ADMIN_RULES_TAG, storageRulesModule } from '../features/storage-rules/index.js';
import { ADMIN_TEAM_TAG, teamModule } from '../features/team/index.js';
import { WMS_PORTAL_TAG, portalModule } from '../features/portal/index.js';
import { ADMIN_SERVICE_AREAS_TAG, serviceAreasModule } from '../features/service-areas/index.js';
import { ADMIN_WAREHOUSES_TAG, warehousesModule } from '../features/warehouses/index.js';
import {
  LIFECYCLE_AREA,
  STOCK_AREA,
  stockAdminModule,
  stockModule,
} from '../features/stock/index.js';
import { wmsTag } from '../docs/shared.js';

/**
 * warehouse-service (D-56): the warehouse portal backend. The gateway maps
 *   /v1/admin/warehouses/*  → /admin/warehouses/*   warehouse master, service areas, lookups
 *   /v1/admin/wms/*         → /admin/wms/*          portal shell (me, search) + D-57 admin panel (stock, fulfilment)
 *   /v1/wms/*               → /wms/*                D-57 warehouse panel (same handlers, scoped to the caller's warehouses)
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  warehousesModule,
  serviceAreasModule,
  storageModule,
  docksModule,
  calendarModule,
  storageRulesModule,
  teamModule,
  ordersModule,
  statsModule,
  portalModule,
  stockModule,
  stockAdminModule,
];

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: WarehouseConfig): DocsOptions => ({
  title: 'FarmX Warehouse Service API',
  version: config.SERVICE_VERSION,
  description:
    'Warehouse portal (D-56): the warehouse master (central warehouse + C&F depots), setup wizard and status lifecycle, service areas, storage (zones / racks / bins), team (invite-only), dock & yard, storage rules, calendar, stock / order numbers and the portal shell. Permissions may be GLOBAL or scoped to one warehouse.',
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    {
      name: ADMIN_WAREHOUSES_TAG,
      description: 'All warehouses, add / edit, activation and status (W2.01–W2.03).',
    },
    {
      name: ADMIN_SERVICE_AREAS_TAG,
      description: 'Districts and PIN codes each warehouse serves, by priority (W2.04).',
    },
    { name: ADMIN_STORAGE_TAG, description: 'Zones, racks and bins with capacity (W2.05).' },
    {
      name: ADMIN_TEAM_TAG,
      description: 'Invite-only warehouse staff, work areas, documents (W2.06).',
    },
    {
      name: ADMIN_DOCKS_TAG,
      description: 'Dock doors and bookings, staging areas, yard slots (W2.07).',
    },
    {
      name: ADMIN_RULES_TAG,
      description: 'Storage compatibility rules: saved now, enforced by put-away later (W2.08).',
    },
    { name: ADMIN_CALENDAR_TAG, description: 'Working hours, shifts, holidays, cut-offs (W2.09).' },
    {
      name: ADMIN_STATS_TAG,
      description:
        'Stock, capacity (kg) and status board of one warehouse (W2.03 overview / stock tab).',
    },
    {
      name: ADMIN_ORDERS_TAG,
      description: 'Orders a warehouse must fulfil (W2.03 Active Orders tab).',
    },
    { name: WMS_PORTAL_TAG, description: 'Portal shell: who am I, warehouse switcher, search.' },
    ...(['panel', 'admin'] as const).flatMap((aud) => [
      {
        name: wmsTag(aud, STOCK_AREA),
        description: `${aud === 'admin' ? 'Admin panel (GLOBAL)' : 'Warehouse panel (scoped)'}: batch-level stock (W4), receipts (CN), unit QR, COA, quality, moves, adjustments, thresholds (D-57a).`,
      },
      {
        name: wmsTag(aud, LIFECYCLE_AREA),
        description:
          'One shared stock status and its allowed transitions (W4.11); changes are proposed and approved by another person.',
      },
    ]),
  ],
});
