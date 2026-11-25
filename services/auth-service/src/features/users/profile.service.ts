import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import type { Cradle } from '@fastify/awilix';

import { emitAuthEvent } from '../../adapters/events.js';
import type { AuditActor, JsonObject } from '../audit/index.js';
import type { UpdateUserData } from './users.repository.js';
import type { UpdateMeInput, UserRecord } from './users.types.js';

type Deps = Pick<
  Cradle,
  | 'usersRepository'
  | 'usersService'
  | 'otpService'
  | 'smsSender'
  | 'auditService'
  | 'runInTransaction'
>;

type ChangedField = 'fullName' | 'phone' | 'email' | 'avatarUrl';

const INVALID_CODE = 'Invalid or expired code';
const mask = (phone: string) => phone.replace(/^(.{3}).*(.{4})$/, '$1******$2');

/**
 * Self-service profile for CUSTOMER accounts (Contact screen + profile photo). Staff, vendor and
 * logistics identities are managed by an administrator. Every change is audited and emits
 * `user.profile_updated.v1` (outbox) so farm-service keeps its owner snapshot in sync.
 *
 * Phone change: the code goes to the NEW number (proves the user holds it) and is bound to this
 * user (OTP destination = userId + phone), so nobody else can redeem it.
 */
export class ProfileService {
  constructor(private readonly deps: Deps) {}

  async updateMe(caller: AuthUser, input: UpdateMeInput, actor: AuditActor) {
    const current = await this.requireCustomer(caller);
    const email = input.email?.trim().toLowerCase();
    const desired: Partial<Record<'fullName' | 'email' | 'avatarUrl', string | null>> = {
      ...(input.fullName === undefined ? {} : { fullName: input.fullName }),
      ...(email === undefined ? {} : { email }),
      ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
    };
    const data: UpdateUserData = {};
    const before: JsonObject = {};
    const after: JsonObject = {};
    const changed: ChangedField[] = [];
    for (const [field, next] of Object.entries(desired) as [ChangedField, string | null][]) {
      if (next === current[field as keyof UserRecord]) continue;
      before[field] = current[field as keyof UserRecord] as string | null;
      after[field] = next;
      changed.push(field);
      Object.assign(data, { [field]: next });
    }
    if (changed.length === 0) return this.deps.usersService.getMe(caller.id);
    if (data.email !== undefined) {
      // Same 409 the unique index would give, with a clear message (and no race: the index wins).
      const owner = await this.deps.usersRepository.findLoginUser({ email: email ?? '' });
      if (owner !== null && owner.id !== caller.id)
        throw new ConflictError('This email is already used by another account', {
          details: { reason: 'EMAIL_TAKEN' },
        });
      data.emailVerifiedAt = null;
    }
    await this.save(current, data, { before, after, changed }, actor);
    return this.deps.usersService.getMe(caller.id);
  }

  /** "Update" next to the mobile number: OTP to the NEW number. */
  async sendPhoneOtp(caller: AuthUser, phone: string) {
    const current = await this.requireCustomer(caller);
    if (current.phone === phone)
      throw new ValidationError([{ path: 'phone', message: 'This is already your number' }]);
    await this.assertPhoneFree(caller.id, phone);
    const sent = await this.deps.otpService.issue('phone_change', `${caller.id}|${phone}`, (code) =>
      this.deps.smsSender.send(
        phone,
        `${code} is your FarmX code to make this your login number. Valid for 5 minutes. Do not share it.`,
      ),
    );
    return { sent: true, destination: mask(phone), ...sent };
  }

  /** "Verify": the new number becomes the verified login phone. */
  async verifyPhone(caller: AuthUser, phone: string, otp: string, actor: AuditActor) {
    const current = await this.requireCustomer(caller);
    const outcome = await this.deps.otpService.verify('phone_change', `${caller.id}|${phone}`, otp);
    if (outcome !== 'ok') throw new UnauthorizedError(INVALID_CODE);
    await this.assertPhoneFree(caller.id, phone);
    await this.save(
      current,
      { phone, phoneVerifiedAt: new Date() },
      { before: { phone: current.phone }, after: { phone }, changed: ['phone'] },
      actor,
    );
    return this.deps.usersService.getMe(caller.id);
  }

  private async save(
    current: UserRecord,
    data: UpdateUserData,
    diff: { before: JsonObject; after: JsonObject; changed: ChangedField[] },
    actor: AuditActor,
  ): Promise<void> {
    await this.deps.runInTransaction(async (tx) => {
      const updated = await this.deps.usersRepository.update(current.id, data, tx);
      await this.deps.auditService.record(
        {
          actor,
          action: 'user.profile_updated',
          targetType: 'user',
          targetId: current.id,
          subjectUserId: current.id,
          before: diff.before,
          after: diff.after,
          reason: null,
        },
        tx,
      );
      await emitAuthEvent(
        tx,
        'user.profile_updated.v1',
        {
          userId: updated.id,
          userType: updated.userType,
          fullName: updated.fullName,
          phone: updated.phone,
          email: updated.email,
          changedFields: diff.changed,
        },
        actor.requestId ?? current.id,
      );
    });
  }

  private async assertPhoneFree(userId: string, phone: string): Promise<void> {
    const owner = await this.deps.usersRepository.findLoginUser({ phone });
    if (owner !== null && owner.id !== userId)
      throw new ConflictError('This number is already registered with another account', {
        details: { reason: 'PHONE_TAKEN' },
      });
  }

  private async requireCustomer(caller: AuthUser): Promise<UserRecord> {
    if (caller.userType !== 'CUSTOMER')
      throw new ForbiddenError('Only customer accounts edit their own profile here');
    const user = await this.deps.usersService.findLive(caller.id);
    if (user === null) throw new NotFoundError('User');
    return user;
  }
}
