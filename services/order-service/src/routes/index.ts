import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { OrderConfig } from '../config/index.js';
import { auditModule } from '../features/audit/index.js';
import {
  ADMIN_INVOICES_TAG,
  INVOICES_TAG,
  invoicesAdminModule,
  invoicesModule,
} from '../features/invoices/index.js';
import { CART_TAG, cartModule } from '../features/cart/index.js';
import { OFFERS_TAG, offersModule } from '../features/offers/index.js';
import {
  ADMIN_ORDERS_TAG,
  ORDERS_TAG,
  ordersAdminModule,
  ordersInternalModule,
  ordersModule,
} from '../features/orders/index.js';
import { projectionsModule } from '../features/projections/index.js';
import { ADMIN_PROMOTIONS_TAG, promotionsModule } from '../features/promotions/index.js';
import { settingsModule } from '../features/settings/index.js';
import { transactionsModule } from '../features/transactions/index.js';

/**
 * order-service: promotions engine, cart, orders (admin-confirmed checkout, lifecycle, refunds,
 * cancellation) and the order money ledger. The gateway maps (narrow prefixes):
 *   /v1/cart/*              → /cart/*              cart (guests + customers)
 *   /v1/orders/*            → /orders/*            checkout, my orders, ledger, offers + price preview
 *   /v1/admin/orders/*      → /admin/orders/*      manager console, ledger + reconciliation (staff)
 *   /v1/admin/promotions/*  → /admin/promotions/*  promotions admin (staff)
 *   /v1/admin/invoices/*    → /admin/invoices/*    invoice register, downloads, GST export (staff, D-61)
 * `/internal/orders/*` is service-to-service only.
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  projectionsModule,
  promotionsModule,
  offersModule,
  cartModule,
  settingsModule,
  transactionsModule,
  invoicesModule,
  invoicesAdminModule,
  ordersModule,
  ordersAdminModule,
  ordersInternalModule,
];

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: OrderConfig): DocsOptions => ({
  title: 'FarmX Order Service API',
  version: config.SERVICE_VERSION,
  description:
    'Cart (guest + customer, login merge, revalidated prices), the offers / coupons / promotions engine with the GST invoice preview, and orders: resumable idempotent checkout (prepaid, admin-confirmed), my orders with timeline, pay again, cancellation with exact refunds, the manager console (review queue, confirm / reject, recovery), and the immutable order money ledger (every capture and partial refund in paise, reconciled with payment-service).',
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    {
      name: CART_TAG,
      description:
        'Guest (`X-Cart-Token`) and customer carts: add / set / remove, login merge, coupon, revalidated prices with notices.',
    },
    {
      name: ORDERS_TAG,
      description:
        'Checkout (admin-confirmed, prepaid), my orders, order detail + timeline, pay again, cancellation, money ledger (docs/oms).',
    },
    {
      name: ADMIN_ORDERS_TAG,
      description:
        'Manager console: review queue, confirm / reject / bulk, cancel, notes, refund recovery, exception queues, settings.',
    },
    {
      name: INVOICES_TAG,
      description:
        'GST tax invoices (one per consignment, issued before it leaves the warehouse) and credit notes of my order: list, signed download, combined PDF (D-61).',
    },
    {
      name: ADMIN_INVOICES_TAG,
      description:
        'Invoice register: search, detail with snapshot, audited download, PDF retry, GST register CSV export (`invoices.view`, `invoices.export`).',
    },
    {
      name: OFFERS_TAG,
      description: 'Public offers; customer offers for the cart and the price / GST preview.',
    },
    {
      name: ADMIN_PROMOTIONS_TAG,
      description:
        'Admin: promotions CRUD, activation, redemptions (`pricing.view`, `pricing.manage`).',
    },
  ],
});
