import type { AuthUser, SessionId, UserId } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import { describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../src/features/auth/auth.service.js';
import type { LoginUserRecord } from '../../src/features/users/index.js';

const meta = { ip: '203.0.113.10', userAgent: 'test' };
const admin: LoginUserRecord = {
  id: 'u-admin',
  userType: 'INTERNAL',
  status: 'ACTIVE',
  deletedAt: null,
  mfaRequired: false,
  mustChangePassword: false,
  email: 'ravi@farmx.in',
  phone: null,
  username: null,
  fullName: 'Ravi',
};
const customer: LoginUserRecord = {
  ...admin,
  id: 'u-cust',
  userType: 'CUSTOMER',
  phone: '+919876543210',
  email: null,
};

function setup(
  overrides: {
    user?: LoginUserRecord | null;
    created?: boolean;
    hasTotp?: boolean;
    roleMfa?: boolean;
    mfaEnforced?: boolean;
  } = {},
) {
  const events: { type: string; success: boolean }[] = [];
  const user = overrides.user === undefined ? admin : overrides.user;
  const deps = {
    config: {
      CUSTOMER_SESSION_IDLE_DAYS: 30,
      CUSTOMER_SESSION_MAX_DAYS: 90,
      ADMIN_SESSION_IDLE_MINUTES: 30,
      ADMIN_SESSION_MAX_HOURS: 12,
      MFA_ENFORCED: overrides.mfaEnforced ?? false,
    },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    authRepository: {
      recordEvent: vi.fn((e: { type: string; success: boolean }) => {
        events.push(e);
        return Promise.resolve();
      }),
      upsertDevice: vi.fn(() => Promise.resolve({ id: 'd1', status: 'TRUSTED', isNew: false })),
    },
    credentialsService: {
      verifyPassword: vi.fn((id: string | null) =>
        Promise.resolve(id === null ? { ok: false, reason: 'bad_password' } : { ok: true }),
      ),
    },
    otpService: {
      issue: vi.fn(() => Promise.resolve({ expiresIn: 300, resendAfter: 30 })),
      verify: vi.fn(() => Promise.resolve('ok')),
    },
    mfaService: {
      hasActiveTotp: vi.fn(() => Promise.resolve(overrides.hasTotp ?? false)),
      createChallenge: vi.fn(() => Promise.resolve('challenge-id')),
    },
    usersService: {
      findLoginUser: vi.fn(() => Promise.resolve(user)),
      findLoginUserById: vi.fn(() => Promise.resolve(user)),
      findOrCreateByVerifiedPhone: vi.fn(() =>
        Promise.resolve({ user: user ?? customer, created: overrides.created ?? false }),
      ),
      recordLogin: vi.fn(() => Promise.resolve()),
    },
    accessService: {
      getUserAccess: vi.fn(() =>
        Promise.resolve({
          roles: ['super_admin'],
          permissions: [],
          mfaRequired: overrides.roleMfa ?? false,
          sessionIdleMinutes: 15,
        }),
      ),
    },
    sessionsService: {
      createSession: vi.fn(() =>
        Promise.resolve({
          sessionId: 's1',
          refreshToken: 'r'.repeat(43),
          absoluteExpiresAt: new Date(),
        }),
      ),
      rotate: vi.fn(),
      revokeSession: vi.fn(() => Promise.resolve()),
      revokeAllForUser: vi.fn(() => Promise.resolve(['s1', 's2'])),
      publishRevocations: vi.fn(() => Promise.resolve(true)),
      blacklistAccessToken: vi.fn(() => Promise.resolve()),
    },
    tokensService: {
      issueAccessToken: vi.fn((input: { scope: string }) => ({
        accessToken: `jwt-${input.scope}`,
        jti: 'j1',
        expiresAt: 1,
        expiresIn: 900,
      })),
    },
    smsSender: { send: vi.fn(() => Promise.resolve()) },
    emailSender: { send: vi.fn(() => Promise.resolve()) },
    runInTransaction: <T>(work: (t: Tx) => Promise<T>) => work({} as Tx),
  };
  const service = new AuthService(deps as unknown as ConstructorParameters<typeof AuthService>[0]);
  return { service, deps, events };
}

describe('customer OTP login', () => {
  it('a new number creates a customer session with isNewUser', async () => {
    const t = setup({ user: customer, created: true });
    const tokens = await t.service.verifyLoginOtp('+919876543210', '123456', meta);
    expect(tokens).toMatchObject({
      status: 'authenticated',
      isNewUser: true,
      accessToken: 'jwt-full',
    });
    // Customer sessions: 30-day idle, 90-day absolute.
    expect(t.deps.sessionsService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ idleSeconds: 30 * 86_400, absoluteSeconds: 90 * 86_400 }),
    );
  });

  it('a wrong code → 401 and an OTP_FAILED event, no user lookup', async () => {
    const t = setup({ user: customer });
    t.deps.otpService.verify.mockResolvedValueOnce('invalid');
    await expect(t.service.verifyLoginOtp('+919876543210', '000000', meta)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(t.events.map((e) => e.type)).toEqual(['OTP_FAILED']);
    expect(t.deps.usersService.findOrCreateByVerifiedPhone).not.toHaveBeenCalled();
  });

  it('staff cannot log in with an OTP alone (403)', async () => {
    const t = setup({ user: admin });
    await expect(t.service.verifyLoginOtp('+919876543210', '123456', meta)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('admin login', () => {
  it('unknown identifier → generic 401 (a dummy hash is still verified)', async () => {
    const t = setup({ user: null });
    await expect(t.service.adminLogin('ghost@farmx.in', 'x', meta)).rejects.toMatchObject({
      statusCode: 401,
      message: 'Invalid credentials',
    });
    expect(t.deps.credentialsService.verifyPassword).toHaveBeenCalledWith(null, 'x');
  });

  it('customer accounts cannot use the admin login', async () => {
    const t = setup({ user: customer });
    await expect(t.service.adminLogin('+919876543210', 'x', meta)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(t.deps.credentialsService.verifyPassword).toHaveBeenCalledWith(null, 'x');
  });

  it('a locked account → 403 and ACCOUNT_LOCKED', async () => {
    const t = setup();
    t.deps.credentialsService.verifyPassword.mockResolvedValueOnce({ ok: false, reason: 'locked' });
    await expect(t.service.adminLogin('ravi@farmx.in', 'x', meta)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(t.events[0]?.type).toBe('ACCOUNT_LOCKED');
  });

  it('with an authenticator → mfa_required challenge, no session yet', async () => {
    const t = setup({ hasTotp: true });
    await expect(t.service.adminLogin('ravi@farmx.in', 'pw', meta)).resolves.toMatchObject({
      status: 'mfa_required',
      challengeId: 'challenge-id',
    });
    expect(t.deps.sessionsService.createSession).not.toHaveBeenCalled();
  });

  it('MFA opt-in (default): flagged account without an authenticator → full session', async () => {
    const t = setup({ roleMfa: true });
    await expect(t.service.adminLogin('ravi@farmx.in', 'pw', meta)).resolves.toMatchObject({
      status: 'authenticated',
      accessToken: 'jwt-full',
    });
  });

  it('MFA_ENFORCED + flagged but not enrolled → enrolment-only token, no refresh token', async () => {
    const t = setup({ roleMfa: true, mfaEnforced: true });
    const result = await t.service.adminLogin('ravi@farmx.in', 'pw', meta);
    expect(result).toMatchObject({
      status: 'mfa_enrollment_required',
      accessToken: 'jwt-mfa_enroll',
    });
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('no MFA → tokens; idle timeout = shortest role idle (15 min)', async () => {
    const t = setup();
    await expect(t.service.adminLogin('ravi@farmx.in', 'pw', meta)).resolves.toMatchObject({
      status: 'authenticated',
    });
    expect(t.deps.sessionsService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ idleSeconds: 15 * 60, absoluteSeconds: 12 * 3600 }),
    );
  });
});

describe('refresh / logout / forgot password', () => {
  it('refresh-token reuse → 401 and TOKEN_REUSE_DETECTED', async () => {
    const t = setup();
    t.deps.sessionsService.rotate.mockResolvedValueOnce({
      ok: false,
      reason: 'reused',
      userId: 'u-admin',
      sessionId: 's0',
    });
    await expect(t.service.refresh('x'.repeat(43), meta)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(t.events.map((e) => e.type)).toContain('TOKEN_REUSE_DETECTED');
  });

  it('logout blacklists the access token and revokes the session', async () => {
    const t = setup();
    const caller = {
      id: 'u-admin' as UserId,
      sessionId: 's1' as SessionId,
      jti: 'j1',
      userType: 'INTERNAL',
      roles: [],
      scope: 'full',
      expiresAt: 9,
    } as AuthUser;
    await t.service.logout(caller, meta);
    expect(t.deps.sessionsService.blacklistAccessToken).toHaveBeenCalledWith('j1', 9);
    expect(t.deps.sessionsService.revokeSession).toHaveBeenCalledWith('s1', 'LOGOUT');
  });

  it('forgot password: identical response for unknown accounts, and no code is sent', async () => {
    const t = setup({ user: null });
    await expect(t.service.forgotPassword('ghost', meta)).resolves.toEqual({ sent: true });
    expect(t.deps.otpService.issue).not.toHaveBeenCalled();
  });
});
