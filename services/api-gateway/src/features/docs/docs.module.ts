import type { Logger } from '@farmx/common/logger';
import { type ServiceModule, defineModule, registerDocsUi } from '@farmx/common/server';

import type { GatewayConfig } from '../../config/index.js';
import type { DocsSource } from './docs.merge.js';
import { DocsAggregator } from './docs.service.js';

/** Every service in the single Swagger, in display order, with the gateway prefix of its paths. */
export const createDocsSources = (config: GatewayConfig): DocsSource[] => [
  {
    service: 'auth-service',
    baseUrl: config.AUTH_SERVICE_URL,
    publicPrefix: '/v1/auth',
    summary: 'Login, users, roles and permissions, sessions, admin audit log',
  },
  {
    service: 'media-service',
    baseUrl: config.MEDIA_SERVICE_URL,
    publicPrefix: '/v1/media',
    summary: 'Image / video / PDF upload (also at `/v1/upload`)',
  },
  {
    service: 'farm-service',
    baseUrl: config.FARM_SERVICE_URL,
    publicPrefix: '/v1',
    summary: 'Farm registration, Farm ID, KYC, duplicate review, geo masters',
  },
  {
    service: 'catalog-service',
    baseUrl: config.CATALOG_SERVICE_URL,
    publicPrefix: '/v1',
    summary: 'Product catalogue: categories and sub-categories (any depth), brands, banners',
  },
  {
    service: 'product-service',
    baseUrl: config.PRODUCT_SERVICE_URL,
    publicPrefix: '/v1',
    summary:
      'Products, variants, ingredients, regulatory data, media, dynamic lookups, category attributes and compliance profiles',
  },
  {
    service: 'user-service',
    baseUrl: config.USER_SERVICE_URL,
    publicPrefix: '/v1',
    summary: 'Customer delivery addresses (default, audited) and product wishlist',
  },
  {
    service: 'order-service',
    baseUrl: config.ORDER_SERVICE_URL,
    publicPrefix: '/v1',
    summary:
      'Offers & coupons engine: admin promotions, public offers, offers for a cart, billing / tax-invoice preview',
  },
  {
    service: 'inventory-service',
    baseUrl: config.INVENTORY_SERVICE_URL,
    publicPrefix: '/v1',
    summary:
      'Central inventory: warehouses + PIN coverage, warehouse stock, receipts, damage, write-offs, approved adjustments, stock ledger, reservations',
  },
  {
    service: 'payment-service',
    baseUrl: config.PAYMENT_SERVICE_URL,
    publicPrefix: '/v1',
    summary:
      'Payments (Razorpay / mock), checkout verification, signed webhooks, refunds, reconciliation',
  },
  {
    service: 'notification-service',
    baseUrl: config.NOTIFICATION_SERVICE_URL,
    publicPrefix: '/v1',
    summary:
      'Notifications: in-app inbox + live SSE, push (FCM), email, SMS, preferences, devices; staff send, templates, delivery DLQ, analytics',
  },
  {
    service: 'call-service',
    baseUrl: config.CALL_SERVICE_URL,
    publicPrefix: '/v1',
    summary:
      'Book a Sales Call: recommended expert, pooled availability, slot holds, bookings, consents, call journey, expert queue, admin',
  },
  {
    service: 'wallet-service',
    baseUrl: config.WALLET_SERVICE_URL,
    publicPrefix: '/v1',
    summary:
      'Closed-loop customer wallet + reward points on double-entry PostgreSQL ledgers: Add Money, points, conversion',
  },
  {
    service: 'support-service',
    baseUrl: config.SUPPORT_SERVICE_URL,
    publicPrefix: '/v1',
    summary:
      'Help & Support for all apps: priority tickets with SLA, live chat (WebSocket), FAQ, legal pages, agent queue',
  },
  {
    service: 'warehouse-service',
    baseUrl: config.WAREHOUSE_SERVICE_URL,
    publicPrefix: '/v1',
    summary:
      'Warehouse portal (D-56): warehouse master, setup wizard and status, service areas (districts, PINs), portal shell',
  },
];

/**
 * The ONE Swagger UI for all FarmX APIs (D-29): `/api-docs` (+ `/api-docs.json` for Postman).
 * Services only publish their spec; per-service docs are not routed by the gateway.
 */
export const createDocsModule = (config: GatewayConfig, logger: Logger): ServiceModule => {
  const aggregator = new DocsAggregator({
    sources: createDocsSources(config),
    logger,
    version: config.SERVICE_VERSION,
  });
  return defineModule({
    name: 'docs',
    routes: async (app) => {
      await registerDocsUi(app, { title: 'FarmX API', load: () => aggregator.get() });
    },
  });
};
