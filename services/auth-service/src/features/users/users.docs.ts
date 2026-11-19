import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { USER_TAG, sessionSchema } from '../sessions/index.js';

import { scopeTypeSchema, userStatusSchema, userTypeSchema } from './users.validation.js';

/** Swagger section for these routes. Self-service user APIs (`/me`) will use the `User` tag. */
export const ADMIN_USERS_TAG = 'Admin Users';

const uuid = Joi.string().guid();
const dateTime = Joi.date().iso();

/** Response schemas (docs only) — published as reusable components via `className`. */
const userRoleSchema = Joi.object({
  roleKey: Joi.string().example('warehouse_manager'),
  roleName: Joi.string().example('Warehouse Manager'),
  scopeType: scopeTypeSchema,
  scopeId: uuid.allow(null),
  expiresAt: dateTime.allow(null),
}).meta({ className: 'UserRole' });

export const userSchema = Joi.object({
  id: uuid,
  userType: userTypeSchema,
  email: Joi.string().email().allow(null),
  emailVerified: Joi.boolean(),
  phone: Joi.string().allow(null).example('+919876543210'),
  phoneVerified: Joi.boolean(),
  username: Joi.string().allow(null),
  fullName: Joi.string(),
  displayName: Joi.string().allow(null),
  avatarUrl: Joi.string().uri().allow(null),
  employeeCode: Joi.string().allow(null),
  preferredLanguage: Joi.string().valid('en', 'te'),
  timezone: Joi.string().example('Asia/Kolkata'),
  status: userStatusSchema,
  statusReason: Joi.string().allow(null),
  statusChangedAt: dateTime.allow(null),
  mfaRequired: Joi.boolean(),
  mustChangePassword: Joi.boolean(),
  lastLoginAt: dateTime.allow(null),
  createdAt: dateTime,
  updatedAt: dateTime,
  deletedAt: dateTime.allow(null).description('Set when soft-deleted'),
  roles: Joi.array().items(userRoleSchema),
}).meta({ className: 'User' });

const forceLogoutSchema = Joi.object({
  revokedSessions: Joi.number().integer().example(2),
  accessTokensBlocked: Joi.boolean().description(
    'false if Redis was unavailable: live access tokens then expire within 15 minutes',
  ),
}).meta({ className: 'ForceLogoutResult' });

/** Example payloads (shared by every route below). */
const exampleUser = {
  id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e01',
  userType: 'INTERNAL',
  email: 'ravi@farmx.in',
  emailVerified: true,
  phone: '+919876543210',
  phoneVerified: true,
  username: null,
  fullName: 'Ravi Kumar',
  displayName: null,
  avatarUrl: null,
  employeeCode: 'FX-0042',
  preferredLanguage: 'en',
  timezone: 'Asia/Kolkata',
  status: 'ACTIVE',
  statusReason: null,
  statusChangedAt: '2026-11-10T09:30:00.000Z',
  mfaRequired: true,
  mustChangePassword: false,
  lastLoginAt: '2026-11-11T05:12:44.000Z',
  createdAt: '2026-11-10T09:30:00.000Z',
  updatedAt: '2026-11-10T09:30:00.000Z',
  deletedAt: null,
  roles: [
    {
      roleKey: 'warehouse_manager',
      roleName: 'Warehouse Manager',
      scopeType: 'GLOBAL',
      scopeId: null,
      expiresAt: null,
    },
  ],
};
const ok = (data: unknown) => ({ success: true, data });

/** Swagger docs per route (spread into the route `schema`). */
const meSchema = userSchema
  .keys({
    permissions: Joi.array()
      .items(Joi.string().example('users.view'))
      .description('Effective GLOBAL permissions'),
    mfaEnabled: Joi.boolean().description('An authenticator app is set up'),
    mfaRequired: Joi.boolean().description('MFA is mandatory for this account'),
  })
  .meta({ className: 'Me' });

