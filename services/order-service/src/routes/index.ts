import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { OrderConfig } from '../config/index.js';
import { auditModule } from '../features/audit/index.js';
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

/**
 * order-service: coupons & promotions engine + cart (Orders / Checkout come next). The gateway
 * maps (narrow prefixes):
 *   /v1/cart/*              → /cart/*              cart (guests + customers)
 *   /v1/orders/*            → /orders/*            public offers, offers + price preview (customers)
 *   /v1/admin/promotions/*  → /admin/promotions/*  promotions admin (staff)
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  projectionsModule,
  promotionsModule,
  offersModule,
  cartModule,
  settingsModule,
  ordersModule,
  ordersAdminModule,
  ordersInternalModule,
];

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: OrderConfig): DocsOptions => ({
  title: 'FarmX Order Service API',
  version: config.SERVICE_VERSION,
  description:
    'Cart (guest + customer, login merge, revalidated prices) and the offers, coupons and promotions engine: admin promotions (line offers, coupons, auto bonuses, shipping promos), public offers, offers for a cart and the billing / tax-invoice preview. Cart, orders and checkout come next.',
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
        'Checkout (admin-confirmed, prepaid), my orders, order detail + timeline, pay again (docs/oms).',
    },
    {
      name: ADMIN_ORDERS_TAG,
      description:
        'Manager console: review queue, confirm / reject / bulk, cancel, notes, refund recovery, exception queues, settings.',
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
