import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { USER_TAG } from '../sessions/index.js';
import { AUTH_TAG } from '../tokens/index.js';

const userSummarySchema = Joi.object({
  id: Joi.string().guid(),
  userType: Joi.string().valid('INTERNAL', 'CUSTOMER', 'VENDOR', 'LOGISTICS_PARTNER'),
  fullName: Joi.string().allow(''),
  roles: Joi.array().items(Joi.string().example('super_admin')),
  mustChangePassword: Joi.boolean().description('Force the change-password screen'),
}).meta({ className: 'AuthUserSummary' });

const tokensSchema = Joi.object({
  status: Joi.string().valid('authenticated'),
  tokenType: Joi.string().valid('Bearer'),
  accessToken: Joi.string().description(
    'EdDSA JWT, 15 min. Send as `Authorization: Bearer <token>`',
  ),
  expiresIn: Joi.number().integer().example(900),
  refreshToken: Joi.string().description('Opaque, single use: every refresh returns a new one'),
  refreshExpiresAt: Joi.date()
    .iso()
    .description('Absolute session end (idle timeout may end it sooner)'),
  isNewUser: Joi.boolean().description(
    'Customer OTP login only: account created just now → onboarding',
  ),
  user: userSummarySchema,
}).meta({ className: 'AuthTokens' });

const mfaChallengeSchema = Joi.object({
  status: Joi.string().valid('mfa_required'),
  challengeId: Joi.string().description(
    'Send with the code to POST /auth/mfa/verify (5 min, 5 attempts)',
  ),
  methods: Joi.array().items(Joi.string().valid('totp', 'recovery_code')),
  expiresIn: Joi.number().integer().example(300),
}).meta({ className: 'MfaChallenge' });

const mfaEnrollmentSchema = Joi.object({
  status: Joi.string().valid('mfa_enrollment_required'),
  tokenType: Joi.string().valid('Bearer'),
  accessToken: Joi.string().description(
    'Enrolment-only token: works ONLY for /me/mfa/totp/* (10 min)',
  ),
  expiresIn: Joi.number().integer().example(600),
  user: userSummarySchema,
}).meta({ className: 'MfaEnrollmentRequired' });

const sentSchema = Joi.object({
  sent: Joi.boolean().valid(true),
  expiresIn: Joi.number().integer().example(300),
  resendAfter: Joi.number().integer().example(30),
}).meta({ className: 'OtpSent' });

const exampleUser = {
  id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e01',
  userType: 'INTERNAL',
  fullName: 'Ravi Kumar',
  roles: ['super_admin'],
  mustChangePassword: false,
};
const exampleTokens = {
  status: 'authenticated',
  tokenType: 'Bearer',
  accessToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6IjIwMjYtMTEifQ.eyJzdWIiOiIuLi4ifQ.c2ln',
  expiresIn: 900,
  refreshToken: 'hT4sV1n2b7Qe0Zx3YkPq8mRf6WcJ9uLd5aGo1sNtE2y',
  refreshExpiresAt: '2026-11-11T18:00:00.000Z',
  user: exampleUser,
};
const ok = (data: unknown) => ({ success: true, data });

