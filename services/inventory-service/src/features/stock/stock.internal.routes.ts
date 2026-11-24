import { ok } from '@farmx/common/response';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import Joi from 'joi';

import { internalGuard } from '../../middleware/guards.js';
import { SETTING_RULES } from '../settings/index.js';

/**
 * Mounted at `/internal/inventory` (service token; never routed by the gateway, not in Swagger).
 * warehouse-service pulls these figures every minute for the W2 screens (D-56 P3).
 */
export const stockInternalRoutes: FastifyPluginAsync = async (app) => {
  const guard = internalGuard(app);
  if (guard === null) return;
  app.get('/warehouse-stats', { schema: { hide: true }, onRequest: [guard] }, async (req) =>
    ok(await req.diScope.resolve('stockService').warehouseStats()),
  );

  // ── D-57a cutover handshake (warehouse-service only) ──
  const sync = (req: FastifyRequest) => req.diScope.resolve('wmsSyncService');
  const by = (req: FastifyRequest) => {
    const v = (req.body as { by?: unknown } | undefined)?.by;
    return typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
  };

  // ── D-57b W3.13 ATP (warehouse-service only): availability settings, Sync Now ──
  const availabilityView = async (req: FastifyRequest) => {
    const s = await req.diScope.resolve('settingsService').view();
    return {
      bufferFloorPct: s.bufferFloorPct,
      reservationTtlSeconds: s.reservationTtlSeconds,
      allowSplitAllocation: s.allowSplitAllocation,
      updatedAt: s.updatedAt,
    };
  };
  app.get('/availability-settings', { schema: { hide: true }, onRequest: [guard] }, async (req) =>
    ok(await availabilityView(req)),
  );
  app.patch(
    '/availability-settings',
    {
      schema: {
        hide: true,
        body: Joi.object({
          bufferFloorPct: SETTING_RULES.bufferFloorPct,
          reservationTtlSeconds: SETTING_RULES.reservationTtlSeconds,
          reason: Joi.string().trim().min(3).max(500).required(),
          by: Joi.string().guid().allow(null),
          requestId: Joi.string().max(100).allow(null),
        }).or('bufferFloorPct', 'reservationTtlSeconds'),
      },
      onRequest: [guard],
    },
    async (req) => {
      const b = req.body as {
        bufferFloorPct?: number;
        reservationTtlSeconds?: number;
        reason: string;
        requestId?: string | null;
      };
      await req.diScope.resolve('settingsService').update(
        { userId: by(req), ip: null, requestId: b.requestId ?? req.id },
        {
          ...(b.bufferFloorPct === undefined ? {} : { bufferFloorPct: b.bufferFloorPct }),
          ...(b.reservationTtlSeconds === undefined
            ? {}
            : { reservationTtlSeconds: b.reservationTtlSeconds }),
          reason: b.reason,
        },
      );
      return ok(await availabilityView(req));
    },
  );
  app.post(
    '/availability/resync',
    {
      schema: {
        hide: true,
        body: Joi.object({ warehouseId: Joi.string().guid().allow(null) })
          .empty(null)
          .default({}),
      },
      onRequest: [guard],
    },
    async (req) =>
      ok(
        await req.diScope
          .resolve('availabilityPublisher')
          .resync((req.body as { warehouseId?: string | null }).warehouseId ?? null),
      ),
  );
  app.get('/cutover/state', { schema: { hide: true }, onRequest: [guard] }, async (req) =>
    ok(await sync(req).state()),
  );
  for (const step of ['freeze', 'unfreeze', 'activate', 'rollback'] as const)
    app.post(`/cutover/${step}`, { schema: { hide: true }, onRequest: [guard] }, async (req) =>
      ok(await sync(req)[step](by(req))),
    );
  app.post<{ Body: { reason?: string } }>(
    '/cutover/reject-pending',
    { schema: { hide: true }, onRequest: [guard] },
    async (req) =>
      ok(await sync(req).rejectPending((req.body.reason ?? 'CUTOVER_MOVED_TO_WMS').slice(0, 500))),
  );
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/cutover/snapshot',
    { schema: { hide: true }, onRequest: [guard] },
    async (req) =>
      ok(
        await sync(req).snapshot(
          req.query.cursor,
          Math.min(Number(req.query.limit ?? 1000) || 1000, 5000),
        ),
      ),
  );
  app.get<{ Querystring: { since: string; cursor?: string; limit?: string } }>(
    '/cutover/ledger-since',
    { schema: { hide: true }, onRequest: [guard] },
    async (req) =>
      ok(
        await sync(req).ledgerSince(
          new Date(req.query.since),
          req.query.cursor,
          Math.min(Number(req.query.limit ?? 1000) || 1000, 5000),
        ),
      ),
  );
};
