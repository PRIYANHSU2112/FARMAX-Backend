import { createHash } from 'node:crypto';

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import type { Cradle } from '@fastify/awilix';

import type { LoginUserRecord } from '../users/index.js';
import type { AuthEventInput } from './auth.repository.js';
import {
  type AdminLoginResult,
  type AuthTokens,
  type AuthUserSummary,
  MFA_CHALLENGE_TTL_SECONDS,
  type MfaEnrollmentResponse,
  type OtpSendResult,
  type RequestMeta,
  type TotpConfirmResult,
  type TotpEnrollment,
} from './auth.types.js';

type Deps = Pick<
  Cradle,
  | 'config'
  | 'logger'
  | 'authRepository'
  | 'credentialsService'
  | 'otpService'
  | 'mfaService'
  | 'usersService'
  | 'accessService'
  | 'sessionsService'
  | 'tokensService'
  | 'smsSender'
  | 'emailSender'
  | 'runInTransaction'
>;

/** Generic messages: never reveal whether an account exists or which factor failed. */
const INVALID_CREDENTIALS = 'Invalid credentials';
const INVALID_CODE = 'Invalid or expired code';
const INVALID_REFRESH = 'Invalid or expired refresh token';
const PASSWORD_LOGIN_TYPES = new Set(['INTERNAL', 'VENDOR']);
const ENROLMENT_SESSION_SECONDS = 15 * 60;

const mask = (identifier: string): string =>
  identifier.includes('@')
    ? identifier.replace(/^(.).*(@.*)$/, '$1***$2')
    : identifier.replace(/^(.{3}).*(.{4})$/, '$1******$2');

const isUsable = (user: LoginUserRecord): boolean =>
  user.deletedAt === null && user.status === 'ACTIVE';

/**
 * Public API of the auth feature: customer OTP login, admin password + TOTP MFA login, refresh
 * rotation, logout, password reset/change and MFA enrolment. Every step writes an auth event.
 */
export class AuthService {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  // ── Customer: mobile + OTP ───────────────────────────────────────────────────────────────

  /** Always the same response (no account enumeration). Rate limits run in the route. */
  async sendLoginOtp(phone: string, meta: RequestMeta): Promise<OtpSendResult> {
    const result = await this.deps.otpService.issue('login', phone, (code) =>
      this.deps.smsSender.send(
        phone,
        `${code} is your FarmX login code. Valid for 5 minutes. Do not share it.`,
      ),
    );
    await this.event({
      type: 'OTP_SENT',
      success: true,
      identifier: mask(phone),
      ...this.metaOf(meta),
      metadata: { purpose: 'login' },
    });
    return { sent: true, ...result };
  }

  async verifyLoginOtp(phone: string, code: string, meta: RequestMeta): Promise<AuthTokens> {
    const outcome = await this.deps.otpService.verify('login', phone, code);
    if (outcome !== 'ok') {
      await this.event({
        type: 'OTP_FAILED',
        success: false,
        identifier: mask(phone),
        reason: outcome,
        ...this.metaOf(meta),
      });
      throw new UnauthorizedError(INVALID_CODE);
    }
    const { user, created } = await this.deps.usersService.findOrCreateByVerifiedPhone(phone);
    if (user.userType !== 'CUSTOMER') {
      // Staff and vendors must use password + MFA; an OTP alone is not enough for them.
      await this.event({
        type: 'LOGIN_FAILED',
        success: false,
        userId: user.id,
        reason: 'otp_not_allowed',
        ...this.metaOf(meta),
      });
      throw new ForbiddenError('Use the admin login for this account');
    }
    if (!isUsable(user)) {
      await this.event({
        type: 'LOGIN_FAILED',
        success: false,
        userId: user.id,
        reason: 'inactive',
        ...this.metaOf(meta),
      });
      throw new ForbiddenError('This account is not active');
    }
    await this.event({
      type: 'OTP_VERIFIED',
      success: true,
      userId: user.id,
      ...this.metaOf(meta),
    });
    const tokens = await this.startSession(user, meta, null);
    return created ? { ...tokens, isNewUser: true } : tokens;
  }

  // ── Admin: email/username + password (+ TOTP) ────────────────────────────────────────────