export const AUTH_DOCS = {
  otpSend: {
    tag: AUTH_TAG,
    summary: 'Customer login — send OTP',
    description:
      'Sends a 6-digit code by SMS (valid 5 min, 5 attempts, resend after 30 s). The response is the same ' +
      'whether or not the number is registered. Limits: 5/h per number, 20/h per IP.',
    public: true,
    success: {
      status: 200,
      description: 'Code sent',
      data: sentSchema,
      example: ok({ sent: true, expiresIn: 300, resendAfter: 30 }),
    },
    errors: [422],
  },
  otpVerify: {
    tag: AUTH_TAG,
    summary: 'Customer login — verify OTP',
    description:
      'Valid code → session. An unknown number creates a customer account (`isNewUser: true` → onboarding). ' +
      'Staff/vendor accounts must use the admin login (403).',
    public: true,
    success: {
      status: 200,
      description: 'Logged in',
      data: tokensSchema,
      example: ok({
        ...exampleTokens,
        isNewUser: true,
        user: { ...exampleUser, userType: 'CUSTOMER', roles: [], fullName: '' },
      }),
    },
    errors: [401, 403, 422],
  },
  adminLogin: {
    tag: AUTH_TAG,
    summary: 'Admin login — email/username + password',
    description:
      'Three outcomes (see `status`): `authenticated` (tokens), `mfa_required` (send the authenticator code to ' +
      '/auth/mfa/verify) or `mfa_enrollment_required` (enrolment-only token: set up an authenticator first). ' +
      'Wrong credentials → 401 (generic). 5 consecutive failures lock the account for 15 min (403).',
    public: true,
    success: {
      status: 200,
      description: 'Logged in, or a second step is required',
      data: Joi.alternatives().try(tokensSchema, mfaChallengeSchema, mfaEnrollmentSchema),
      example: ok({
        status: 'mfa_required',
        challengeId: 'mJ0x8Qm3Z2c1VfXo9hT4sV1n2b7Qe0Zx',
        methods: ['totp', 'recovery_code'],
        expiresIn: 300,
      }),
    },
    errors: [401, 403, 422],
  },
  mfaVerify: {
    tag: AUTH_TAG,
    summary: 'Admin login — verify MFA',
    description:
      'Authenticator code (or a single-use recovery code) for the challenge from the login response.',
    public: true,
    success: {
      status: 200,
      description: 'Logged in',
      data: tokensSchema,
      example: ok(exampleTokens),
    },
    errors: [401, 403, 422],
  },
  refresh: {
    tag: AUTH_TAG,
    summary: 'Refresh tokens (rotating)',
    description:
      'Returns a new access token AND a new refresh token; the old refresh token stops working. Re-using an ' +
      'old refresh token later is treated as theft: every session of that login is revoked.',
    public: true,
    success: {
      status: 200,
      description: 'New tokens',
      data: tokensSchema,
      example: ok(exampleTokens),
    },
    errors: [401, 422],
  },
  logout: {
    tag: AUTH_TAG,
    summary: 'Log out (this session)',
    description: 'The refresh token is revoked and this access token is blacklisted immediately.',
    success: { status: 204, description: 'Logged out' },
  },
  logoutAll: {
    tag: AUTH_TAG,
    summary: 'Log out everywhere',
    description: 'Revokes every session of the caller on every device.',
    success: {
      status: 200,
      description: 'Sessions revoked',
      data: Joi.object({ revokedSessions: Joi.number().integer() }),
      example: ok({ revokedSessions: 3 }),
    },
  },
  forgotPassword: {
    tag: AUTH_TAG,
    summary: 'Forgot password — send reset code',
    description:
      'Staff/vendor accounts. Code by SMS (or email). Same response for every identifier. 3/h per identifier.',
    public: true,
    success: {
      status: 200,
      description: 'If the account exists, a code was sent',
      data: Joi.object({ sent: Joi.boolean() }),
      example: ok({ sent: true }),
    },
    errors: [422],
  },
  resetPassword: {
    tag: AUTH_TAG,
    summary: 'Reset password with the code',
    description: 'Sets the new password and ends every session of the account.',
    public: true,
    success: { status: 204, description: 'Password changed' },
    errors: [400, 422],
  },
  changePassword: {
    tag: USER_TAG,
    summary: 'Change my password',
    description: 'Needs the current password. Every other session is logged out.',
    success: { status: 204, description: 'Password changed' },
    errors: [400, 422],
  },
  totpEnroll: {
    tag: USER_TAG,
    summary: 'MFA — start authenticator setup',
    description:
      'Returns a secret and an otpauth:// URL (render it as a QR code). Also works with an enrolment-only token.',
    success: {
      status: 200,
      description: 'Scan this in Google Authenticator / Microsoft Authenticator',
      data: Joi.object({ secret: Joi.string(), otpauthUrl: Joi.string() }).meta({
        className: 'TotpEnrollment',
      }),
      example: ok({
        secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        otpauthUrl: 'otpauth://totp/FarmX%3Aravi%40farmx.in?secret=JBSWY3DPEHPK3PXP&issuer=FarmX',
      }),
    },
    errors: [409],
  },
  totpConfirm: {
    tag: USER_TAG,
    summary: 'MFA — confirm authenticator',
    description:
      'First code from the app. Returns 10 single-use recovery codes (shown ONCE). An enrolment-only caller also ' +
      'receives full tokens for a new session.',
    success: {
      status: 200,
      description: 'Authenticator active',
      data: Joi.object({
        recoveryCodes: Joi.array().items(Joi.string().example('k7m2-p9qx')),
        tokens: tokensSchema,
      }).meta({ className: 'TotpConfirmed' }),
      example: ok({ recoveryCodes: ['k7m2-p9qx', 'a3bd-77fq'] }),
    },
    errors: [400, 404, 409, 422],
  },
  totpDisable: {
    tag: USER_TAG,
    summary: 'MFA — remove authenticator',
    description: 'Needs a current code. Refused (409) when MFA is mandatory for the account.',
    success: { status: 204, description: 'Removed' },
    errors: [400, 409, 422],
  },
} satisfies Record<string, RouteDocs>;
