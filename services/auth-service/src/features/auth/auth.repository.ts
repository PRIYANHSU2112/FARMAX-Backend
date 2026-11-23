import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { AuthEventType, DevicePlatform } from './auth.types.js';

export interface CredentialRow {
  passwordHash: string;
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export interface TotpFactorRow {
  id: string;
  secretEncrypted: string | null;
  verifiedAt: Date | null;
}

export interface AuthEventInput {
  type: AuthEventType;
  success: boolean;
  userId?: string | null;
  identifier?: string | null;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
  sessionId?: string | null;
  metadata?: Prisma.InputJsonObject;
}

/** The only code that touches credentials, password history, MFA, devices and auth_events. */
export class AuthRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Account purge (deletion feature): every secret and device of the user, in the caller's tx. */
  async purgeUser(userId: string, tx: Tx): Promise<void> {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaFactor.deleteMany({ where: { userId } });
    await tx.passwordHistory.deleteMany({ where: { userId } });
    await tx.credential.deleteMany({ where: { userId } });
    await tx.userDevice.deleteMany({ where: { userId } });
  }

  // ── Credentials ──────────────────────────────────────────────────────────────────────────

  /** Creates the user's credential and its first password-history row. */
  async createCredential(userId: string, passwordHash: string, tx?: Tx): Promise<void> {
    const db = tx ?? this.db;
    await withPrismaErrors(async () => {
      await db.credential.create({ data: { userId, passwordHash } });
      await db.passwordHistory.create({ data: { userId, passwordHash } });
    });
  }

  async findCredential(userId: string): Promise<CredentialRow | null> {
    return withPrismaErrors(() =>
      this.db.credential.findUnique({
        where: { userId },
        select: { passwordHash: true, failedLoginCount: true, lockedUntil: true },
      }),
    );
  }

  /** Atomic +1; locks when the threshold is reached. Returns the lock end, if now locked. */
  async registerFailedLogin(
    userId: string,
    now: Date,
    threshold: number,
    lockMinutes: number,
  ): Promise<Date | null> {
    return withPrismaErrors(async () => {
      const row = await this.db.credential.update({
        where: { userId },
        data: { failedLoginCount: { increment: 1 }, lastFailedAt: now },
        select: { failedLoginCount: true },
      });
      if (row.failedLoginCount < threshold) return null;
      const lockedUntil = new Date(now.getTime() + lockMinutes * 60_000);
      await this.db.credential.update({
        where: { userId },
        data: { lockedUntil, failedLoginCount: 0 },
      });
      return lockedUntil;
    });
  }

  async clearFailedLogins(userId: string): Promise<void> {
    await withPrismaErrors(() =>
      this.db.credential.updateMany({
        where: { userId, OR: [{ failedLoginCount: { gt: 0 } }, { lockedUntil: { not: null } }] },
        data: { failedLoginCount: 0, lockedUntil: null },
      }),
    );
  }

