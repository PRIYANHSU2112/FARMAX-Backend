import Joi from 'joi';

import {
  DEVICE_PLATFORMS,
  OTP_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './auth.types.js';

const phone = Joi.string()
  .trim()
  .pattern(/^\+[1-9]\d{7,14}$/)
  .description('Mobile in E.164, e.g. +919876543210')
  .messages({ 'string.pattern.base': '{{#label}} must be E.164, e.g. +919876543210' });
const otpCode = Joi.string()
  .pattern(new RegExp(`^\\d{${OTP_LENGTH}}$`))
  .description(`${OTP_LENGTH}-digit code`)
  .messages({ 'string.pattern.base': `{{#label}} must be ${OTP_LENGTH} digits` });
const identifier = Joi.string()
  .trim()
  .min(3)
  .max(254)
  .description('Email, username or E.164 mobile');
const newPassword = Joi.string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .description(
    `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} chars, 3 of 4 character classes, not a recent or common password`,
  );

/** Optional client device info: enables device monitoring and blocked-device enforcement. */
const device = {
  deviceId: Joi.string()
    .pattern(/^[A-Za-z0-9._:-]{8,128}$/)
    .description('Stable client device id (app install id / browser id); hashed before storage'),
  deviceName: Joi.string().trim().max(60).description('e.g. "Ravi\'s Redmi"'),
  platform: Joi.string()
    .valid(...DEVICE_PLATFORMS)
    .meta({ className: 'DevicePlatform' }),
};

export const otpSendSchema = { body: Joi.object({ phone: phone.required() }) };

export const otpVerifySchema = {
  body: Joi.object({ phone: phone.required(), code: otpCode.required(), ...device }),
};

export const adminLoginSchema = {
  body: Joi.object({
    identifier: identifier.required(),
    password: Joi.string().min(1).max(PASSWORD_MAX_LENGTH).required(),
    ...device,
  }),
};

export const mfaVerifySchema = {
  body: Joi.object({
    challengeId: Joi.string()
      .pattern(/^[A-Za-z0-9_-]{32}$/)
      .required()
      .description('From the login response'),
    code: Joi.string()
      .pattern(/^\d{6}$/)
      .description('6-digit authenticator code'),
    recoveryCode: Joi.string()
      .trim()
      .max(20)
      .description('One of your recovery codes (single use)'),
  })
    .xor('code', 'recoveryCode')
    .messages({
      'object.xor': 'Send either code or recoveryCode',
      'object.missing': 'Send either code or recoveryCode',
    }),
};

export const refreshSchema = {
  body: Joi.object({
    refreshToken: Joi.string()
      .pattern(/^[A-Za-z0-9_-]{43}$/)
      .required()
      .description('The opaque refresh token'),
  }),
};

export const forgotPasswordSchema = { body: Joi.object({ identifier: identifier.required() }) };

export const resetPasswordSchema = {
  body: Joi.object({
    identifier: identifier.required(),
    code: otpCode.required(),
    newPassword: newPassword.required(),
  }),
};

/** POST /auth/invitations/accept — warehouse staff invitation (D-56). */
export const acceptInvitationSchema = {
  body: Joi.object({
    email: Joi.string().trim().lowercase().email().max(254).required(),
    code: otpCode.required(),
    newPassword: newPassword.required(),
  }),
};

export const changePasswordSchema = {
  body: Joi.object({
    currentPassword: Joi.string().min(1).max(PASSWORD_MAX_LENGTH).required(),
    newPassword: newPassword.required(),
  }),
};

export const totpCodeSchema = {
  body: Joi.object({
    code: Joi.string()
      .pattern(/^\d{6}$/)
      .required()
      .description('6-digit authenticator code'),
  }),
};
