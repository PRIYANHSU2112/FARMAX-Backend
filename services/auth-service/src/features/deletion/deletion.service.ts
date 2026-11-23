import { createHash, randomBytes } from 'node:crypto';

import {
  ConflictError,
  ForbiddenError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import { authKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { type AuditActor, SYSTEM_ACTOR_ID } from '../audit/index.js';

/** What the Delete Account screen lists under "You will lose if you delete your account". */
export const WHAT_YOU_LOSE = [
  'Order history, invoices and saved farms in the app',
  'Saved addresses, wishlists and preferences',
  'Unused wallet balance and reward points (use or withdraw them first)',
  'Membership benefits',
  'Open support tickets (closed automatically)',
] as const;

const RECOVERY_TTL_SECONDS = 600;
const PURGE_BATCH = 50;
const INVALID_CODE = 'Invalid or expired code';

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const mask = (phone: string) => phone.replace(/^(.{3}).*(.{4})$/, '$1******$2');

type Deps = Pick<
  Cradle,
  | 'config'
  | 'logger'
  | 'redis'
  | 'runInTransaction'
  | 'deletionRepository'
  | 'usersService'
  | 'sessionsService'
  | 'otpService'
  | 'smsSender'
  | 'auditService'
  | 'authService'
>;

/**
 * Self-service account deletion with a grace period (DPDP).
 *  request   step-up OTP → PENDING_DELETION + EVERY session revoked (access tokens blocked
 *            everywhere through the revoked-sid flags) → normal login refused (403
 *            ACCOUNT_PENDING_DELETION).
 *  recovery  OTP to the verified phone → single-use 10-minute recovery token (not a JWT, so it
 *            can never call any other route) → cancel → ACTIVE; the user then logs in normally.
 *  purge     after the grace period: credentials / MFA / devices deleted, profile anonymised,
 *            user.deleted.v1 → every service scrubs its copies.
 */
export class DeletionService {
  constructor(private readonly deps: Deps) {}

  async status(userId: string) {
    const pending = await this.deps.deletionRepository.findPending(userId);
    return {
      request: pending,
      graceDays: this.deps.config.ACCOUNT_DELETION_GRACE_DAYS,
      youWillLose: WHAT_YOU_LOSE,
    };
  }

  /** Step-up OTP to the account's verified phone. */
  async sendOtp(caller: AuthUser) {
    const phone = await this.phoneOf(caller);
    const sent = await this.deps.otpService.issue('account_delete', phone, (code) =>
      this.deps.smsSender.send(
        phone,
        `${code} confirms DELETING your FarmX account. Valid for 5 minutes. Ignore this if it was not you.`,
      ),
    );
    return { sent: true, destination: mask(phone), ...sent };
  }

  async request(caller: AuthUser, actor: AuditActor, input: { otp: string; reason?: string }) {
    const phone = await this.phoneOf(caller);
    if ((await this.deps.otpService.verify('account_delete', phone, input.otp)) !== 'ok')
      throw new UnauthorizedError(INVALID_CODE);
    const scheduledFor = new Date(
      Date.now() + this.deps.config.ACCOUNT_DELETION_GRACE_DAYS * 86_400_000,
    );
    const { request, revoked } = await this.deps.runInTransaction(async (tx) => {
      const user = await this.deps.usersService.findLive(caller.id, tx);
      if (user?.status !== 'ACTIVE')
        throw new ConflictError('This account cannot be deleted in its current state');
      const created = await this.deps.deletionRepository.createPending(
        tx,
        caller.id,
        input.reason ?? null,
        scheduledFor,
      );
      if (created === null)
        throw new ConflictError('Deletion is already scheduled', {
          details: { reason: 'DELETION_PENDING' },
        });
      await this.deps.usersService.setDeletionStatus(
        tx,
        caller.id,
        user.status,
        'PENDING_DELETION',
        'self-service deletion requested',
      );
      const sessions = await this.deps.sessionsService.revokeAllForUser(
        caller.id,
        'USER_SUSPENDED',
        tx,
      );
      await this.deps.auditService.record(
        {
          actor,
          action: 'user.deletion_requested',
          targetType: 'user',
          targetId: caller.id,
          subjectUserId: caller.id,
          reason: input.reason ?? null,
          metadata: { scheduledFor: scheduledFor.toISOString(), revokedSessions: sessions.length },
        },
        tx,
      );
      return { request: created, revoked: sessions };
    });
    // Blocks every already-issued access token in all services (revoked-sid flags in Redis).
    await this.deps.sessionsService.publishRevocations(revoked);
    return { request, graceDays: this.deps.config.ACCOUNT_DELETION_GRACE_DAYS };
  }

  /** Always answers the same (no account enumeration); an OTP goes out only for a pending account. */
  async recoveryOtp(phone: string) {
    const user = await this.deps.usersService.findByPhone(phone);
    if (user !== null && user.deletedAt === null && user.status === 'PENDING_DELETION') {
      try {
        await this.deps.otpService.issue('account_recovery', phone, (code) =>
          this.deps.smsSender.send(
            phone,
            `${code} restores your FarmX account. Valid for 5 minutes. Do not share it.`,
          ),
        );
      } catch (error) {
        if (!(error instanceof RateLimitError)) throw error; // a cooldown must look the same as "no account"
      }
    }
    return { sent: true };
  }

  async recoveryVerify(phone: string, code: string) {
    if ((await this.deps.otpService.verify('account_recovery', phone, code)) !== 'ok')
      throw new UnauthorizedError(INVALID_CODE);
    const user = await this.deps.usersService.findByPhone(phone);
    if (user?.deletedAt !== null || user.status !== 'PENDING_DELETION')
      throw new UnauthorizedError(INVALID_CODE);
    const token = randomBytes(32).toString('base64url');
    await this.deps.redis.set(
      authKeys.accountRecovery(tokenHash(token)),
      user.id,
      'EX',
      RECOVERY_TTL_SECONDS,
    );
    return { recoveryToken: token, expiresIn: RECOVERY_TTL_SECONDS };
  }

  /** Single use: the token is consumed atomically (GETDEL) before anything changes. */
  async cancel(
    recoveryToken: string,
    meta: { ip: string | null; userAgent: string | null; requestId: string },
  ) {
    const userId = await this.deps.redis.getdel(authKeys.accountRecovery(tokenHash(recoveryToken)));
    if (userId === null) throw new UnauthorizedError('Recovery token is invalid or expired');
    await this.deps.runInTransaction(async (tx) => {
      const pending = await this.deps.deletionRepository.lockPending(tx, userId);
      const user = await this.deps.usersService.findLive(userId, tx);
      if (pending === null || user?.status !== 'PENDING_DELETION')
        throw new ConflictError('No deletion is scheduled for this account');
      await this.deps.deletionRepository.finish(tx, pending.id, 'CANCELLED');
      await this.deps.usersService.setDeletionStatus(
        tx,
        userId,
        'PENDING_DELETION',
        'ACTIVE',
        'deletion cancelled by the user',
      );
      await this.deps.auditService.record(
        {
          actor: { userId, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId },
          action: 'user.deletion_cancelled',
          targetType: 'user',
          targetId: userId,
          subjectUserId: userId,
        },
        tx,
      );
    });
    return { restored: true };
  }

  /** Background purge of due requests (idempotent; SKIP LOCKED across replicas). */
  async purgeDue(): Promise<number> {
    let purged = 0;
    for (;;) {
      const done = await this.deps.runInTransaction(async (tx) => {
        const due = await this.deps.deletionRepository.lockDue(tx, new Date(), PURGE_BATCH);
        for (const row of due) {
          const user = await this.deps.usersService.findLive(row.userId, tx);
          if (user !== null && user.status === 'PENDING_DELETION') {
            await this.deps.authService.purgeUserData(row.userId, tx);
            await this.deps.sessionsService.revokeAllForUser(row.userId, 'USER_SUSPENDED', tx);
            await this.deps.usersService.anonymise(tx, row.userId);
            await this.deps.auditService.record(
              {
                actor: { userId: SYSTEM_ACTOR_ID },
                action: 'user.deletion_completed',
                targetType: 'user',
                targetId: row.userId,
                subjectUserId: row.userId,
              },
              tx,
            );
          }
          await this.deps.deletionRepository.finish(tx, row.id, 'COMPLETED');
        }
        return due.length;
      });
      purged += done;
      if (done < PURGE_BATCH) break;
    }
    if (purged > 0)
      this.deps.logger.info({ purged }, 'accounts purged after the deletion grace period');
    return purged;
  }

  private async phoneOf(caller: AuthUser): Promise<string> {
    if (caller.userType === 'INTERNAL')
      throw new ForbiddenError('Staff accounts are closed by an administrator');
    const user = await this.deps.usersService.findLive(caller.id);
    if (user === null) throw new UnauthorizedError();
    if (user.phone === null || user.phoneVerifiedAt === null)
      throw new ValidationError([
        { path: 'phone', message: 'Add and verify a phone number first' },
      ]);
    return user.phone;
  }
}
