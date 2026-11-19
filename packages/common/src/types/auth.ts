import type { SessionId, UserId } from './common.js';

/** Persona family of a user (mirrors auth-service `UserType`). */
export type UserType = 'INTERNAL' | 'CUSTOMER' | 'VENDOR' | 'LOGISTICS_PARTNER';

/**
 * Token scope. `full` = normal access. `mfa_enroll` = an MFA-required user who has not enrolled
 * yet: may only call the MFA enrolment endpoints.
 */
export type TokenScope = 'full' | 'mfa_enroll';

/** The authenticated caller, attached to each request after access-token verification. */
export interface AuthUser {
  id: UserId;
  sessionId: SessionId;
  /** Access-token id (used for logout blacklisting). */
  jti: string;
  userType: UserType;
  /** Role keys (dynamic, from the DB), e.g. `super_admin`. Permissions are resolved server-side. */
  roles: readonly string[];
  scope: TokenScope;
  /** Access-token expiry, epoch seconds. */
  expiresAt: number;
}