  /** Replaces the password (and clears any lockout) + appends to history. */
  /** First password of an invited account (or a replacement): credential upsert + history. */
  async upsertPassword(userId: string, passwordHash: string, tx: Tx): Promise<void> {
    await withPrismaErrors(async () => {
      await tx.credential.upsert({
        where: { userId },
        create: { userId, passwordHash },
        update: {
          passwordHash,
          passwordUpdatedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await tx.passwordHistory.create({ data: { userId, passwordHash } });
    });
  }

  async setPassword(userId: string, passwordHash: string, tx: Tx): Promise<void> {
    await withPrismaErrors(async () => {
      await tx.credential.update({
        where: { userId },
        data: {
          passwordHash,
          passwordUpdatedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await tx.passwordHistory.create({ data: { userId, passwordHash } });
    });
  }

  async recentPasswordHashes(userId: string, count: number): Promise<string[]> {
    const rows = await withPrismaErrors(() =>
      this.db.passwordHistory.findMany({
        where: { userId },
        select: { passwordHash: true },
        orderBy: { createdAt: 'desc' },
        take: count,
      }),
    );
    return rows.map((row) => row.passwordHash);
  }

  // ── MFA ──────────────────────────────────────────────────────────────────────────────────

  /** The user's TOTP factor that is not disabled (verified or pending enrolment). */
  async findTotpFactor(userId: string): Promise<TotpFactorRow | null> {
    return withPrismaErrors(() =>
      this.db.mfaFactor.findFirst({
        where: { userId, type: 'TOTP', disabledAt: null },
        select: { id: true, secretEncrypted: true, verifiedAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /** Starts (or restarts) enrolment: disables any unverified factor, creates a pending one. */
  async createPendingTotp(userId: string, secretEncrypted: string): Promise<void> {
    await withPrismaErrors(() =>
      this.db.$transaction([
        this.db.mfaFactor.updateMany({
          where: { userId, type: 'TOTP', verifiedAt: null, disabledAt: null },
          data: { disabledAt: new Date() },
        }),
        this.db.mfaFactor.create({
          data: { userId, type: 'TOTP', secretEncrypted, label: 'Authenticator app' },
        }),
      ]),
    );
  }

  /** Marks the factor verified and replaces the recovery codes (one transaction). */
  async confirmTotp(
    factorId: string,
    userId: string,
    recoveryCodeHashes: readonly string[],
  ): Promise<void> {
    const now = new Date();
    await withPrismaErrors(() =>
      this.db.$transaction([
        this.db.mfaFactor.update({
          where: { id: factorId },
          data: { verifiedAt: now, lastUsedAt: now },
        }),
        this.db.mfaRecoveryCode.deleteMany({ where: { userId } }),
        this.db.mfaRecoveryCode.createMany({
          data: recoveryCodeHashes.map((codeHash) => ({ userId, codeHash })),
        }),
      ]),
    );
  }

  async disableTotp(userId: string): Promise<void> {
    const now = new Date();
    await withPrismaErrors(() =>
      this.db.$transaction([
        this.db.mfaFactor.updateMany({
          where: { userId, type: 'TOTP', disabledAt: null },
          data: { disabledAt: now },
        }),
        this.db.mfaRecoveryCode.deleteMany({ where: { userId } }),
      ]),
    );
  }

  async touchFactor(factorId: string): Promise<void> {
    await withPrismaErrors(() =>
      this.db.mfaFactor.update({ where: { id: factorId }, data: { lastUsedAt: new Date() } }),
    );
  }

  /** Single use: true only for the first caller with a matching, unused code. */
  async consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const result = await withPrismaErrors(() =>
      this.db.mfaRecoveryCode.updateMany({
        where: { userId, codeHash, usedAt: null },
        data: { usedAt: new Date() },
      }),
    );
    return result.count === 1;
  }

  // ── Devices ──────────────────────────────────────────────────────────────────────────────

  /** Registers or refreshes a device seen at login. Returns its id, status and whether it is new. */
  async upsertDevice(input: {
    userId: string;
    deviceHash: string;
    platform: DevicePlatform;
    name: string | null;
    ip: string | null;
  }): Promise<{ id: string; status: string; isNew: boolean }> {
    const now = new Date();
    return withPrismaErrors(async () => {
      const existing = await this.db.userDevice.findUnique({
        where: { userId_deviceHash: { userId: input.userId, deviceHash: input.deviceHash } },
        select: { id: true, status: true },
      });
      if (existing !== null) {
        await this.db.userDevice.update({
          where: { id: existing.id },
          data: {
            lastSeenAt: now,
            lastLoginAt: now,
            lastIp: input.ip,
            loginCount: { increment: 1 },
          },
        });
        return { ...existing, isNew: false };
      }
      const created = await this.db.userDevice.create({
        data: {
          userId: input.userId,
          deviceHash: input.deviceHash,
          platform: input.platform,
          name: input.name,
          firstIp: input.ip,
          lastIp: input.ip,
          lastLoginAt: now,
          loginCount: 1,
        },
        select: { id: true, status: true },
      });
      return { ...created, isNew: true };
    });
  }

  // ── Auth events (append-only) ────────────────────────────────────────────────────────────

  async recordEvent(event: AuthEventInput): Promise<void> {
    await withPrismaErrors(() =>
      this.db.authEvent.create({
        data: {
          type: event.type,
          success: event.success,
          userId: event.userId ?? null,
          identifier: event.identifier ?? null,
          reason: event.reason ?? null,
          ip: event.ip ?? null,
          userAgent: event.userAgent ?? null,
          deviceId: event.deviceId ?? null,
          sessionId: event.sessionId ?? null,
          ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
        },
        select: { id: true },
      }),
    );
  }
}
