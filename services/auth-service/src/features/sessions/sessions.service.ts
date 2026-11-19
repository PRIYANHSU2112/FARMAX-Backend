import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { NotFoundError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import { authKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  type CreateSessionInput,
  type CreatedSession,
  ROTATION_GRACE_SECONDS,
  type RotateResult,
  type SessionRevokeReason,
  type SessionView,
} from './sessions.types.js';

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const newRefreshToken = (): string => randomBytes(32).toString('base64url');
const addSeconds = (date: Date, seconds: number): Date => new Date(date.getTime() + seconds * 1000);

type Deps = Pick<Cradle, 'sessionsRepository' | 'redis' | 'logger' | 'runInTransaction'>;

/**
 * Public API of the sessions feature: refresh-token sessions with rotation and reuse detection.
 *
 * Revocation has two parts:
 * 1. DB: `revokedAt` is set, so the refresh token is dead (inside the caller's transaction).
 * 2. Redis: `revoked:sid:<id>` is set AFTER commit, so live access tokens are rejected at once.
 */
export class SessionsService {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** Starts a new session family (login). */
  async createSession(input: CreateSessionInput, tx?: Tx): Promise<CreatedSession> {
    const now = new Date();
    const refreshToken = newRefreshToken();
    const absoluteExpiresAt = addSeconds(now, input.absoluteSeconds);
    const idleExpiresAt = new Date(
      Math.min(addSeconds(now, input.idleSeconds).getTime(), absoluteExpiresAt.getTime()),
    );
    const { id } = await this.deps.sessionsRepository.create(
      {
        userId: input.userId,
        familyId: randomUUID(),
        tokenHash: hashToken(refreshToken),
        deviceId: input.deviceId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        lastUsedAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
        mfaVerifiedAt: input.mfaVerifiedAt ?? null,
      },
      tx,
    );
    return { sessionId: id, refreshToken, absoluteExpiresAt };
  }

  /**
   * Rotates a refresh token: the old row is locked, marked rotated and replaced by a new row in
   * the same family. A rotated token presented after the grace window = theft: the whole family
   * is revoked (and its access tokens blocked).
   */
  async rotate(
    refreshToken: string,
    meta: { ip?: string | null; userAgent?: string | null },
  ): Promise<RotateResult> {
    const { sessionsRepository, runInTransaction } = this.deps;
    const now = new Date();
    let toBlock: string[] = [];

    const result = await runInTransaction(async (tx): Promise<RotateResult> => {
      const row = await sessionsRepository.lockByTokenHash(hashToken(refreshToken), tx);
      if (row === null) return { ok: false, reason: 'unknown' };
      const who = { userId: row.userId, sessionId: row.id };

      if (row.revokedAt !== null) return { ok: false, reason: 'revoked', ...who };
      if (row.rotatedAt !== null) {
        if (now.getTime() - row.rotatedAt.getTime() <= ROTATION_GRACE_SECONDS * 1000) {
          return { ok: false, reason: 'rotated_recently', ...who };
        }
        toBlock = await sessionsRepository.revokeFamily(row.familyId, 'REUSE_DETECTED', now, tx);
        return { ok: false, reason: 'reused', ...who };
      }
      if (row.idleExpiresAt <= now || row.absoluteExpiresAt <= now) {
        await sessionsRepository.revoke(row.id, 'IDLE_TIMEOUT', now, undefined, tx);
        return { ok: false, reason: 'expired', ...who };
      }

      // Keep the original idle duration; never extend past the absolute cap.
      const idleMs = row.idleExpiresAt.getTime() - row.lastUsedAt.getTime();
      const idleExpiresAt = new Date(
        Math.min(now.getTime() + idleMs, row.absoluteExpiresAt.getTime()),
      );
      const nextToken = newRefreshToken();
      const next = await sessionsRepository.create(
        {
          userId: row.userId,
          familyId: row.familyId,
          tokenHash: hashToken(nextToken),
          deviceId: row.deviceId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          lastUsedAt: now,
          idleExpiresAt,
          absoluteExpiresAt: row.absoluteExpiresAt,
          mfaVerifiedAt: row.mfaVerifiedAt,
        },
        tx,
      );
      await sessionsRepository.markRotated(row.id, next.id, now, tx);
      toBlock = [row.id];
      return {
        ok: true,
        userId: row.userId,
        sessionId: next.id,
        refreshToken: nextToken,
        absoluteExpiresAt: row.absoluteExpiresAt,
        mfaVerifiedAt: row.mfaVerifiedAt,
      };
    });

    // The rotated (old) session's access tokens die too: its id is now history.
    await this.publishRevocations(toBlock);
    return result;
  }

  /** Revokes one session (DB + Redis). */
  async revokeSession(sessionId: string, reason: SessionRevokeReason): Promise<void> {
    await this.deps.sessionsRepository.revoke(sessionId, reason, new Date());
    await this.publishRevocations([sessionId]);
  }

  /** Revokes one of the caller's own sessions; 404 if it is not theirs or not live. */
  async revokeOwnSession(userId: string, sessionId: string): Promise<void> {
    const revoked = await this.deps.sessionsRepository.revoke(
      sessionId,
      'LOGOUT',
      new Date(),
      userId,
    );
    if (!revoked) throw new NotFoundError('Session');
    await this.publishRevocations([sessionId]);
  }

  /** Step 1 (DB). Returns the revoked ids; pass them to `publishRevocations` after commit. */
  revokeAllForUser(
    userId: string,
    reason: SessionRevokeReason,
    tx?: Tx,
    exceptSessionId?: string,
  ): Promise<string[]> {
    return this.deps.sessionsRepository.revokeAllForUser(
      userId,
      reason,
      new Date(),
      tx,
      exceptSessionId,
    );
  }

  /** Logout blacklist: the access token's jti is refused until it would have expired anyway. */
  async blacklistAccessToken(jti: string, expiresAtEpochSec: number): Promise<void> {
    const ttl = expiresAtEpochSec - Math.floor(Date.now() / 1000);
    if (ttl > 0) await this.deps.redis.set(authKeys.revokedJti(jti), '1', 'EX', ttl);
  }

  async listForUser(userId: string, currentSessionId?: string): Promise<SessionView[]> {
    const rows = await this.deps.sessionsRepository.listLive(userId, new Date());
    return rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      idleExpiresAt: row.idleExpiresAt.toISOString(),
      absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
      current: row.id === currentSessionId,
    }));
  }

  /**
   * Step 2 (Redis). Never throws: if Redis is down the DB revocation still stands and the
   * access tokens die within ACCESS_TOKEN_TTL_SECONDS. Returns false when flags were not written.
   */
  async publishRevocations(sessionIds: readonly string[]): Promise<boolean> {
    if (sessionIds.length === 0) return true;
    try {
      const pipeline = this.deps.redis.multi();
      for (const id of sessionIds) {
        pipeline.set(authKeys.revokedSid(id), '1', 'EX', ACCESS_TOKEN_TTL_SECONDS);
      }
      await pipeline.exec();
      return true;
    } catch (err) {
      this.deps.logger.error(
        { err, sessions: sessionIds.length },
        'failed to publish session revocations to redis; access tokens expire by TTL',
      );
      return false;
    }
  }
}