  async adminLogin(
    identifier: string,
    password: string,
    meta: RequestMeta,
  ): Promise<AdminLoginResult> {
    const found = await this.deps.usersService.findLoginUser(identifier);
    const candidate = found !== null && PASSWORD_LOGIN_TYPES.has(found.userType) ? found : null;
    const check = await this.deps.credentialsService.verifyPassword(
      candidate?.id ?? null,
      password,
    );

    if (!check.ok || candidate === null) {
      const reason = check.ok ? 'bad_password' : check.reason;
      await this.event({
        type: reason === 'locked' ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
        success: false,
        userId: candidate?.id ?? null,
        identifier: candidate === null ? mask(identifier) : null,
        reason,
        ...this.metaOf(meta),
      });
      if (reason === 'locked')
        throw new ForbiddenError(
          'Account temporarily locked after repeated failures. Try again later.',
        );
      throw new UnauthorizedError(INVALID_CREDENTIALS);
    }
    if (!isUsable(candidate)) {
      await this.event({
        type: 'LOGIN_FAILED',
        success: false,
        userId: candidate.id,
        reason: 'inactive',
        ...this.metaOf(meta),
      });
      throw new ForbiddenError('This account is not active');
    }

    const [access, hasTotp] = await Promise.all([
      this.deps.accessService.getUserAccess(candidate.id),
      this.deps.mfaService.hasActiveTotp(candidate.id),
    ]);
    if (hasTotp) {
      const challengeId = await this.deps.mfaService.createChallenge({
        userId: candidate.id,
        meta,
      });
      return {
        status: 'mfa_required',
        challengeId,
        methods: ['totp', 'recovery_code'],
        expiresIn: MFA_CHALLENGE_TTL_SECONDS,
      };
    }
    // MFA is opt-in unless MFA_ENFORCED: without an authenticator, go straight to a full session.
    if (this.mfaMandatory(candidate.mfaRequired || access.mfaRequired))
      return this.enrolmentOnly(candidate, access.roles, meta);
    return this.startSession(candidate, meta, null);
  }

  async verifyMfa(
    challengeId: string,
    input: { code?: string; recoveryCode?: string },
    meta: RequestMeta,
  ): Promise<AuthTokens> {
    const { mfaService } = this.deps;
    const challenge = await mfaService.readChallenge(challengeId);
    if (challenge === null) throw new UnauthorizedError('MFA challenge expired; log in again');

    if (!(await mfaService.verify(challenge.userId, input))) {
      await mfaService.failChallenge(challengeId);
      await this.event({
        type: 'MFA_FAILED',
        success: false,
        userId: challenge.userId,
        ...this.metaOf(meta),
      });
      throw new UnauthorizedError(INVALID_CODE);
    }
    if (!(await mfaService.consumeChallenge(challengeId)))
      throw new UnauthorizedError('MFA challenge already used');

    const user = await this.deps.usersService.findLoginUserById(challenge.userId);
    if (user === null || !isUsable(user)) throw new ForbiddenError('This account is not active');
    await this.event({
      type: 'MFA_SUCCESS',
      success: true,
      userId: user.id,
      ...this.metaOf(meta),
      metadata: { method: input.recoveryCode === undefined ? 'totp' : 'recovery_code' },
    });
    // The device recorded at password time is the one completing MFA.
    return this.startSession(
      user,
      { ...challenge.meta, ip: meta.ip, userAgent: meta.userAgent },
      new Date(),
    );
  }

  // ── Tokens ───────────────────────────────────────────────────────────────────────────────

  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthTokens> {
    const result = await this.deps.sessionsService.rotate(refreshToken, meta);
    if (!result.ok) {
      if (result.reason === 'reused') {
        this.deps.logger.warn(
          { userId: result.userId },
          'refresh token reuse detected; session family revoked',
        );
        await this.event({
          type: 'TOKEN_REUSE_DETECTED',
          success: false,
          userId: result.userId ?? null,
          sessionId: result.sessionId ?? null,
          ...this.metaOf(meta),
        });
      }
      throw new UnauthorizedError(INVALID_REFRESH);
    }
    const user = await this.deps.usersService.findLoginUserById(result.userId);
    if (user === null || !isUsable(user)) {
      await this.deps.sessionsService.revokeSession(result.sessionId, 'USER_SUSPENDED');
      throw new UnauthorizedError(INVALID_REFRESH);
    }
    const access = await this.deps.accessService.getUserAccess(user.id);
    const issued = this.deps.tokensService.issueAccessToken({
      userId: user.id,
      sessionId: result.sessionId,
      userType: user.userType,
      roles: access.roles,
      scope: 'full',
    });
    await this.event({
      type: 'TOKEN_REFRESHED',
      success: true,
      userId: user.id,
      sessionId: result.sessionId,
      ...this.metaOf(meta),
    });
    return {
      status: 'authenticated',
      tokenType: 'Bearer',
      accessToken: issued.accessToken,
      expiresIn: issued.expiresIn,
      refreshToken: result.refreshToken,
      refreshExpiresAt: result.absoluteExpiresAt.toISOString(),
      user: this.summary(user, access.roles),
    };
  }

