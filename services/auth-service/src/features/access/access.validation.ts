import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

import { ROLE_AUDIENCES, SCOPE_TYPES } from './access.types.js';

const id = Joi.string().guid();
const reason = Joi.string()
  .trim()
  .min(3)
  .max(500)
  .description('Why — stored in the admin audit log');
const permissionKey = Joi.string()
  .pattern(/^[a-z][a-z_]*\.[a-z][a-z_]*$/)
  .max(100);

export const roleAudienceSchema = Joi.string()
  .valid(...ROLE_AUDIENCES)
  .description('Which kind of user may hold the role')
  .meta({ className: 'RoleAudience' });

/** Shared by PUT /admin/users/:id/roles. scopeId: required for WAREHOUSE/REGION/VENDOR, else null. */
export const roleChoiceSchema = Joi.object({
  roleKey: Joi.string()
    .pattern(/^[a-z][a-z0-9_]{1,62}$/)
    .required(),
  scopeType: Joi.string()
    .valid(...SCOPE_TYPES)
    .default('GLOBAL')
    .meta({ className: 'ScopeType' }),
  scopeId: Joi.when('scopeType', {
    is: Joi.valid('WAREHOUSE', 'REGION', 'VENDOR'),
    then: id.required(),
    otherwise: Joi.valid(null).default(null),
  }),
}).meta({ className: 'RoleChoice' });

const roleIdParams = Joi.object({ id: id.required().description('Role id') });
const idleMinutes = Joi.number()
  .integer()
  .min(1)
  .max(43_200)
  .allow(null)
  .description("Idle session timeout; shortest across a user's roles wins");

export const listRolesSchema = {
  querystring: Joi.object({
    cursor: id,
    limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
    q: Joi.string().trim().min(1).max(100).description('Search key or name'),
    audience: roleAudienceSchema,
    includeArchived: Joi.boolean().default(false),
  }),
};

export const getRoleSchema = { params: roleIdParams };

export const createRoleSchema = {
  body: Joi.object({
    key: Joi.string()
      .trim()
      .lowercase()
      .pattern(/^[a-z][a-z0-9_]{1,62}$/)
      .required()
      .description('Stable snake_case key, immutable after creation'),
    name: Joi.string().trim().min(2).max(80).required(),
    description: Joi.string().trim().max(500),
    audience: roleAudienceSchema.required(),
    mfaRequired: Joi.boolean().default(true),
    sessionIdleMinutes: idleMinutes,
    permissions: Joi.array().items(permissionKey).max(500).unique().default([]),
    reason,
  }),
};

export const updateRoleSchema = {
  params: roleIdParams,
  body: Joi.object({
    name: Joi.string().trim().min(2).max(80),
    description: Joi.string().trim().max(500).allow(null),
    mfaRequired: Joi.boolean(),
    sessionIdleMinutes: idleMinutes,
    reason,
  }).min(1),
};

export const archiveRoleSchema = {
  params: roleIdParams,
  body: Joi.object({ reason: reason.required() }),
};

export const setRolePermissionsSchema = {
  params: roleIdParams,
  body: Joi.object({
    permissions: Joi.array()
      .items(permissionKey)
      .max(500)
      .unique()
      .required()
      .description('The full permission set (replaces the current one)'),
    reason: reason.required(),
  }),
};
