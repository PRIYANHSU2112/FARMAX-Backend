import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { SessionLockRow, SessionRevokeReason } from './sessions.types.js';

const viewSelect = {
  id: true,
  deviceId: true,
  ip: true,
  userAgent: true,
  createdAt: true,
  lastUsedAt: true,
  idleExpiresAt: true,
  absoluteExpiresAt: true,
} as const;

export interface NewSessionRow {
  userId: string;
  familyId: string;
  tokenHash: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  lastUsedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  mfaVerifiedAt: Date | null;
}

/** The only code that touches `sessions`. */
export class SessionsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async create(data: NewSessionRow, tx?: Tx): Promise<{ id: string }> {
    const db = tx ?? this.db;
    return withPrismaErrors(() => db.session.create({ data, select: { id: true } }));
  }

  /** Locks the session row for the rest of the transaction (concurrent refreshes serialise). */
  async lockByTokenHash(tokenHash: string, tx: Tx): Promise<SessionLockRow | null> {
    const rows = await withPrismaErrors(
      () => tx.$queryRaw<SessionLockRow[]>`
        SELECT "id", "userId", "familyId", "deviceId", "rotatedAt", "revokedAt", "lastUsedAt",
               "idleExpiresAt", "absoluteExpiresAt", "mfaVerifiedAt"
        FROM "sessions" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`,
    );
    return rows[0] ?? null;
  }

  async markRotated(id: string, replacedById: string, now: Date, tx: Tx): Promise<void> {
    await withPrismaErrors(() =>
      tx.session.update({ where: { id }, data: { rotatedAt: now, replacedById, lastUsedAt: now } }),
    );
  }

  /** Revokes every live session of a family (refresh-token theft); returns their ids. */
  async revokeFamily(
    familyId: string,
    reason: SessionRevokeReason,
    now: Date,
    tx: Tx,
  ): Promise<string[]> {
    return withPrismaErrors(async () => {
      const live = await tx.session.findMany({
        where: { familyId, revokedAt: null },
        select: { id: true },
      });
      const ids = live.map((row) => row.id);
      if (ids.length > 0) {
        await tx.session.updateMany({
          where: { id: { in: ids } },
          data: { revokedAt: now, revokeReason: reason },
        });
      }
      return ids;
    });
  }

  /** Revokes one live session; returns false if it was not live (or not the user's). */
  async revoke(
    id: string,
    reason: SessionRevokeReason,
    now: Date,
    ownerUserId?: string,
    tx?: Tx,
  ): Promise<boolean> {
    const db = tx ?? this.db;
    const result = await withPrismaErrors(() =>
      db.session.updateMany({
        where: {
          id,
          revokedAt: null,
          ...(ownerUserId === undefined ? {} : { userId: ownerUserId }),
        },
        data: { revokedAt: now, revokeReason: reason },
      }),
    );
    return result.count > 0;
  }

  /** Revokes every live session of a user (optionally keeping one); returns their ids. */
  async revokeAllForUser(
    userId: string,
    reason: SessionRevokeReason,
    now: Date,
    tx?: Tx,
    exceptSessionId?: string,
  ): Promise<string[]> {
    const db = tx ?? this.db;
    return withPrismaErrors(async () => {
      const live = await db.session.findMany({
        where: {
          userId,
          revokedAt: null,
          absoluteExpiresAt: { gt: now },
          ...(exceptSessionId === undefined ? {} : { id: { not: exceptSessionId } }),
        },
        select: { id: true },
      });
      const ids = live.map((session) => session.id);
      if (ids.length > 0) {
        await db.session.updateMany({
          where: { id: { in: ids }, revokedAt: null },
          data: { revokedAt: now, revokeReason: reason },
        });
      }
      return ids;
    });
  }

  /**
   * Live sessions of a user, most recent first. Rotated rows are history (their successor is the
   * live one), so only un-rotated, un-revoked, unexpired rows are listed. Bounded (≤ 100).
   */
  async listLive(userId: string, now: Date) {
    return withPrismaErrors(() =>
      this.db.session.findMany({
        where: {
          userId,
          revokedAt: null,
          rotatedAt: null,
          idleExpiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
        select: viewSelect,
        orderBy: { lastUsedAt: 'desc' },
        take: 100,
      }),
    );
  }
}