  /** Ends this session: refresh token dead, this access token blacklisted at once. */
  async logout(user: AuthUser, meta: RequestMeta): Promise<void> {
    await Promise.all([
      this.deps.sessionsService.blacklistAccessToken(user.jti, user.expiresAt),
      this.deps.sessionsService.revokeSession(user.sessionId, 'LOGOUT'),
    ]);
    await this.event({
      type: 'LOGOUT',
      success: true,
      userId: user.id,
      sessionId: user.sessionId,
      ...this.metaOf(meta),
    });
  }

  async logoutAll(user: AuthUser, meta: RequestMeta): Promise<{ revokedSessions: number }> {
    const ids = await this.deps.sessionsService.revokeAllForUser(user.id, 'LOGOUT_ALL');
    await Promise.all([
      this.deps.sessionsService.publishRevocations(ids),
      this.deps.sessionsService.blacklistAccessToken(user.jti, user.expiresAt),
    ]);
    await this.event({
      type: 'LOGOUT_ALL',
      success: true,
      userId: user.id,
      ...this.metaOf(meta),
      metadata: { revokedSessions: ids.length },
    });
    return { revokedSessions: ids.length };
  }

  // ── Passwords ────────────────────────────────────────────────────────────────────────────

  /** Same response whether or not the account exists. Code by SMS (phone) or email. */
  async forgotPassword(identifier: string, meta: RequestMeta): Promise<{ sent: true }> {
    const user = await this.deps.usersService.findLoginUser(identifier);
    if (user !== null && PASSWORD_LOGIN_TYPES.has(user.userType) && isUsable(user)) {
      const deliver = async (code: string) => {
        const text = `${code} is your FarmX password reset code. Valid for 5 minutes. If you did not ask for it, ignore this message.`;
        if (user.phone !== null) await this.deps.smsSender.send(user.phone, text);
        else if (user.email !== null)
          await this.deps.emailSender.send(user.email, 'FarmX password reset', text);
      };
      try {
        await this.deps.otpService.issue('pwd_reset', user.id, deliver);
      } catch (error) {
        // Cooldown hits are swallowed so the response stays identical for every identifier.
        this.deps.logger.info({ err: error, userId: user.id }, 'password reset code not sent');
      }
      await this.event({
        type: 'PASSWORD_RESET_REQUESTED',
        success: true,
        userId: user.id,
        ...this.metaOf(meta),
      });
    }
    return { sent: true };
  }

  async resetPassword(
    identifier: string,
    code: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const user = await this.deps.usersService.findLoginUser(identifier);
    const outcome =
      user === null ? 'invalid' : await this.deps.otpService.verify('pwd_reset', user.id, code);
    if (
      user === null ||
      outcome !== 'ok' ||
      !PASSWORD_LOGIN_TYPES.has(user.userType) ||
      !isUsable(user)
    ) {
      await this.event({
        type: 'PASSWORD_RESET',
        success: false,
        userId: user?.id ?? null,
        reason: outcome,
        ...this.metaOf(meta),
      });
      throw new BadRequestError(INVALID_CODE);
    }
    await this.replacePassword(user, newPassword, 'PASSWORD_CHANGED', undefined);
    await this.event({
      type: 'PASSWORD_RESET',
      success: true,
      userId: user.id,
      ...this.metaOf(meta),
    });
  }

  /** Needs the current password; ends every OTHER session of the user. */
  async changePassword(
    caller: AuthUser,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const user = await this.deps.usersService.findLoginUserById(caller.id);
    if (user === null) throw new UnauthorizedError();
    const check = await this.deps.credentialsService.verifyPassword(user.id, currentPassword);
    if (!check.ok) {
      await this.event({
        type: 'PASSWORD_CHANGED',
        success: false,
        userId: user.id,
        reason: check.reason,
        ...this.metaOf(meta),
      });
      if (check.reason === 'no_credential')
        throw new BadRequestError('This account signs in with a one-time code and has no password');
      throw new UnauthorizedError('Current password is incorrect');
    }
    if (currentPassword === newPassword)
      throw new BadRequestError('The new password must differ from the current one');
    await this.replacePassword(user, newPassword, 'PASSWORD_CHANGED', caller.sessionId);
    await this.event({
      type: 'PASSWORD_CHANGED',
      success: true,
      userId: user.id,
      ...this.metaOf(meta),
    });
  }

