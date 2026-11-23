import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { byBodyField, byIp, rateLimit } from '../../middleware/rate-limit.js';
import { requireAuth, requireAuthAllowingEnrollment } from '../../middleware/require-auth.js';
import { AUTH_DOCS } from './auth.docs.js';
import {
  acceptInvitationSchema,
  adminLoginSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  mfaVerifySchema,
  otpSendSchema,
  otpVerifySchema,
  refreshSchema,
  resetPasswordSchema,
  totpCodeSchema,
} from './auth.validation.js';

const HOUR = 3600;
const QUARTER = 900;
const byUser = (request: FastifyRequest) => request.user?.id;
const controller = (request: FastifyRequest) => request.diScope.resolve('authController');

/**
 * `/auth/*` (public login flows, rate-limited per identifier AND per IP) and `/me/mfa/*`.
 * Limits run after validation, on redis-cache (one round trip per rule).
 */
export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: { phone: string } }>(
    '/auth/otp/send',
    {
      schema: { ...otpSendSchema, ...routeDocs(AUTH_DOCS.otpSend) },
      preHandler: rateLimit(
        {
          action: 'otp-send',
          dimension: 'dest',
          value: byBodyField('phone'),
          limit: 5,
          windowSeconds: HOUR,
        },
        { action: 'otp-send', dimension: 'ip', value: byIp, limit: 20, windowSeconds: HOUR },
      ),
    },
    (request) => controller(request).otpSend(request),
  );

  app.post<{ Body: { phone: string; code: string } }>(
    '/auth/otp/verify',
    {
      schema: { ...otpVerifySchema, ...routeDocs(AUTH_DOCS.otpVerify) },
      preHandler: rateLimit(
        {
          action: 'otp-verify',
          dimension: 'dest',
          value: byBodyField('phone'),
          limit: 10,
          windowSeconds: HOUR,
        },
        { action: 'otp-verify', dimension: 'ip', value: byIp, limit: 30, windowSeconds: HOUR },
      ),
    },
    (request) => controller(request).otpVerify(request),
  );

  app.post<{ Body: { identifier: string; password: string } }>(
    '/auth/admin/login',
    {
      schema: { ...adminLoginSchema, ...routeDocs(AUTH_DOCS.adminLogin) },
      preHandler: rateLimit(
        {
          action: 'login',
          dimension: 'id',
          value: byBodyField('identifier'),
          limit: 10,
          windowSeconds: QUARTER,
        },
        { action: 'login', dimension: 'ip', value: byIp, limit: 30, windowSeconds: QUARTER },
      ),
    },
    (request) => controller(request).adminLogin(request),
  );

  app.post<{ Body: { challengeId: string; code?: string; recoveryCode?: string } }>(
    '/auth/mfa/verify',
    {
      schema: { ...mfaVerifySchema, ...routeDocs(AUTH_DOCS.mfaVerify) },
      preHandler: rateLimit({
        action: 'mfa-verify',
        dimension: 'ip',
        value: byIp,
        limit: 20,
        windowSeconds: QUARTER,
      }),
    },
    (request) => controller(request).mfaVerify(request),
  );

  app.post<{ Body: { refreshToken: string } }>(
    '/auth/refresh',
    {
      schema: { ...refreshSchema, ...routeDocs(AUTH_DOCS.refresh) },
      preHandler: rateLimit({
        action: 'refresh',
        dimension: 'ip',
        value: byIp,
        limit: 60,
        windowSeconds: 60,
      }),
    },
    (request) => controller(request).refresh(request),
  );

  app.post(
    '/auth/logout',
    { schema: routeDocs(AUTH_DOCS.logout), preHandler: [requireAuthAllowingEnrollment] },
    (request, reply) => controller(request).logout(request, reply),
  );

  app.post(
    '/auth/logout-all',
    { schema: routeDocs(AUTH_DOCS.logoutAll), preHandler: [requireAuth] },
    (request) => controller(request).logoutAll(request),
  );

  app.post<{ Body: { identifier: string } }>(
    '/auth/password/forgot',
    {
      schema: { ...forgotPasswordSchema, ...routeDocs(AUTH_DOCS.forgotPassword) },
      preHandler: rateLimit(
        {
          action: 'pwd-forgot',
          dimension: 'id',
          value: byBodyField('identifier'),
          limit: 3,
          windowSeconds: HOUR,
        },
        { action: 'pwd-forgot', dimension: 'ip', value: byIp, limit: 10, windowSeconds: HOUR },
      ),
    },
    (request) => controller(request).forgotPassword(request),
  );

  app.post<{ Body: { identifier: string; code: string; newPassword: string } }>(
    '/auth/password/reset',
    {
      schema: { ...resetPasswordSchema, ...routeDocs(AUTH_DOCS.resetPassword) },
      preHandler: rateLimit(
        {
          action: 'pwd-reset',
          dimension: 'id',
          value: byBodyField('identifier'),
          limit: 5,
          windowSeconds: QUARTER,
        },
        { action: 'pwd-reset', dimension: 'ip', value: byIp, limit: 20, windowSeconds: QUARTER },
      ),
    },
    (request, reply) => controller(request).resetPassword(request, reply),
  );

  app.post<{ Body: { email: string; code: string; newPassword: string } }>(
    '/auth/invitations/accept',
    {
      schema: { ...acceptInvitationSchema, ...routeDocs(AUTH_DOCS.acceptInvitation) },
      preHandler: rateLimit(
        {
          action: 'invite-accept',
          dimension: 'id',
          value: byBodyField('email'),
          limit: 10,
          windowSeconds: HOUR,
        },
        { action: 'invite-accept', dimension: 'ip', value: byIp, limit: 30, windowSeconds: HOUR },
      ),
    },
    (request, reply) => controller(request).acceptInvitation(request, reply),
  );

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/auth/password/change',
    {
      schema: { ...changePasswordSchema, ...routeDocs(AUTH_DOCS.changePassword) },
      preHandler: [
        requireAuth,
        rateLimit({
          action: 'pwd-change',
          dimension: 'user',
          value: byUser,
          limit: 5,
          windowSeconds: QUARTER,
        }),
      ],
    },
    (request, reply) => controller(request).changePassword(request, reply),
  );

  // ── MFA enrolment (enrolment-only tokens allowed) ──────────────────────────────────────

  app.post(
    '/me/mfa/totp/enroll',
    { schema: routeDocs(AUTH_DOCS.totpEnroll), preHandler: [requireAuthAllowingEnrollment] },
    (request) => controller(request).totpEnroll(request),
  );

  app.post<{ Body: { code: string } }>(
    '/me/mfa/totp/confirm',
    {
      schema: { ...totpCodeSchema, ...routeDocs(AUTH_DOCS.totpConfirm) },
      preHandler: [
        requireAuthAllowingEnrollment,
        rateLimit({
          action: 'totp-confirm',
          dimension: 'user',
          value: byUser,
          limit: 10,
          windowSeconds: QUARTER,
        }),
      ],
    },
    (request) => controller(request).totpConfirm(request),
  );

  app.delete<{ Body: { code: string } }>(
    '/me/mfa/totp',
    {
      schema: { ...totpCodeSchema, ...routeDocs(AUTH_DOCS.totpDisable) },
      preHandler: [
        requireAuth,
        rateLimit({
          action: 'totp-disable',
          dimension: 'user',
          value: byUser,
          limit: 5,
          windowSeconds: QUARTER,
        }),
      ],
    },
    (request, reply) => controller(request).totpDisable(request, reply),
  );
};