export const USERS_DOCS = {
  me: {
    tag: USER_TAG,
    summary: 'My profile',
    description:
      'The logged-in user: profile, roles (with scope), effective permissions and MFA status.',
    success: {
      status: 200,
      description: 'Your profile',
      data: meSchema,
      example: ok({
        ...exampleUser,
        permissions: ['inventory.view', 'users.view'],
        mfaEnabled: true,
        mfaRequired: true,
      }),
    },
  },
  list: {
    tag: ADMIN_USERS_TAG,
    summary: 'List users',
    description:
      'Newest first. Cursor pagination: pass `meta.nextCursor` as `cursor` for the next page.',
    permission: 'users.view',
    success: {
      status: 200,
      description: 'A page of users',
      data: userSchema,
      paginated: true,
      example: {
        success: true,
        data: [exampleUser],
        meta: { nextCursor: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e01', limit: 20 },
      },
    },
    errors: [422],
  },
  get: {
    tag: ADMIN_USERS_TAG,
    summary: 'Get a user',
    description: 'Returns soft-deleted users too (`deletedAt` is set).',
    permission: 'users.view',
    success: { status: 200, description: 'The user', data: userSchema, example: ok(exampleUser) },
    errors: [404, 422],
  },
  create: {
    tag: ADMIN_USERS_TAG,
    summary: 'Create a user',
    description:
      'Email or phone is required. With `temporaryPassword` the user is ACTIVE and must change it at first login; ' +
      'without it the user is PENDING_VERIFICATION. An initial `role` also needs `roles.assign`.',
    permission: 'users.invite',
    success: {
      status: 201,
      description: 'Created',
      data: userSchema,
      example: ok({ ...exampleUser, mustChangePassword: true }),
    },
    errors: [400, 404, 409, 422],
  },
  update: {
    tag: ADMIN_USERS_TAG,
    summary: 'Update profile and identifiers',
    description:
      'Only changed fields are written and audited. A changed email or phone must be verified again.',
    permission: 'users.update',
    success: {
      status: 200,
      description: 'The updated user',
      data: userSchema,
      example: ok(exampleUser),
    },
    errors: [400, 404, 409, 422],
  },
  setRoles: {
    tag: ADMIN_USERS_TAG,
    summary: 'Set roles',
    description:
      'Replaces the complete role set (diff-based: unchanged assignments are kept). Each role has a scope ' +
      "(GLOBAL / WAREHOUSE / REGION / VENDOR / OWN). Ends the user's sessions when anything changes. " +
      'You cannot change your own roles, or remove the last active Super Admin (409).',
    permission: 'roles.assign',
    success: {
      status: 200,
      description: 'The user with the new roles',
      data: userSchema,
      example: ok(exampleUser),
    },
    errors: [400, 404, 409, 422],
  },
  block: {
    tag: ADMIN_USERS_TAG,
    summary: 'Block a user',
    description:
      'Status SUSPENDED and every session ends immediately. Not allowed on yourself or the last Super Admin.',
    permission: 'users.suspend',
    success: {
      status: 200,
      description: 'The blocked user',
      data: userSchema,
      example: ok({ ...exampleUser, status: 'SUSPENDED', statusReason: 'Shared credentials' }),
    },
    errors: [404, 409, 422],
  },
  unblock: {
    tag: ADMIN_USERS_TAG,
    summary: 'Unblock a user',
    description: 'Status back to ACTIVE. The user logs in again.',
    permission: 'users.suspend',
    success: {
      status: 200,
      description: 'The active user',
      data: userSchema,
      example: ok(exampleUser),
    },
    errors: [404, 422],
  },
  sessions: {
    tag: ADMIN_USERS_TAG,
    summary: "List a user's active sessions",
    description:
      'Device, IP and timestamps of every live session (monitoring). Revoke with force-logout.',
    permission: 'users.sessions_view',
    success: {
      status: 200,
      description: 'Active sessions',
      data: Joi.array().items(sessionSchema),
    },
    errors: [404, 422],
  },
  changeStatus: {
    tag: ADMIN_USERS_TAG,
    summary: 'Change status (activate / suspend / deactivate)',
    description:
      "Anything other than ACTIVE ends all of the user's sessions. You cannot change your own status, " +
      'or suspend the last active Super Admin (409).',
    permission: 'users.suspend',
    success: {
      status: 200,
      description: 'The user with the new status',
      data: userSchema,
      example: ok({ ...exampleUser, status: 'SUSPENDED', statusReason: 'Policy breach' }),
    },
    errors: [404, 409, 422],
  },
  remove: {
    tag: ADMIN_USERS_TAG,
    summary: 'Delete a user (soft delete)',
    description:
      'Sets `deletedAt`, status DEACTIVATED and ends all sessions. Identifiers stay reserved. ' +
      'You cannot delete yourself or the last active Super Admin (409).',
    permission: 'users.suspend',
    success: { status: 204, description: 'Deleted (no body)' },
    errors: [404, 409, 422],
  },
  forceLogout: {
    tag: ADMIN_USERS_TAG,
    summary: 'Force logout (all sessions)',
    description:
      'Refresh tokens stop working immediately; access tokens are blocked at the gateway.',
    permission: 'users.sessions_revoke',
    success: {
      status: 200,
      description: 'Sessions revoked',
      data: forceLogoutSchema,
      example: ok({ revokedSessions: 2, accessTokensBlocked: true }),
    },
    errors: [404, 422],
  },
} satisfies Record<string, RouteDocs>;
