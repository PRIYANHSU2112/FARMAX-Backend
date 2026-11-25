import type { AuthUser } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';
import { describe, expect, it, vi } from 'vitest';

import type { AuditActor } from '../../src/features/audit/index.js';
import { ProfileService } from '../../src/features/users/profile.service.js';
import type { UserRecord } from '../../src/features/users/users.types.js';

const ME = '01900000-0000-7000-8000-000000000010';
const OTHER = '01900000-0000-7000-8000-000000000011';
const actor: AuditActor = { userId: ME, ip: '127.0.0.1', userAgent: 'test', requestId: 'req-1' };

const caller = (userType: AuthUser['userType'] = 'CUSTOMER'): AuthUser =>
  ({
    id: ME,
    sessionId: 's-1',
    jti: 'j-1',
    userType,
    roles: [],
    scope: 'full',
    expiresAt: 0,
  }) as unknown as AuthUser;

const me = (overrides: Partial<UserRecord> = {}): UserRecord => ({
  id: ME,
  userType: 'CUSTOMER',
  email: null,
  emailVerifiedAt: null,
  phone: '+919849021746',
  phoneVerifiedAt: new Date('2026-01-01'),
  username: null,
  fullName: '',
  displayName: null,
  avatarUrl: null,
  employeeCode: null,
  preferredLanguage: 'en',
  timezone: 'Asia/Kolkata',
  status: 'ACTIVE',
  statusReason: null,
  statusChangedAt: null,
  mfaRequired: false,
  mustChangePassword: false,
  lastLoginAt: null,
  createdByUserId: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
  ...overrides,
});

function setup(options: { user?: UserRecord; taken?: { email?: string; phone?: string } } = {}) {
  let user = options.user ?? me();
  const outbox: { type: string; payload: { data: Record<string, unknown> } }[] = [];
  const tx = {
    outboxEvent: {
      create: vi.fn(
        (args: { data: { type: string; payload: { data: Record<string, unknown> } } }) => {
          outbox.push(args.data);
          return Promise.resolve();
        },
      ),
    },
  } as unknown as Tx;
  const usersRepository = {
    update: vi.fn((_id: string, data: Partial<UserRecord>) => {
      user = { ...user, ...data };
      return Promise.resolve(user);
    }),
    findLoginUser: vi.fn((where: { email?: string; phone?: string }) =>
      Promise.resolve(
        (where.email !== undefined && where.email === options.taken?.email) ||
          (where.phone !== undefined && where.phone === options.taken?.phone)
          ? { id: OTHER }
          : null,
      ),
    ),
  };
  const usersService = {
    findLive: vi.fn(() => Promise.resolve(user)),
    getMe: vi.fn(() => Promise.resolve({ ...user })),
  };
  const otpService = {
    issue: vi.fn((_p: string, _d: string, deliver: (code: string) => Promise<void>) =>
      deliver('123456').then(() => ({ expiresIn: 300, resendAfter: 30 })),
    ),
    verify: vi.fn((_p: string, _d: string, code: string) =>
      Promise.resolve(code === '123456' ? 'ok' : 'invalid'),
    ),
  };
  const smsSender = { send: vi.fn(() => Promise.resolve()) };
  const auditService = { record: vi.fn(() => Promise.resolve()) };
  const service = new ProfileService({
    usersRepository,
    usersService,
    otpService,
    smsSender,
    auditService,
    runInTransaction: (work: (t: Tx) => Promise<unknown>) => work(tx),
  } as unknown as ConstructorParameters<typeof ProfileService>[0] & Partial<Cradle>);
  return { service, usersRepository, otpService, smsSender, auditService, outbox };
}

describe('ProfileService.updateMe (Contact screen)', () => {
  it('refuses non-customer accounts', async () => {
    const { service } = setup();
    await expect(service.updateMe(caller('INTERNAL'), { fullName: 'X Y' }, actor)).rejects.toThrow(
      /Only customer accounts/,
    );
  });

  it('saves name + email, unverifies the new email, audits and emits user.profile_updated.v1', async () => {
    const { service, usersRepository, auditService, outbox } = setup();
    await service.updateMe(
      caller(),
      { fullName: 'Venkatesh Ramana', email: 'Venkata.Ramana@Email.com' },
      actor,
    );
    expect(usersRepository.update).toHaveBeenCalledWith(
      ME,
      { fullName: 'Venkatesh Ramana', email: 'venkata.ramana@email.com', emailVerifiedAt: null },
      expect.anything(),
    );
    expect(auditService.record).toHaveBeenCalledOnce();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.type).toBe('user.profile_updated.v1');
    expect(outbox[0]?.payload.data).toMatchObject({
      userId: ME,
      fullName: 'Venkatesh Ramana',
      phone: '+919849021746',
      changedFields: ['fullName', 'email'],
    });
  });

  it('writes nothing when nothing changed', async () => {
    const { service, usersRepository, outbox } = setup({ user: me({ fullName: 'Ravi' }) });
    await service.updateMe(caller(), { fullName: 'Ravi' }, actor);
    expect(usersRepository.update).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
  });

  it('409 EMAIL_TAKEN when another account uses the email', async () => {
    const { service } = setup({ taken: { email: 'a@b.in' } });
    await expect(service.updateMe(caller(), { email: 'a@b.in' }, actor)).rejects.toMatchObject({
      details: { reason: 'EMAIL_TAKEN' },
    });
  });
});

describe('ProfileService phone change (OTP to the new number)', () => {
  it('422 when the number is already yours', async () => {
    const { service } = setup();
    await expect(service.sendPhoneOtp(caller(), '+919849021746')).rejects.toMatchObject({
      details: { issues: [{ path: 'phone', message: 'This is already your number' }] },
    });
  });

  it('409 PHONE_TAKEN when another account has it', async () => {
    const { service, otpService } = setup({ taken: { phone: '+919876543210' } });
    await expect(service.sendPhoneOtp(caller(), '+919876543210')).rejects.toMatchObject({
      details: { reason: 'PHONE_TAKEN' },
    });
    expect(otpService.issue).not.toHaveBeenCalled();
  });

  it('binds the code to this user + number and texts the new number', async () => {
    const { service, otpService, smsSender } = setup();
    const result = await service.sendPhoneOtp(caller(), '+919876543210');
    expect(otpService.issue).toHaveBeenCalledWith(
      'phone_change',
      `${ME}|+919876543210`,
      expect.any(Function),
    );
    expect(smsSender.send).toHaveBeenCalledWith('+919876543210', expect.stringContaining('123456'));
    expect(result).toMatchObject({ sent: true, destination: '+91******3210' });
  });

  it('wrong code → 401, nothing written', async () => {
    const { service, usersRepository } = setup();
    await expect(service.verifyPhone(caller(), '+919876543210', '000000', actor)).rejects.toThrow(
      /Invalid or expired/,
    );
    expect(usersRepository.update).not.toHaveBeenCalled();
  });

  it('right code → verified new phone + event', async () => {
    const { service, usersRepository, outbox } = setup();
    await service.verifyPhone(caller(), '+919876543210', '123456', actor);
    const [, data] = usersRepository.update.mock.calls[0] ?? [];
    expect(data?.phone).toBe('+919876543210');
    expect(data?.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(outbox[0]?.payload.data).toMatchObject({
      phone: '+919876543210',
      changedFields: ['phone'],
    });
  });
});
