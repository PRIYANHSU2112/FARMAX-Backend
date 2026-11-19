import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

export interface SecurityOptions {
  /** Allowed browser origins. Empty = CORS disabled (server-to-server only). */
  corsOrigins?: readonly string[];
}

const plugin: FastifyPluginAsync<SecurityOptions> = async (app, opts) => {
  await app.register(helmet, {
    // JSON API: CSP is only meaningful for HTML. Swagger UI sets its own.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  });

  const origins = opts.corsOrigins ?? [];
  await app.register(cors, {
    origin: origins.length > 0 ? [...origins] : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-Cart-Token: guest cart identity (order-service cart); exposed so the web app can store it.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Cart-Token',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'X-Cart-Token', 'X-Cart-Merged'],
    maxAge: 600,
  });
};

/** Helmet security headers + strict CORS allowlist. */
export const securityPlugin = fp(plugin, { name: '@farmx/security' });
