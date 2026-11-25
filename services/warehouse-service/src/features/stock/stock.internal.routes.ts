import { NotFoundError } from '@farmx/common/errors';
import { internalAuth } from '@farmx/common/middleware';
import { ok } from '@farmx/common/response';
import type { FastifyPluginAsync } from 'fastify';
import Joi from 'joi';

/**
 * D-60 `/internal/wms/*` (service-to-service, never routed by the gateway): the shared token is
 * checked in onRequest, before validation. No routes when INTERNAL_SERVICE_TOKEN is unset.
 *   GET /units/:qrCode/trace  → quality-service QR scan (batch, unit n of m, receipt, shipment)
 */
export const stockInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;
  app.get<{ Params: { qrCode: string } }>(
    '/units/:qrCode/trace',
    {
      schema: {
        hide: true,
        params: Joi.object({
          qrCode: Joi.string()
            .trim()
            .pattern(/^[A-Za-z0-9_.:-]{4,64}$/)
            .required(),
        }),
      },
      onRequest: [internalAuth(token)],
    },
    async (req) => {
      const trace = await req.diScope.resolve('stockQuality').unitTrace(req.params.qrCode);
      if (trace === null) throw new NotFoundError('Unit');
      return ok(trace);
    },
  );
};
