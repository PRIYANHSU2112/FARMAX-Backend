/**
 * Event contracts PUBLISHED by auth-service (producer-owned). Consumers import these types;
 * they never import auth-service code. Rules (docs/event-contracts.md):
 *  - A published contract is never edited. Breaking change → new `.v(N+1)` type, publish both
 *    during migration, then retire the old one.
 *  - Adding an OPTIONAL field is the only non-breaking change.
 *  - No secrets in events: never passwords, hashes, OTP codes or tokens.
 *  - Personal data only where a consumer needs it to act (e.g. a welcome message destination).
 */
import type { EventEnvelope } from '../envelope.js';

export const AUTH_EVENT_SOURCE = 'auth-service';

export const AUTH_EVENTS = {
  userRegistered: 'user.registered.v1',
  userStatusChanged: 'user.status_changed.v1',
  userDeleted: 'user.deleted.v1',
  userProfileUpdated: 'user.profile_updated.v1',
  sessionCompromised: 'auth.session_compromised.v1',
} as const;

export type AuthEventType = (typeof AUTH_EVENTS)[keyof typeof AUTH_EVENTS];

export type UserTypeV1 = 'INTERNAL' | 'CUSTOMER' | 'VENDOR' | 'LOGISTICS_PARTNER';
export type UserStatusV1 =
  'PENDING_VERIFICATION' | 'ACTIVE' | 'LOCKED' | 'SUSPENDED' | 'DEACTIVATED' | 'PENDING_DELETION';

/** A user account was created (self sign-up, admin, field executive, vendor onboarding). */
export interface UserRegisteredV1 {
  userId: string;
  userType: UserTypeV1;
  fullName: string;
  /** For the welcome message only. At least one of email / phone is set. */
  email: string | null;
  phone: string | null;
  preferredLanguage: string;
  /** self | admin | field_exec | vendor_onboarding | import | seed */
  registrationSource: string;
  /** Delegate login under a farm owner, if any. */
  parentUserId: string | null;
}

/** A user's status changed (activation, suspension, deactivation, lock). */
export interface UserStatusChangedV1 {
  userId: string;
  previousStatus: UserStatusV1;
  status: UserStatusV1;
  /** Admin user id, or null for system changes (e.g. lockout policy). */
  changedByUserId: string | null;
}

/** A user was soft-deleted. Consumers drop or anonymise their local copies (DPDP). */
export interface UserDeletedV1 {
  userId: string;
  deletedByUserId: string | null;
}

/**
 * The user changed their own profile (`PATCH /me`, phone change). Carries the CURRENT values so
 * consumers keep their snapshots (e.g. farm-service `farm_owners.fullName/phone`) in sync.
 */
export interface UserProfileUpdatedV1 {
  userId: string;
  userType: UserTypeV1;
  fullName: string;
  /** E.164, verified. */
  phone: string | null;
  email: string | null;
  changedFields: ('fullName' | 'phone' | 'email' | 'avatarUrl')[];
}

/** Refresh-token reuse was detected; the whole session family was revoked. */
export interface SessionCompromisedV1 {
  userId: string;
  familyId: string;
  /** Number of sessions revoked. */
  revokedSessions: number;
  ip: string | null;
  deviceId: string | null;
}

/** Envelope type per routing key — use for exhaustive handling in consumers. */
export interface AuthEventMap {
  'user.registered.v1': EventEnvelope<'user.registered.v1', UserRegisteredV1>;
  'user.status_changed.v1': EventEnvelope<'user.status_changed.v1', UserStatusChangedV1>;
  'user.deleted.v1': EventEnvelope<'user.deleted.v1', UserDeletedV1>;
  'user.profile_updated.v1': EventEnvelope<'user.profile_updated.v1', UserProfileUpdatedV1>;
  'auth.session_compromised.v1': EventEnvelope<'auth.session_compromised.v1', SessionCompromisedV1>;
}

export type AuthEvent = AuthEventMap[AuthEventType];
