import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { roleAudienceSchema } from './access.validation.js';

export const ADMIN_ROLES_TAG = 'Admin Roles';

const roleSchema = Joi.object({
  id: Joi.string().guid(),
  key: Joi.string().example('warehouse_manager'),
  name: Joi.string().example('Warehouse Manager'),
  description: Joi.string().allow(null),
  audience: roleAudienceSchema,
  isSystem: Joi.boolean().description('Seeded system role (super_admin): cannot be changed'),
  mfaRequired: Joi.boolean(),
  sessionIdleMinutes: Joi.number().integer().allow(null),
  permissions: Joi.array().items(Joi.string().example('inventory.view')),
  activeHolders: Joi.number().integer().description('Users currently holding this role'),
  createdAt: Joi.date().iso(),
  updatedAt: Joi.date().iso(),
  archivedAt: Joi.date().iso().allow(null),
}).meta({ className: 'Role' });

const permissionGroupSchema = Joi.object({
  module: Joi.string().example('users'),
  label: Joi.string().example('Users'),
  permissions: Joi.array().items(
    Joi.object({
      key: Joi.string().example('users.view'),
      description: Joi.string(),
      sensitive: Joi.boolean().description('Needs a reason and an audit entry when used'),
      assignable: Joi.boolean().description('false = reserved for the super_admin system role'),
      scopes: Joi.array().items(Joi.string()),
    }).meta({ className: 'Permission' }),
  ),
}).meta({ className: 'PermissionGroup' });

const exampleRole = {
  id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e20',
  key: 'warehouse_manager',
  name: 'Warehouse Manager',
  description: 'Mother warehouse operations',
  audience: 'INTERNAL',
  isSystem: false,
  mfaRequired: true,
  sessionIdleMinutes: 30,
  permissions: ['inventory.pick', 'inventory.receive', 'inventory.view'],
  activeHolders: 3,
  createdAt: '2026-11-11T06:00:00.000Z',
  updatedAt: '2026-11-11T06:00:00.000Z',
  archivedAt: null,
};
const ok = (data: unknown) => ({ success: true, data });

export const ACCESS_DOCS = {
  listRoles: {
    tag: ADMIN_ROLES_TAG,
    summary: 'List roles',
    description:
      'Dynamic roles with their permission keys and active-holder count. Cursor pagination.',
    permission: 'roles.view',
    success: {
      status: 200,
      description: 'A page of roles',
      data: roleSchema,
      paginated: true,
      example: { success: true, data: [exampleRole], meta: { nextCursor: null, limit: 20 } },
    },
    errors: [422],
  },
  getRole: {
    tag: ADMIN_ROLES_TAG,
    summary: 'Get a role',
    permission: 'roles.view',
    success: { status: 200, description: 'The role', data: roleSchema, example: ok(exampleRole) },
    errors: [404, 422],
  },
  createRole: {
    tag: ADMIN_ROLES_TAG,
    summary: 'Create a role',
    description:
      'Permissions must exist in the fixed catalog and be assignable (Super-Admin-only keys are refused).',
    permission: 'roles.create',
    success: { status: 201, description: 'Created', data: roleSchema, example: ok(exampleRole) },
    errors: [400, 409, 422],
  },
  updateRole: {
    tag: ADMIN_ROLES_TAG,
    summary: 'Update a role',
    description:
      'Name, description, MFA flag and idle timeout. The key is immutable. System roles cannot be changed (409).',
    permission: 'roles.update',
    success: {
      status: 200,
      description: 'The updated role',
      data: roleSchema,
      example: ok(exampleRole),
    },
    errors: [404, 409, 422],
  },
  archiveRole: {
    tag: ADMIN_ROLES_TAG,
    summary: 'Archive a role',
    description:
      'Archived roles grant nothing (takes effect immediately). System roles cannot be archived.',
    permission: 'roles.archive',
    success: {
      status: 200,
      description: 'The archived role',
      data: roleSchema,
      example: ok({ ...exampleRole, archivedAt: '2026-11-12T06:00:00.000Z' }),
    },
    errors: [404, 409, 422],
  },
  setRolePermissions: {
    tag: ADMIN_ROLES_TAG,
    summary: 'Set the permissions of a role',
    description:
      'Replaces the full permission set. Holders get the change immediately (cache invalidated).',
    permission: 'roles.update',
    success: {
      status: 200,
      description: 'The role with its new permissions',
      data: roleSchema,
      example: ok(exampleRole),
    },
    errors: [400, 404, 409, 422],
  },
  listPermissions: {
    tag: ADMIN_ROLES_TAG,
    summary: 'List permissions (fixed catalog)',
    description:
      'Read-only. Permissions are defined in code and synced by the seed; grouped by module for the role editor.',
    permission: 'permissions.view',
    success: {
      status: 200,
      description: 'Permission catalog',
      data: Joi.array().items(permissionGroupSchema),
      example: ok([
        {
          module: 'users',
          label: 'Users',
          permissions: [
            {
              key: 'users.view',
              description: 'View admin/staff users',
              sensitive: false,
              assignable: true,
              scopes: ['GLOBAL', 'REGION'],
            },
          ],
        },
      ]),
    },
  },
} satisfies Record<string, RouteDocs>;
