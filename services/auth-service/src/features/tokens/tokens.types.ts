import type { TokenScope, UserType } from '@farmx/common/types';

/** Access-token lifetime (15 min). Revocation flags in Redis must live at least this long. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Enrolment-only tokens (MFA required but not enrolled) are short-lived and have no refresh. */
export const ENROLMENT_TOKEN_TTL_SECONDS = 10 * 60;

export interface AccessTokenInput {
  userId: string;
  sessionId: string;
  userType: UserType;
  roles: readonly string[];
  scope: TokenScope;
}

export interface IssuedAccessToken {
  accessToken: string;
  jti: string;
  /** Epoch seconds. */
  expiresAt: number;
  expiresIn: number;
}

export interface Jwks {
  keys: Record<string, unknown>[];
}