  // ── MFA enrolment (self-service) ─────────────────────────────────────────────────────────

  async startTotpEnrollment(caller: AuthUser): Promise<TotpEnrollment> {
    const user = await this.deps.usersService.findLoginUserById(caller.id);
    if (user === null) throw new UnauthorizedError();
    return this.deps.mfaService.startEnrollment(
      user.id,
      user.email ?? user.username ?? user.phone ?? user.id,
    );
  }

  /** Confirms the authenticator; an enrolment-only caller gets a full session in exchange. */
  async confirmTotpEnrollment(
    caller: AuthUser,
    code: string,
    meta: RequestMeta,
  ): Promise<TotpConfirmResult> {
    const recoveryCodes = await this.deps.mfaService.confirmEnrollment(caller.id, code);
    if (recoveryCodes === null) {
      await this.event({
        type: 'MFA_FAILED',
        success: false,
        userId: caller.id,
        reason: 'enrolment_code',
        ...this.metaOf(meta),
      });
      throw new BadRequestError(INVALID_CODE);
    }
    await this.event({
      type: 'MFA_ENROLLED',
      success: true,
      userId: caller.id,
      ...this.metaOf(meta),
    });
    if (caller.scope === 'full') return { recoveryCodes };

    await this.deps.sessionsService.revokeSession(caller.sessionId, 'LOGOUT');
    const user = await this.deps.usersService.findLoginUserById(caller.id);
    if (user === null || !isUsable(user)) throw new ForbiddenError('This account is not active');
    return { recoveryCodes, tokens: await this.startSession(user, meta, new Date()) };
  }

