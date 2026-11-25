import { describe, expect, it } from 'vitest';

import {
  INTERNAL_PATH,
  SERVICE_DOCS_PATH,
  createRouteMap,
} from '../../src/features/proxy/route-map.js';

describe('route map', () => {
  it('forwards each public prefix to its service (farm/catalog: narrow prefixes only)', () => {
    expect(
      createRouteMap({
        AUTH_SERVICE_URL: 'http://auth:3001',
        MEDIA_SERVICE_URL: 'http://media:3002',
        FARM_SERVICE_URL: 'http://farm:3003',
        CATALOG_SERVICE_URL: 'http://catalog:3004',
        PRODUCT_SERVICE_URL: 'http://product:3005',
        USER_SERVICE_URL: 'http://user:3006',
        ORDER_SERVICE_URL: 'http://order:3007',
        INVENTORY_SERVICE_URL: 'http://inventory:3008',
        PAYMENT_SERVICE_URL: 'http://payment:3009',
        NOTIFICATION_SERVICE_URL: 'http://notification:3010',
        CALL_SERVICE_URL: 'http://call:3011',
        WALLET_SERVICE_URL: 'http://wallet:3012',
        SUPPORT_SERVICE_URL: 'http://support:3013',
        WAREHOUSE_SERVICE_URL: 'http://warehouse:3014',
        QUALITY_SERVICE_URL: 'http://quality:3015',
      }),
    ).toEqual([
      { prefix: '/v1/auth', upstream: 'http://auth:3001', rewritePrefix: '' },
      { prefix: '/v1/upload', upstream: 'http://media:3002', rewritePrefix: '/upload' },
      { prefix: '/v1/media', upstream: 'http://media:3002', rewritePrefix: '' },
      { prefix: '/v1/farms', upstream: 'http://farm:3003', rewritePrefix: '/farms' },
      { prefix: '/v1/admin/farms', upstream: 'http://farm:3003', rewritePrefix: '/admin/farms' },
      { prefix: '/v1/farm-service/health', upstream: 'http://farm:3003', rewritePrefix: '/health' },
      ...[
        '/catalog/products',
        '/catalog/lookups',
        '/catalog/diseases',
        '/catalog/reviews',
        '/admin/catalog/products',
        '/admin/catalog/reviews',
        '/admin/catalog/lookups',
        '/admin/catalog/diseases',
        '/admin/catalog/product-attributes',
        '/admin/catalog/compliance-profiles',
      ].map((path) => ({
        prefix: '/v1' + path,
        upstream: 'http://product:3005',
        rewritePrefix: path,
      })),
      {
        prefix: '/v1/product-service/health',
        upstream: 'http://product:3005',
        rewritePrefix: '/health',
      },
      { prefix: '/v1/catalog', upstream: 'http://catalog:3004', rewritePrefix: '/catalog' },
      {
        prefix: '/v1/admin/catalog',
        upstream: 'http://catalog:3004',
        rewritePrefix: '/admin/catalog',
      },
      {
        prefix: '/v1/catalog-service/health',
        upstream: 'http://catalog:3004',
        rewritePrefix: '/health',
      },
      ...['/me/addresses', '/me/wishlist', '/admin/customers', '/home', '/admin/home'].map(
        (path) => ({
          prefix: '/v1' + path,
          upstream: 'http://user:3006',
          rewritePrefix: path,
        }),
      ),
      { prefix: '/v1/user-service/health', upstream: 'http://user:3006', rewritePrefix: '/health' },
      { prefix: '/v1/cart', upstream: 'http://order:3007', rewritePrefix: '/cart' },
      { prefix: '/v1/orders', upstream: 'http://order:3007', rewritePrefix: '/orders' },
      {
        prefix: '/v1/admin/promotions',
        upstream: 'http://order:3007',
        rewritePrefix: '/admin/promotions',
      },
      { prefix: '/v1/admin/orders', upstream: 'http://order:3007', rewritePrefix: '/admin/orders' },
      {
        prefix: '/v1/admin/invoices',
        upstream: 'http://order:3007',
        rewritePrefix: '/admin/invoices',
      },
      {
        prefix: '/v1/order-service/health',
        upstream: 'http://order:3007',
        rewritePrefix: '/health',
      },
      {
        prefix: '/v1/admin/inventory',
        upstream: 'http://inventory:3008',
        rewritePrefix: '/admin/inventory',
      },
      {
        prefix: '/v1/inventory-service/health',
        upstream: 'http://inventory:3008',
        rewritePrefix: '/health',
      },
      ...['/payments', '/webhooks', '/admin/payments', '/admin/refunds'].map((path) => ({
        prefix: '/v1' + path,
        upstream: 'http://payment:3009',
        rewritePrefix: path,
      })),
      {
        prefix: '/v1/payment-service/health',
        upstream: 'http://payment:3009',
        rewritePrefix: '/health',
      },
      ...['/notifications', '/admin/notifications', '/admin/notification-templates'].map(
        (path) => ({
          prefix: '/v1' + path,
          upstream: 'http://notification:3010',
          rewritePrefix: path,
        }),
      ),
      {
        prefix: '/v1/notification-service/health',
        upstream: 'http://notification:3010',
        rewritePrefix: '/health',
      },
      { prefix: '/v1/calls', upstream: 'http://call:3011', rewritePrefix: '/calls' },
      {
        prefix: '/v1/call-service/health',
        upstream: 'http://call:3011',
        rewritePrefix: '/health',
      },
      { prefix: '/v1/wallet', upstream: 'http://wallet:3012', rewritePrefix: '/wallet' },
      { prefix: '/v1/rewards', upstream: 'http://wallet:3012', rewritePrefix: '/rewards' },
      {
        prefix: '/v1/admin/wallet',
        upstream: 'http://wallet:3012',
        rewritePrefix: '/admin/wallet',
      },
      {
        prefix: '/v1/wallet-service/health',
        upstream: 'http://wallet:3012',
        rewritePrefix: '/health',
      },
      {
        prefix: '/v1/support/chat',
        upstream: 'http://support:3013',
        rewritePrefix: '/support/chat',
        websocket: true,
      },
      { prefix: '/v1/support', upstream: 'http://support:3013', rewritePrefix: '/support' },
      { prefix: '/v1/faqs', upstream: 'http://support:3013', rewritePrefix: '/faqs' },
      { prefix: '/v1/legal', upstream: 'http://support:3013', rewritePrefix: '/legal' },
      {
        prefix: '/v1/admin/support',
        upstream: 'http://support:3013',
        rewritePrefix: '/admin/support',
      },
      {
        prefix: '/v1/support-service/health',
        upstream: 'http://support:3013',
        rewritePrefix: '/health',
      },
      {
        prefix: '/v1/admin/warehouses',
        upstream: 'http://warehouse:3014',
        rewritePrefix: '/admin/warehouses',
      },
      { prefix: '/v1/admin/wms', upstream: 'http://warehouse:3014', rewritePrefix: '/admin/wms' },
      { prefix: '/v1/wms', upstream: 'http://warehouse:3014', rewritePrefix: '/wms' },
      { prefix: '/v1/shipments', upstream: 'http://warehouse:3014', rewritePrefix: '/shipments' },
      { prefix: '/v1/driver', upstream: 'http://warehouse:3014', rewritePrefix: '/driver' },
      {
        prefix: '/v1/warehouse-service/health',
        upstream: 'http://warehouse:3014',
        rewritePrefix: '/health',
      },
      {
        prefix: '/v1/admin/quality',
        upstream: 'http://quality:3015',
        rewritePrefix: '/admin/quality',
      },
      { prefix: '/v1/quality', upstream: 'http://quality:3015', rewritePrefix: '/quality' },
      {
        prefix: '/v1/certificates',
        upstream: 'http://quality:3015',
        rewritePrefix: '/certificates',
      },
      { prefix: '/v1/verify', upstream: 'http://quality:3015', rewritePrefix: '/verify' },
      {
        prefix: '/v1/quality-service/health',
        upstream: 'http://quality:3015',
        rewritePrefix: '/health',
      },
    ]);
  });

  it('recognises internal paths so the gateway can refuse them', () => {
    expect(INTERNAL_PATH.test('/v1/auth/internal/access/x/permissions')).toBe(true);
    expect(INTERNAL_PATH.test('/v1/auth/INTERNAL')).toBe(true);
    expect(INTERNAL_PATH.test('/v1/farms/internal-notes')).toBe(false);
    expect(INTERNAL_PATH.test('/v1/farms')).toBe(false);
  });

  it('refuses per-service docs (one Swagger at the gateway only)', () => {
    expect(SERVICE_DOCS_PATH.test('/v1/auth/api-docs')).toBe(true);
    expect(SERVICE_DOCS_PATH.test('/v1/auth/api-docs.json')).toBe(true);
    expect(SERVICE_DOCS_PATH.test('/v1/media/api-docs/static/index.html')).toBe(true);
    expect(SERVICE_DOCS_PATH.test('/api-docs')).toBe(false);
    expect(SERVICE_DOCS_PATH.test('/v1/catalog/categories')).toBe(false);
  });
});
