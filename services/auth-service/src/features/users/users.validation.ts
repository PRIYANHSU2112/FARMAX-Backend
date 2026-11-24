import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

import { type RoleChoice, roleChoiceSchema } from '../access/index.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/index.js';
import { ADMIN_SETTABLE_STATUSES, SCOPE_TYPES, USER_STATUSES, USER_TYPES } from './users.types.js';

const id = Joi.string().guid();
const reason = Joi.string()
  .trim()
  .min(3)
  .max(500)
  .description('Why — stored in the admin audit log');
const email = Joi.string()
  .trim()
  .lowercase()
  .email({ tlds: { allow: false } })
  .max(254);
const phone = Joi.string()
  .trim()
  .pattern(/^\+[1-9]\d{7,14}$/)
  .messages({ 'string.pattern.base': '{{#label}} must be E.164, e.g. +919876543210' });
const username = Joi.string()
  .trim()
  .lowercase()
  .pattern(/^[a-z0-9][a-z0-9._-]{2,31}$/)
  .messages({ 'string.pattern.base': '{{#label}} must be 3–32 chars: letters, digits, . _ -' });
const fullName = Joi.string().trim().min(2).max(120);
const displayName = Joi.string().trim().min(1).max(60);
const employeeCode = Joi.string().trim().min(1).max(40);
const language = Joi.string().valid('en', 'te');
const timezone = Joi.string().trim().max(64);

/** Enums, also published as reusable Swagger components (`.meta({ className })` → `$ref`). */
export const userTypeSchema = Joi.string()
  .valid(...USER_TYPES)
  .description('INTERNAL = FarmX staff · CUSTOMER = farmer/buyer · VENDOR · LOGISTICS_PARTNER')
  .meta({ className: 'UserType' });
export const userStatusSchema = Joi.string()
  .valid(...USER_STATUSES)
  .meta({ className: 'UserStatus' });
export const scopeTypeSchema = Joi.string()
  .valid(...SCOPE_TYPES)
  .description('GLOBAL / OWN take no scopeId; WAREHOUSE / REGION / VENDOR need one')
  .meta({ className: 'ScopeType' });
const adminStatusSchema = Joi.string()
  .valid(...ADMIN_SETTABLE_STATUSES)
  .meta({ className: 'AdminSettableStatus' });

/** A role set: at most 20 assignments; each validated by the access feature schema. */
const roleSet = Joi.array()
  .items(roleChoiceSchema)
  .max(20)
  .unique(
    (a: RoleChoice, b: RoleChoice) =>
      a.roleKey === b.roleKey &&
      a.scopeType === b.scopeType &&
      (a.scopeId ?? null) === (b.scopeId ?? null),
  );

const idParams = Joi.object({ id: id.required().description('User id (UUID v7)') });

export const listUsersSchema = {
  querystring: Joi.object({
    cursor: id.description('meta.nextCursor from the previous page'),
    limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
    q: Joi.string()
      .trim()
      .min(1)
      .max(100)
      .description('Search email, phone, username, name or employee code'),
    status: userStatusSchema,
    userType: userTypeSchema,
    includeDeleted: Joi.boolean().default(false).description('Include soft-deleted users'),
  }),
};

export const getUserSchema = { params: idParams };

export const createUserSchema = {
  body: Joi.object({
    userType: userTypeSchema.required(),
    email,
    phone,
    username,
    fullName: fullName.required(),
    displayName,
    employeeCode,
    preferredLanguage: language,
    timezone,
    mfaRequired: Joi.boolean().description('Always true for INTERNAL and VENDOR users'),
    temporaryPassword: Joi.string()
      .min(PASSWORD_MIN_LENGTH)
      .max(PASSWORD_MAX_LENGTH)
      .description(
        'Optional first password (3 of 4 character classes); user must change it at first login. Without it the user is PENDING_VERIFICATION.',
      ),
    roles: roleSet.description('Optional initial roles — needs the roles.assign permission'),
    reason,
  })
    .or('email', 'phone')
    .messages({ 'object.missing': 'email or phone is required' }),
};

export const updateUserSchema = {
  params: idParams,
  body: Joi.object({
    email,
    phone,
    username,
    fullName,
    displayName: displayName.allow(null),
    avatarUrl: Joi.string()
      .uri({ scheme: ['https'] })
      .max(2048)
      .allow(null)
      .description('HTTPS image URL'),
    employeeCode: employeeCode.allow(null),
    preferredLanguage: language,
    timezone,
    mfaRequired: Joi.boolean(),
    reason,
  }).min(1),
};

/** PUT /admin/users/:id/roles — the complete role set (an empty list removes every role). */
export const setRolesSchema = {
  params: idParams,
  body: Joi.object({ roles: roleSet.required(), reason: reason.required() }),
};

export const userSessionsSchema = { params: idParams };

export const changeStatusSchema = {
  params: idParams,
  body: Joi.object({
    status: adminStatusSchema.required(),
    reason: reason.required(),
  }),
};

/** DELETE /:id and POST /:id/force-logout — a reason is mandatory. */
export const reasonSchema = {
  params: idParams,
  body: Joi.object({ reason: reason.required() }),
};

// ── Self-service (`/me`, CUSTOMER) ──

const otpCode = Joi.string()
  .pattern(/^\d{4,8}$/)
  .messages({ 'string.pattern.base': '{{#label}} must be the digits of the code' });

/** Contact screen + profile photo. A new email is stored unverified. */
export const updateMeSchema = {
  body: Joi.object({
    fullName,
    email,
    avatarUrl: Joi.string()
      .uri({ scheme: ['https'] })
      .max(2048)
      .allow(null)
      .description('HTTPS URL from media-service (null removes the photo)'),
  }).min(1),
};

export const phoneOtpSchema = { body: Joi.object({ phone: phone.required() }) };

export const phoneVerifySchema = {
  body: Joi.object({ phone: phone.required(), otp: otpCode.required() }),
};
