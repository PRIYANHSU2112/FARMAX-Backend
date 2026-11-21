import { ok } from '@farmx/common/response';
import { internalAuth } from '@farmx/common/middleware';
import type { FastifyPluginAsync } from 'fastify';
import Joi from 'joi';

const KEYS = Joi.array().items(Joi.string().max(300)).min(1).max(100).required();

/**
 * `/internal/media/*` (service token, never routed by the gateway, not in Swagger). Only keys under
 * the private support prefix are signed / deleted.
 */
export const mediaInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;
  const guard = internalAuth(token);
  const support = () => app.diContainer.resolve('supportUploads');

  app.post<{ Body: { keys: string[]; expiresInSeconds: number } }>(
    '/sign-read',
    {
      schema: { hide: true, body: Joi.object({ keys: KEYS, expiresInSeconds: Joi.number().integer().min(30).max(900).default(300) }) },
      onRequest: [guard],
    },
    async (req) => ok({ urls: await support().signRead(req.body.keys, req.body.expiresInSeconds) }),
  );
  app.post<{ Body: { keys: string[] } }>(
    '/delete',
    { schema: { hide: true, body: Joi.object({ keys: KEYS }) }, onRequest: [guard] },
    async (req) => ok({ deleted: await support().remove(req.body.keys) }),
  );
};
