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
import { WMS_PORTAL_TAG, portalModule, portalPanelModule } from '../features/portal/index.js';
import { ADMIN_SERVICE_AREAS_TAG, serviceAreasModule } from '../features/service-areas/index.js';
import { ADMIN_WAREHOUSES_TAG, warehousesModule } from '../features/warehouses/index.js';
import {
  CUTOVER_AREA,
  LIFECYCLE_AREA,
  OPS_AREA,
  STOCK_AREA,
  VENDORS_AREA,
  stockAdminModule,
  stockModule,
} from '../features/stock/index.js';
import { RESTOCK_AREA, restockAdminModule, restockModule } from '../features/restock/index.js';
import {
  EXCEPTIONS_AREA,
  FLOOR_AREA,
  FULFILMENT_AREA,
  CUSTOMER_TAG,
  DELIVERY_AREA,
  DRIVER_TAG,
  SPLIT_AREA,
  AMEND_AREA,
  customerShipmentsModule,
  driverLinkModule,
  fulfilmentAdminModule,
  fulfilmentModule,
} from '../features/fulfilment/index.js';
import {
  COMPLIANCE_AREA,
  complianceAdminModule,
  complianceModule,
} from '../features/compliance/index.js';
import {
  BULK_AREA,
  DISPATCH_AREA,
  dispatchAdminModule,
  dispatchModule,
} from '../features/dispatch/index.js';
import { ROUTING_AREA, routingAdminModule, routingModule } from '../features/routing/index.js';
import { ATP_AREA, atpAdminModule, atpModule } from '../features/atp/index.js';
import {
  PAYMENTS_AREA,
  paymentsViewAdminModule,
  paymentsViewModule,
} from '../features/payments-view/index.js';
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
  portalPanelModule,
  stockModule,
  stockAdminModule,
  restockModule,
  restockAdminModule,
  fulfilmentModule,
  fulfilmentAdminModule,
  complianceModule,
  complianceAdminModule,
  dispatchModule,
  dispatchAdminModule,
  driverLinkModule,
  customerShipmentsModule,
  routingModule,
  routingAdminModule,
  atpModule,
  atpAdminModule,
  paymentsViewModule,
  paymentsViewAdminModule,
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
    {
      name: DRIVER_TAG,
      description:
        'Public 3PL driver trip link (§2a.8): trip stops, pings, deliver with the customer OTP, failed delivery.',
    },
    {
      name: CUSTOMER_TAG,
      description:
        'Customer app: own shipments, ETA / tracking, delivery OTP while out for delivery.',
    },
    ...(['panel', 'admin'] as const).flatMap((aud) => [
      {
        name: wmsTag(aud, STOCK_AREA),
        description: `${aud === 'admin' ? 'Admin panel (GLOBAL)' : 'Warehouse panel (scoped)'}: batch-level stock (W4), receipts (CN), unit QR, COA, quality, moves, adjustments, thresholds (D-57a).`,
      },
      {
        name: wmsTag(aud, FULFILMENT_AREA),
        description:
          'Order fulfilment (D-57b): dashboard (W3.01), new orders + order details (W3.02 / W3.03), warehouse allocation + reallocation saga (W3.04), hold (W3.15), shelf-life rules, settings, reserved stock (W4.05).',
      },
      {
        name: wmsTag(aud, FLOOR_AREA),
        description:
          'Warehouse floor: FEFO allocation (W3.05), pick-pack tasks + checklist + pick batches (W3.06), pick → pack → QC → stage and processing lists (W3.07).',
      },
      {
        name: wmsTag(aud, EXCEPTIONS_AREA),
        description:
          'Order exceptions (W3.11): KPIs, priority list, resolve actions, mass re-route / hold, SOP card, export.',
      },
      {
        name: wmsTag(aud, COMPLIANCE_AREA),
        description:
          'Compliance gate (W3.16): regulated orders wait for verified documents (vet Rx, licence, permit, declaration); reviewer decisions, waiver with step-up TOTP, escalation and auto-reject.',
      },
      {
        name: wmsTag(aud, DELIVERY_AREA),
        description:
          'Out for delivery (OTP in the customer app only), deliver with OTP + POD, override, failed / return, fulfil, prepaid settlement "Settle now" (W3.09 / W3.10), POD archive / CSV exports, 3PL driver links.',
      },
      {
        name: wmsTag(aud, AMEND_AREA),
        description:
          'Order hold & edit (W3.15): amendment quote + save (delivery via order-service, quantity decreases = cancel + refund; increases need a balance payment, not on prepaid yet), shipment manifest. Hold APIs are under Fulfilment.',
      },
      {
        name: wmsTag(aud, SPLIT_AREA),
        description:
          'Split, partial & backorder (W3.14): shortage context, strategy proposals, preview with SOP checks + customer notice, execute (reallocation per leg), re-route, partial fulfilment, backorder queue, dispatch slots, corridors map.',
      },
      {
        name: wmsTag(aud, PAYMENTS_AREA),
        description:
          'Payment view (W3.18, prepaid only): KPI cards, payment ledger with tabs + export, customer panel, reconciliation SLA from payment-service. Credit / COD widgets answer modules.credit = false.',
      },
      {
        name: wmsTag(aud, ATP_AREA),
        description: `${aud === 'admin' ? 'Admin panel (GLOBAL): reads + settings' : 'Warehouse panel (scoped)'}: available-to-promise (W3.13): KPIs, categories, ATP table + export, formula / health bands / buffer floor / cart-hold lease, Sync Now, node distribution + transfer pipeline, storefront sync.`,
      },
      {
        name: wmsTag(aud, ROUTING_AREA),
        description: `${aud === 'admin' ? 'Admin panel (GLOBAL): rule / fallback / throttle writes + reads' : 'Warehouse panel: reads + simulation'}: order routing rules engine (W3.12): rules by priority, condition builder, simulation + test matrix, fallback policy, history, audit, node load and throttles.`,
      },
      {
        name: wmsTag(aud, DISPATCH_AREA),
        description:
          'Route master, carriers, vehicles, drivers, trips (many shipments ↔ many trips), loading, manual weighbridge, gate-out (issue), tracking pings, dispatched orders (W3.08).',
      },
      {
        name: wmsTag(aud, BULK_AREA),
        description:
          'Bulk & direct-to-farm (W3.19): consignments ≥ bulkMinKg, trucks, heavy bays, corridors, manifest export.',
      },
      {
        name: wmsTag(aud, RESTOCK_AREA),
        description:
          'Monthly restock requests (procurement / warehouse transfer) with maker-checker approval (admin panel), transfer dispatch (FEFO) and receipt (W4.07 / W4.08).',
      },
      {
        name: wmsTag(aud, LIFECYCLE_AREA),
        description:
          'One shared stock status and its allowed transitions (W4.11); changes are proposed and approved by another person.',
      },
      {
        name: wmsTag(aud, VENDORS_AREA),
        description:
          'Vendor master (supplier of each SKU, ownership model SOR / FarmX / JIT, unit QR). Writes: admin panel.',
      },
      {
        name: wmsTag(aud, OPS_AREA),
        description:
          'Maintenance banner; admin: background jobs (heartbeats, dead letters), reconcile reports.',
      },
      ...(aud === 'admin'
        ? [
            {
              name: wmsTag(aud, CUTOVER_AREA),
              description:
                'Inventory → warehouse stock cutover: freeze (≤ 2 h), run (import / replay + verify), abort, rollback (≤ 72 h).',
            },
          ]
        : []),
    ]),
  ],
});
