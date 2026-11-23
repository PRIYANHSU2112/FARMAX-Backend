import type { CursorQuery } from '@farmx/common/types';

export const SCOPE_TYPES = ['GLOBAL', 'WAREHOUSE', 'REGION', 'VENDOR', 'OWN'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const ROLE_AUDIENCES = ['INTERNAL', 'CUSTOMER', 'VENDOR', 'LOGISTICS_PARTNER'] as const;
/** Mirrors users' UserType on purpose (no shared types between features). */
export type RoleAudience = (typeof ROLE_AUDIENCES)[number];

export const SCOPES_WITH_ID: readonly ScopeType[] = ['WAREHOUSE', 'REGION', 'VENDOR'];

/** Effective-permission cache lifetime. Any role/permission change invalidates it earlier. */
export const ACCESS_CACHE_TTL_SECONDS = 300;

/** One active role assignment of a user. */
export interface RoleAssignment {
  id: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  scopeType: ScopeType;
  scopeId: string | null;
  expiresAt: string | null;
}

/** What a user may do right now. */
export interface UserAccess {
  roles: string[];
  /** Granted at GLOBAL scope: valid everywhere. */
  permissions: string[];
  /**
   * Extra permissions granted at ONE warehouse (WAREHOUSE-scoped assignments), keyed by warehouse
   * id. Only keys whose catalog scopes allow WAREHOUSE; keys already in `permissions` are left out.
   */
  warehouses: Record<string, string[]>;
  /** Any held role requires MFA. */
  mfaRequired: boolean;
  /** Shortest idle timeout across the user's roles (null = none set). */
  sessionIdleMinutes: number | null;
}

export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  audience: RoleAudience;
  isSystem: boolean;
  mfaRequired: boolean;
  sessionIdleMinutes: number | null;
  permissions: string[];
  activeHolders: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface RoleListQuery extends CursorQuery {
  q?: string;
  audience?: RoleAudience;
  includeArchived: boolean;
}

export interface CreateRoleInput {
  key: string;
  name: string;
  description?: string;
  audience: RoleAudience;
  mfaRequired?: boolean;
  sessionIdleMinutes?: number | null;
  permissions?: string[];
  reason?: string;
}

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
  mfaRequired?: boolean;
  sessionIdleMinutes?: number | null;
  reason?: string;
}

export interface SetRolePermissionsInput {
  permissions: string[];
  reason: string;
}

export interface RoleChoice {
  roleKey: string;
  scopeType: ScopeType;
  scopeId?: string | null;
}

export interface SetUserRolesInput {
  userId: string;
  /** The user's type; every role's audience must match it. */
  userType: RoleAudience;
  roles: RoleChoice[];
  actorUserId: string;
  reason: string;
}

export interface SetUserRolesResult {
  added: RoleAssignment[];
  removed: RoleAssignment[];
  current: RoleAssignment[];
}

export interface PermissionGroupView {
  module: string;
  label: string;
  permissions: {
    key: string;
    description: string;
    sensitive: boolean;
    assignable: boolean;
    scopes: string[];
  }[];
}

/** An active member of one scope (e.g. the staff of a warehouse) and the roles held there. */
export interface ScopeMember {
  userId: string;
  roles: { roleId: string; roleKey: string; roleName: string; assignedAt: string }[];
}

/** Where a role is in use: shown before a (global) role-template edit. */
export interface RoleUsage {
  roleId: string;
  roleKey: string;
  /** Distinct users holding the role at any scope. */
  staffCount: number;
  /** Distinct warehouses where it is granted (WAREHOUSE scope). */
  warehouseCount: number;
  scopes: { scopeType: ScopeType; scopeId: string | null; holders: number }[];
}

/** Grantable at one warehouse: INTERNAL, not system, every permission WAREHOUSE-scopable. */
export interface WarehouseRoleTemplate {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  usage: { staffCount: number; warehouseCount: number };
}
