import { NotFoundError, ServiceUnavailableError } from '@farmx/common/errors';
import { fail } from '@farmx/common/response';
import httpProxy from '@fastify/http-proxy';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';

import type { ServiceUrls } from '../../config/services.js';

export interface ProxyRoute {
  /** Public path prefix on the gateway, e.g. `/v1/auth`. */
  prefix: string;
  /** Upstream service base URL. */
  upstream: string;
  /** What replaces `prefix` when forwarding; `''` strips it. */
  rewritePrefix: string;
  /** Also proxy WebSocket upgrades under this prefix (support live chat). */
  websocket?: boolean;
}

/**
 * Public prefix → upstream. `/v1/auth/health/live` reaches auth-service's `/health/live`;
 * `/v1/upload` reaches media-service's `/upload`; `/v1/media/*` its other routes and health.
 * API docs are NOT proxied: the gateway itself serves the single merged Swagger at `/api-docs`.
 */
export const createRouteMap = (config: ServiceUrls): ProxyRoute[] => [
  { prefix: '/v1/auth', upstream: config.AUTH_SERVICE_URL, rewritePrefix: '' },
  { prefix: '/v1/upload', upstream: config.MEDIA_SERVICE_URL, rewritePrefix: '/upload' },
  { prefix: '/v1/media', upstream: config.MEDIA_SERVICE_URL, rewritePrefix: '' },
  // farm-service and catalog-service: narrow prefixes only (never a blanket `''` rewrite).
  { prefix: '/v1/farms', upstream: config.FARM_SERVICE_URL, rewritePrefix: '/farms' },
  { prefix: '/v1/admin/farms', upstream: config.FARM_SERVICE_URL, rewritePrefix: '/admin/farms' },
  {
    prefix: '/v1/farm-service/health',
    upstream: config.FARM_SERVICE_URL,
    rewritePrefix: '/health',
  },
  // product-service owns these catalog sub-paths: listed BEFORE '/v1/catalog' (the narrower prefix
  // wins in find-my-way anyway; the order documents intent).
  ...(
    [
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
    ] as const
  ).map((path) => ({
    prefix: '/v1' + path,
    upstream: config.PRODUCT_SERVICE_URL,
    rewritePrefix: path,
  })),
  {
    prefix: '/v1/product-service/health',
    upstream: config.PRODUCT_SERVICE_URL,
    rewritePrefix: '/health',
  },
  { prefix: '/v1/catalog', upstream: config.CATALOG_SERVICE_URL, rewritePrefix: '/catalog' },
  {
    prefix: '/v1/admin/catalog',
    upstream: config.CATALOG_SERVICE_URL,
    rewritePrefix: '/admin/catalog',
  },
  {
    prefix: '/v1/catalog-service/health',
    upstream: config.CATALOG_SERVICE_URL,
    rewritePrefix: '/health',
  },
  // user-service: narrow prefixes only (`/v1/auth/me` stays with auth-service).
  // `/home` + `/admin/home`: server-driven Home / All Categories layout (D-59).
  ...(['/me/addresses', '/me/wishlist', '/admin/customers', '/home', '/admin/home'] as const).map(
    (path) => ({
      prefix: '/v1' + path,
      upstream: config.USER_SERVICE_URL,
      rewritePrefix: path,
    }),
  ),
  {
    prefix: '/v1/user-service/health',
    upstream: config.USER_SERVICE_URL,
    rewritePrefix: '/health',
  },
  // order-service: cart (guests + customers), offers / price preview (customers), promotions
  // admin, orders admin, invoice register (D-61).
  ...(['/cart', '/orders', '/admin/promotions', '/admin/orders', '/admin/invoices'] as const).map(
    (path) => ({
      prefix: '/v1' + path,
      upstream: config.ORDER_SERVICE_URL,
      rewritePrefix: path,
    }),
  ),
  {
    prefix: '/v1/order-service/health',
    upstream: config.ORDER_SERVICE_URL,
    rewritePrefix: '/health',
  },
  // inventory-service: staff admin only (`/internal/inventory/*` is service-to-service, never routed).
  {
    prefix: '/v1/admin/inventory',
    upstream: config.INVENTORY_SERVICE_URL,
    rewritePrefix: '/admin/inventory',
  },
  {
    prefix: '/v1/inventory-service/health',
    upstream: config.INVENTORY_SERVICE_URL,
    rewritePrefix: '/health',
  },
  // payment-service: buyers, Razorpay webhooks (raw body streamed unchanged), staff.
  ...(['/payments', '/webhooks', '/admin/payments', '/admin/refunds'] as const).map((path) => ({
    prefix: '/v1' + path,
    upstream: config.PAYMENT_SERVICE_URL,
    rewritePrefix: path,
  })),
  {
    prefix: '/v1/payment-service/health',
    upstream: config.PAYMENT_SERVICE_URL,
    rewritePrefix: '/health',
  },
  // notification-service: any signed-in user (own inbox, preferences, devices, SSE stream) and
  // staff (send, templates). `/metrics` is never routed (scraped on the service port).
  ...(['/notifications', '/admin/notifications', '/admin/notification-templates'] as const).map(
    (path) => ({
      prefix: '/v1' + path,
      upstream: config.NOTIFICATION_SERVICE_URL,
      rewritePrefix: path,
    }),
  ),
  {
    prefix: '/v1/notification-service/health',
    upstream: config.NOTIFICATION_SERVICE_URL,
    rewritePrefix: '/health',
  },
  // call-service (D-53): customers, experts and staff all live under /calls.
  { prefix: '/v1/calls', upstream: config.CALL_SERVICE_URL, rewritePrefix: '/calls' },
  {
    prefix: '/v1/call-service/health',
    upstream: config.CALL_SERVICE_URL,
    rewritePrefix: '/health',
  },
  // wallet-service (D-54): customers' own wallet and reward points. `/internal/*` is never routed.
  ...(['/wallet', '/rewards', '/admin/wallet'] as const).map((path) => ({
    prefix: '/v1' + path,
    upstream: config.WALLET_SERVICE_URL,
    rewritePrefix: path,
  })),
  {
    prefix: '/v1/wallet-service/health',
    upstream: config.WALLET_SERVICE_URL,
    rewritePrefix: '/health',
  },
  // support-service: help home, tickets, agent queue, FAQ, legal pages. The live-chat prefix is the
  // ONE WebSocket-enabled proxy (narrower prefix wins for plain HTTP as well).
  {
    prefix: '/v1/support/chat',
    upstream: config.SUPPORT_SERVICE_URL,
    rewritePrefix: '/support/chat',
    websocket: true,
  },
  ...(['/support', '/faqs', '/legal', '/admin/support'] as const).map((path) => ({
    prefix: '/v1' + path,
    upstream: config.SUPPORT_SERVICE_URL,
    rewritePrefix: path,
  })),
  {
    prefix: '/v1/support-service/health',
    upstream: config.SUPPORT_SERVICE_URL,
    rewritePrefix: '/health',
  },
  // warehouse-service (D-56): staff only. The warehouse master moved here from inventory-service.
  // D-57: /wms = warehouse panel (scoped), /admin/wms = admin panel (GLOBAL), /shipments =
  // customer shipment tracking + delivery OTP, /driver = 3PL trip links (token in the path).
  ...(['/admin/warehouses', '/admin/wms', '/wms', '/shipments', '/driver'] as const).map(
    (path) => ({
      prefix: '/v1' + path,
      upstream: config.WAREHOUSE_SERVICE_URL,
      rewritePrefix: path,
    }),
  ),
  {
    prefix: '/v1/warehouse-service/health',
    upstream: config.WAREHOUSE_SERVICE_URL,
    rewritePrefix: '/health',
  },
  // quality-service (D-60, W16 Sampling & COA): /quality = warehouse panel (scoped),
  // /admin/quality = admin panel (GLOBAL), /certificates = customer app, /verify = public.
  ...(['/admin/quality', '/quality', '/certificates', '/verify'] as const).map((path) => ({
    prefix: '/v1' + path,
    upstream: config.QUALITY_SERVICE_URL,
    rewritePrefix: path,
  })),
  {
    prefix: '/v1/quality-service/health',
    upstream: config.QUALITY_SERVICE_URL,
    rewritePrefix: '/health',
  },
];

