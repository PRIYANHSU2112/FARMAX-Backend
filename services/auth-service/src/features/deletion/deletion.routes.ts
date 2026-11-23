import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import Joi from 'joi';

import { requireAuth } from '../../middleware/require-auth.js';
import { byBodyField, byIp, rateLimit } from '../../middleware/rate-limit.js';
import { actorFromRequest } from '../audit/index.js';
import { DELETION_DOCS } from './deletion.docs.js';

const HOUR = 3600;
const PHONE = Joi.string()
  .trim()
  .pattern(/^\+[1-9]\d{7,14}$/)
  .messages({ 'string.pattern.base': '{{#label}} must be E.164, e.g. +919876543210' });
const CODE = Joi.string()
  .pattern(/^\d{4,8}$/)
  .messages({ 'string.pattern.base': '{{#label}} must be the digits of the code' });

const svc = (req: FastifyRequest) => req.diScope.resolve('deletionService');
const byUser = (req: FastifyRequest) => req.user?.id;

/**
 * Self-service account deletion (`/me/deletion-request/*`, logged-in) and the recovery login that
 * can cancel it during the grace period (`/auth/account-recovery/*`, public, rate-limited).
 */
export const deletionRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/me/deletion-request',
    { schema: routeDocs(DELETION_DOCS.status), preHandler: [requireAuth] },
    async (req) => ok(await svc(req).status(req.user?.id ?? '')),
  );
  app.post(
    '/me/deletion-request/otp',
    {
      schema: routeDocs(DELETION_DOCS.otp),
      preHandler: [
        requireAuth,
        rateLimit({
          action: 'delete-otp',
          dimension: 'user',
          value: byUser,
          limit: 5,
          windowSeconds: HOUR,
        }),
      ],
    },
    async (req) => {
      if (req.user === null) throw new Error('unreachable');
      return ok(await svc(req).sendOtp(req.user));
    },
  );
  app.post<{ Body: { otp: string; reason?: string } }>(
    '/me/deletion-request',
    {
      schema: {
        body: Joi.object({ otp: CODE.required(), reason: Joi.string().trim().max(500) }),
        ...routeDocs(DELETION_DOCS.request),
      },
      preHandler: [
        requireAuth,
        rateLimit({
          action: 'delete-request',
          dimension: 'user',
          value: byUser,
          limit: 10,
          windowSeconds: HOUR,
        }),
      ],
    },
    async (req, reply) => {
      if (req.user === null) throw new Error('unreachable');
      return reply
        .status(201)
        .send(ok(await svc(req).request(req.user, actorFromRequest(req), req.body)));
    },
  );

  app.post<{ Body: { phone: string } }>(
    '/auth/account-recovery/otp',
    {
      schema: {
        body: Joi.object({ phone: PHONE.required() }),
        ...routeDocs(DELETION_DOCS.recoveryOtp),
      },
      preHandler: rateLimit(
        {
          action: 'recovery-otp',
          dimension: 'dest',
          value: byBodyField('phone'),
          limit: 5,
          windowSeconds: HOUR,
        },
        { action: 'recovery-otp', dimension: 'ip', value: byIp, limit: 20, windowSeconds: HOUR },
      ),
    },
    async (req) => ok(await svc(req).recoveryOtp(req.body.phone)),
  );
  app.post<{ Body: { phone: string; code: string } }>(
    '/auth/account-recovery/verify',
    {
      schema: {
        body: Joi.object({ phone: PHONE.required(), code: CODE.required() }),
        ...routeDocs(DELETION_DOCS.recoveryVerify),
      },
      preHandler: rateLimit(
        {
          action: 'recovery-verify',
          dimension: 'dest',
          value: byBodyField('phone'),
          limit: 10,
          windowSeconds: HOUR,
        },
        { action: 'recovery-verify', dimension: 'ip', value: byIp, limit: 30, windowSeconds: HOUR },
      ),
    },
    async (req) => ok(await svc(req).recoveryVerify(req.body.phone, req.body.code)),
  );
  app.post<{ Body: { recoveryToken: string } }>(
    '/auth/account-recovery/cancel-deletion',
    {
      schema: {
        body: Joi.object({
          recoveryToken: Joi.string()
            .pattern(/^[A-Za-z0-9_-]{43}$/)
            .required(),
        }),
        ...routeDocs(DELETION_DOCS.cancel),
      },
      preHandler: rateLimit({
        action: 'recovery-cancel',
        dimension: 'ip',
        value: byIp,
        limit: 20,
        windowSeconds: HOUR,
      }),
    },
    async (req) => {
      const ua = req.headers['user-agent'];
      return ok(
        await svc(req).cancel(req.body.recoveryToken, {
          ip: req.ip,
          userAgent: ua === undefined ? null : ua.slice(0, 512),
          requestId: req.id,
        }),
      );
    },
  );
};
