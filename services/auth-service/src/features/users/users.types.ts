import type { CursorQuery } from '@farmx/common/types';

export const USER_TYPES = ['INTERNAL', 'CUSTOMER', 'VENDOR', 'LOGISTICS_PARTNER'] as const;
export type UserType = (typeof USER_TYPES)[number];

export const USER_STATUSES = [
  'PENDING_VERIFICATION',
  'ACTIVE',
  'LOCKED',
  'SUSPENDED',
  'DEACTIVATED',
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Statuses an admin may set. LOCKED / PENDING_VERIFICATION are set by the security flows. */
export const ADMIN_SETTABLE_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type AdminSettableStatus = (typeof ADMIN_SETTABLE_STATUSES)[number];

/** MFA cannot be turned off for these user types (FR-REG-18). */
export const MFA_MANDATORY_TYPES: readonly UserType[] = ['INTERNAL', 'VENDOR'];

export const SCOPE_TYPES = ['GLOBAL', 'WAREHOUSE', 'REGION', 'VENDOR', 'OWN'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/** A user row as the repository returns it (never includes credentials). */
export interface UserRecord {
  id: string;
  userType: UserType;
  email: string | null;
  emailVerifiedAt: Date | null;
  phone: string | null;
  phoneVerifiedAt: Date | null;
  username: string | null;
  fullName: string;
  displayName: string | null;
  avatarUrl: string | null;
  employeeCode: string | null;
  preferredLanguage: string;
  timezone: string;
  status: UserStatus;
  statusReason: string | null;
  statusChangedAt: Date | null;
  mfaRequired: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface UserRoleView {
  roleKey: string;
  roleName: string;
  scopeType: string;
  scopeId: string | null;
  expiresAt: string | null;
}

/** API representation. */
export interface UserView {
  id: string;
  userType: UserType;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  username: string | null;
  fullName: string;
  displayName: string | null;
  avatarUrl: string | null;
  employeeCode: string | null;
  preferredLanguage: string;
  timezone: string;
  status: UserStatus;
  statusReason: string | null;
  statusChangedAt: string | null;
  mfaRequired: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  roles: UserRoleView[];
}

export interface UserListQuery extends CursorQuery {
  /** Matches email, phone, username, full name or employee code. */
  q?: string;
  status?: UserStatus;
  userType?: UserType;
  includeDeleted: boolean;
}

/** A role (and scope) to assign; validated by the access feature. */
export interface RoleChoice {
  roleKey: string;
  scopeType: ScopeType;
  scopeId?: string | null;
}

/** Minimal user columns for authentication decisions (auth feature). */
export interface LoginUserRecord {
  id: string;
  userType: UserType;
  status: UserStatus;
  deletedAt: Date | null;
  mfaRequired: boolean;
  mustChangePassword: boolean;
  email: string | null;
  phone: string | null;
  username: string | null;
  fullName: string;
}

/** GET /me: profile + roles + effective permissions + security flags. */
export interface MeView extends UserView {
  permissions: string[];
  mfaEnabled: boolean;
  mfaRequired: boolean;
}

export interface CreateUserInput {
  userType: UserType;
  email?: string;
  phone?: string;
  username?: string;
  fullName: string;
  displayName?: string;
  employeeCode?: string;
  preferredLanguage?: string;
  timezone?: string;
  mfaRequired?: boolean;
  /** Optional first password; the user must change it at first login. */
  temporaryPassword?: string;
  /** Optional initial roles (needs `roles.assign`). */
  roles?: RoleChoice[];
  reason?: string;
}

export interface UpdateUserInput {
  email?: string;
  phone?: string;
  username?: string;
  fullName?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  employeeCode?: string | null;
  preferredLanguage?: string;
  timezone?: string;
  mfaRequired?: boolean;
  reason?: string;
}

/** PUT /admin/users/:id/roles — the complete role set (replaces the current one). */
export interface SetRolesInput {
  roles: RoleChoice[];
  reason: string;
}

export interface ChangeStatusInput {
  status: AdminSettableStatus;
  reason: string;
}

export interface ReasonInput {
  reason: string;
}

export interface ForceLogoutResult {
  revokedSessions: number;
  /** false if Redis was unavailable: live access tokens then expire within 15 minutes. */
  accessTokensBlocked: boolean;
}