/**
 * The upstream did not answer (not deployed, crashed, restarting, DNS, socket reset, timeout).
 * reply-from turns ECONNREFUSED into a generic 500, which made every missing service look like a
 * bug in that service; this answers 503 SERVICE_UNAVAILABLE in the standard envelope instead and
 * logs which upstream failed and why (with the request id) for the server-side trace.
 */
/** The bits of the (HTTP/1 or HTTP/2) reply the handler needs. */
interface ProxyReply {
  request: { log: FastifyBaseLogger; url: string; id: string };
  sent: boolean;
  code(statusCode: number): { send(payload: unknown): unknown };
}

export const upstreamErrorHandler =
  (route: Pick<ProxyRoute, 'prefix' | 'upstream'>) =>
  (reply: ProxyReply, { error }: { error: Error & { code?: string; cause?: unknown } }): void => {
    const cause = error.cause as { code?: string } | undefined;
    reply.request.log.error(
      {
        err: error,
        upstream: route.upstream,
        prefix: route.prefix,
        cause: cause?.code ?? error.code,
        path: reply.request.url.split('?')[0],
      },
      'upstream service unavailable',
    );
    if (reply.sent) return;
    void reply
      .code(503)
      .send(
        fail(new ServiceUnavailableError(undefined, { isOperational: true }), reply.request.id),
      );
  };

/** Service-to-service routes are never reachable through the gateway, whatever the prefix. */
export const INTERNAL_PATH = /(^|\/)internal(\/|$)/i;

/** Per-service API docs are never reachable either: one Swagger for all, at the gateway (D-29). */
export const SERVICE_DOCS_PATH = /^\/v1\/.*\/api-docs/i;

/**
 * Registers one `@fastify/http-proxy` per route (path rewrite is done there). Request bodies are
 * streamed to the upstream unparsed (uploads are never buffered here); each service enforces its
 * own size limits.
 */
export const proxyRoutes =
  (routes: readonly ProxyRoute[]): FastifyPluginAsync =>
  async (app) => {
    app.addHook('onRequest', async (request) => {
      const path = request.url.split('?')[0] ?? '';
      if (INTERNAL_PATH.test(path) || SERVICE_DOCS_PATH.test(path)) {
        throw new NotFoundError('Route');
      }
    });
    for (const route of routes) {
      await app.register(httpProxy, {
        upstream: route.upstream,
        prefix: route.prefix,
        rewritePrefix: route.rewritePrefix,
        http2: false,
        replyOptions: { onError: upstreamErrorHandler(route) },
        ...(route.websocket === true ? { websocket: true } : {}),
      });
    }
  };
