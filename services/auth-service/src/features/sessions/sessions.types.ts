export { ACCESS_TOKEN_TTL_SECONDS } from '../tokens/index.js';

/** Mirrors the Prisma enum `SessionRevokeReason`. */
export type SessionRevokeReason =
  | 'LOGOUT'
  | 'LOGOUT_ALL'
  | 'REUSE_DETECTED'
  | 'PASSWORD_CHANGED'
  | 'ROLE_CHANGED'
  | 'USER_SUSPENDED'
  | 'DEVICE_BLOCKED'
  | 'DEVICE_REVOKED'
  | 'IDLE_TIMEOUT'
  | 'ADMIN';

/**
 * A rotated refresh token presented again within this window is treated as a client retry race
 * (refused, but the family is NOT revoked). After it, the reuse is treated as theft.
 */
export const ROTATION_GRACE_SECONDS = 10;

export interface CreateSessionInput {
  userId: string;
  deviceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Idle timeout: each refresh extends the session by this much. */
  idleSeconds: number;
  /** Hard cap from login, never extended. */
  absoluteSeconds: number;
  mfaVerifiedAt?: Date | null;
}

export interface CreatedSession {
  sessionId: string;
  /** Opaque, 256-bit. Returned to the client once; only its SHA-256 is stored. */
  refreshToken: string;
  absoluteExpiresAt: Date;
}

export type RotateResult =
  | {
      ok: true;
      userId: string;
      sessionId: string;
      refreshToken: string;
      absoluteExpiresAt: Date;
      mfaVerifiedAt: Date | null;
    }
  | {
      ok: false;
      reason: 'unknown' | 'revoked' | 'expired' | 'rotated_recently' | 'reused';
      userId?: string;
      sessionId?: string;
    };

export interface SessionView {
  id: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  current: boolean;
}

/** Row locked during rotation. */
export interface SessionLockRow {
  id: string;
  userId: string;
  familyId: string;
  deviceId: string | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  mfaVerifiedAt: Date | null;
}
