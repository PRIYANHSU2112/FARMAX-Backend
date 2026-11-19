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

/** What a user may do right now (GLOBAL-scope permissions; scoped checks come later). */
export interface UserAccess {
  roles: string[];
  permissions: string[];
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
