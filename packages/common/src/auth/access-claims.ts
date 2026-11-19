import type { AuthUser, SessionId, TokenScope, UserId, UserType } from '../types/index.js';
import { JwtError } from './jwt.js';

/** Claims of a FarmX access token (issued by auth-service). */
export interface AccessClaims {
  sub: string;
  sid: string;
  jti: string;
  typ: UserType;
  roles: string[];
  scope: TokenScope;
  exp: number;
}

const USER_TYPES: readonly UserType[] = ['INTERNAL', 'CUSTOMER', 'VENDOR', 'LOGISTICS_PARTNER'];
const SCOPES: readonly TokenScope[] = ['full', 'mfa_enroll'];

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Validates the shape of verified JWT claims. Throws JwtError('bad claims'). */
export function parseAccessClaims(claims: Record<string, unknown>): AccessClaims {
  const { sub, sid, jti, typ, roles, scope, exp } = claims;
  if (
    typeof sub !== 'string' ||
    typeof sid !== 'string' ||
    typeof jti !== 'string' ||
    typeof exp !== 'number' ||
    !USER_TYPES.includes(typ as UserType) ||
    !SCOPES.includes(scope as TokenScope) ||
    !isStringArray(roles)
  ) {
    throw new JwtError('bad claims');
  }
  return { sub, sid, jti, typ: typ as UserType, roles, scope: scope as TokenScope, exp };
}

export const toAuthUser = (claims: AccessClaims): AuthUser => ({
  id: claims.sub as UserId,
  sessionId: claims.sid as SessionId,
  jti: claims.jti,
  userType: claims.typ,
  roles: claims.roles,
  scope: claims.scope,
  expiresAt: claims.exp,
});