  /** Removes the authenticator after a valid code. Refused when MFA is mandatory. */
  async disableTotp(caller: AuthUser, code: string, meta: RequestMeta): Promise<void> {
    const [user, access] = await Promise.all([
      this.deps.usersService.findLoginUserById(caller.id),
      this.deps.accessService.getUserAccess(caller.id),
    ]);
    if (user === null) throw new UnauthorizedError();
    if (this.mfaMandatory(user.mfaRequired || access.mfaRequired))
      throw new ConflictError('MFA is mandatory for this account');
    if (!(await this.deps.mfaService.verify(user.id, { code })))
      throw new BadRequestError(INVALID_CODE);
    await this.deps.mfaService.disable(user.id);
    await this.event({ type: 'MFA_REMOVED', success: true, userId: user.id, ...this.metaOf(meta) });
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────

  /** The account/role `mfaRequired` flags only bite when MFA_ENFORCED is on (opt-in otherwise). */
  private mfaMandatory(flagged: boolean): boolean {
    return this.deps.config.MFA_ENFORCED && flagged;
  }

  /** Hash outside the transaction (slow), then swap the password and end sessions atomically. */
  private async replacePassword(
    user: LoginUserRecord,
    newPassword: string,
    reason: 'PASSWORD_CHANGED',
    keepSessionId: string | undefined,
  ): Promise<void> {
    const { credentialsService, sessionsService, usersService } = this.deps;
    const personal = [user.email, user.email?.split('@')[0], user.phone, user.username].filter(
      (v): v is string => typeof v === 'string' && v !== '',
    );
    const [hash] = await Promise.all([
      credentialsService.hashNewPassword(newPassword, personal, 'newPassword'),
      credentialsService.assertNotReused(user.id, newPassword),
    ]);
    const revoked = await this.deps.runInTransaction(async (tx) => {
      await credentialsService.setPassword(user.id, hash, tx);
      await usersService.clearMustChangePassword(user.id, tx);
      return sessionsService.revokeAllForUser(user.id, reason, tx, keepSessionId);
    });
    await sessionsService.publishRevocations(revoked);
  }

  /** Device registry + session + access token. */
  private async startSession(
    user: LoginUserRecord,
    meta: RequestMeta,
    mfaVerifiedAt: Date | null,
  ): Promise<AuthTokens> {
    const { config, accessService, sessionsService, tokensService, usersService } = this.deps;
    const [access, deviceId] = await Promise.all([
      accessService.getUserAccess(user.id),
      this.registerDevice(user, meta),
    ]);

    const isCustomer = user.userType === 'CUSTOMER';
    const idleMinutes = isCustomer
      ? config.CUSTOMER_SESSION_IDLE_DAYS * 24 * 60
      : Math.min(
          access.sessionIdleMinutes ?? config.ADMIN_SESSION_IDLE_MINUTES,
          config.ADMIN_SESSION_IDLE_MINUTES,
        );
    const absoluteSeconds = isCustomer
      ? config.CUSTOMER_SESSION_MAX_DAYS * 86_400
      : config.ADMIN_SESSION_MAX_HOURS * 3_600;

    const session = await sessionsService.createSession({
      userId: user.id,
      deviceId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      idleSeconds: idleMinutes * 60,
      absoluteSeconds,
      mfaVerifiedAt,
    });
    const issued = tokensService.issueAccessToken({
      userId: user.id,
      sessionId: session.sessionId,
      userType: user.userType,
      roles: access.roles,
      scope: 'full',
    });
    await Promise.all([
      usersService.recordLogin(user.id, meta.ip, deviceId),
      this.event({
        type: 'LOGIN_SUCCESS',
        success: true,
        userId: user.id,
        sessionId: session.sessionId,
        deviceId,
        ...this.metaOf(meta),
      }),
    ]);
    return {
      status: 'authenticated',
      tokenType: 'Bearer',
      accessToken: issued.accessToken,
      expiresIn: issued.expiresIn,
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.absoluteExpiresAt.toISOString(),
      user: this.summary(user, access.roles),
    };
  }

  /** MFA mandatory but not enrolled: short session, enrolment-only access token, no refresh. */
  private async enrolmentOnly(
    user: LoginUserRecord,
    roles: string[],
    meta: RequestMeta,
  ): Promise<MfaEnrollmentResponse> {
    const session = await this.deps.sessionsService.createSession({
      userId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      idleSeconds: ENROLMENT_SESSION_SECONDS,
      absoluteSeconds: ENROLMENT_SESSION_SECONDS,
    });
    const issued = this.deps.tokensService.issueAccessToken({
      userId: user.id,
      sessionId: session.sessionId,
      userType: user.userType,
      roles,
      scope: 'mfa_enroll',
    });
    await this.event({
      type: 'LOGIN_SUCCESS',
      success: true,
      userId: user.id,
      sessionId: session.sessionId,
      reason: 'mfa_enrollment_required',
      ...this.metaOf(meta),
    });
    return {
      status: 'mfa_enrollment_required',
      tokenType: 'Bearer',
      accessToken: issued.accessToken,
      expiresIn: issued.expiresIn,
      user: this.summary(user, roles),
    };
  }

  /** Records the device (hash of the client id) and refuses blocked devices. */
  private async registerDevice(user: LoginUserRecord, meta: RequestMeta): Promise<string | null> {
    if (meta.deviceId === undefined) return null;
    const device = await this.deps.authRepository.upsertDevice({
      userId: user.id,
      deviceHash: createHash('sha256').update(meta.deviceId).digest('hex'),
      platform: meta.platform ?? 'OTHER',
      name: meta.deviceName ?? null,
      ip: meta.ip,
    });
    if (device.status === 'BLOCKED') {
      await this.event({
        type: 'DEVICE_LOGIN_BLOCKED',
        success: false,
        userId: user.id,
        deviceId: device.id,
        ...this.metaOf(meta),
      });
      throw new ForbiddenError('This device is blocked for your account');
    }
    if (device.isNew)
      await this.event({
        type: 'NEW_DEVICE',
        success: true,
        userId: user.id,
        deviceId: device.id,
        ...this.metaOf(meta),
      });
    return device.id;
  }

  private summary(user: LoginUserRecord, roles: string[]): AuthUserSummary {
    return {
      id: user.id,
      userType: user.userType,
      fullName: user.fullName,
      roles,
      mustChangePassword: user.mustChangePassword,
    };
  }

  private metaOf(meta: RequestMeta): Pick<AuthEventInput, 'ip' | 'userAgent'> {
    return { ip: meta.ip, userAgent: meta.userAgent };
  }

  /** Auth events are security records; a failure to write one is logged, never fatal. */
  private async event(event: AuthEventInput): Promise<void> {
    try {
      await this.deps.authRepository.recordEvent(event);
    } catch (err) {
      this.deps.logger.error({ err, type: event.type }, 'failed to record auth event');
    }
  }
}
