import { randomBytes } from 'node:crypto';

import { ConflictError, NotFoundError } from '@farmx/common/errors';
import { authKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import {
  MFA_CHALLENGE_TTL_SECONDS,
  MFA_MAX_ATTEMPTS,
  RECOVERY_CODE_COUNT,
  type RequestMeta,
  TOTP_STEP_SECONDS,
  TOTP_WINDOW,
  type TotpEnrollment,
} from './auth.types.js';
import {
  base32Decode,
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUrl,
  verifyTotp,
} from './totp.js';

export interface MfaChallenge {
  userId: string;
  meta: RequestMeta;
}

/** Atomic attempt counter: +1, delete at max. Returns -1 when missing, else the new count. */
const FAIL_SCRIPT = [
  'if redis.call("EXISTS", KEYS[1]) == 0 then return -1 end',
  'local n = redis.call("HINCRBY", KEYS[1], "attempts", 1)',
  'if n >= tonumber(ARGV[1]) then redis.call("DEL", KEYS[1]) end',
  'return n',
].join('\n');

/**
 * TOTP MFA (RFC 6238) with AES-256-GCM-encrypted secrets, single-use SHA-256 recovery codes,
 * per-step replay protection, and short-lived login challenges in Redis.
 */
export class MfaService {
  private readonly deps: Pick<Cradle, 'authRepository' | 'redis' | 'authSecrets'>;

  constructor(deps: Pick<Cradle, 'authRepository' | 'redis' | 'authSecrets'>) {
    this.deps = deps;
  }

  async hasActiveTotp(userId: string): Promise<boolean> {
    const factor = await this.deps.authRepository.findTotpFactor(userId);
    return factor?.verifiedAt != null;
  }

  /** Starts (or restarts) enrolment. 409 if a verified authenticator already exists. */
  async startEnrollment(userId: string, accountLabel: string): Promise<TotpEnrollment> {
    if (await this.hasActiveTotp(userId)) {
      throw new ConflictError('An authenticator app is already set up; remove it first');
    }
    const secret = newTotpSecret();
    await this.deps.authRepository.createPendingTotp(
      userId,
      encryptSecret(secret, this.deps.authSecrets.mfaKey),
    );
    return { secret, otpauthUrl: otpauthUrl(secret, accountLabel) };
  }

  /** Confirms enrolment with a first code; returns the recovery codes (shown once) or null. */
  async confirmEnrollment(userId: string, code: string): Promise<string[] | null> {
    const factor = await this.deps.authRepository.findTotpFactor(userId);
    if (factor === null) throw new NotFoundError('Pending authenticator enrolment');
    if (factor.verifiedAt !== null) throw new ConflictError('Authenticator already confirmed');
    if (!(await this.checkTotp(factor.id, factor.secretEncrypted, code))) return null;
    const codes = newRecoveryCodes(RECOVERY_CODE_COUNT);
    await this.deps.authRepository.confirmTotp(factor.id, userId, codes.map(hashRecoveryCode));
    return codes;
  }

  /** TOTP code or a single-use recovery code. */
  async verify(userId: string, input: { code?: string; recoveryCode?: string }): Promise<boolean> {
    if (input.recoveryCode !== undefined) {
      return this.deps.authRepository.consumeRecoveryCode(
        userId,
        hashRecoveryCode(input.recoveryCode),
      );
    }
    if (input.code === undefined) return false;
    const factor = await this.deps.authRepository.findTotpFactor(userId);
    if (factor?.verifiedAt == null) return false;
    const ok = await this.checkTotp(factor.id, factor.secretEncrypted, input.code);
    if (ok) await this.deps.authRepository.touchFactor(factor.id);
    return ok;
  }

  disable(userId: string): Promise<void> {
    return this.deps.authRepository.disableTotp(userId);
  }

  /** Valid code for the current ±1 step AND not used before (replay protection). */
  private async checkTotp(
    factorId: string,
    secretEncrypted: string | null,
    code: string,
  ): Promise<boolean> {
    if (secretEncrypted === null) return false;
    const secret = base32Decode(decryptSecret(secretEncrypted, this.deps.authSecrets.mfaKey));
    const step = verifyTotp(secret, code, Date.now(), TOTP_STEP_SECONDS, TOTP_WINDOW);
    if (step === null) return false;
    const fresh = await this.deps.redis.set(
      authKeys.keyspace.key('totp-used', factorId, step),
      '1',
      'EX',
      TOTP_STEP_SECONDS * (2 * TOTP_WINDOW + 2),
      'NX',
    );
    return fresh !== null;
  }

  // ── Login challenges ─────────────────────────────────────────────────────────────────────

  async createChallenge(challenge: MfaChallenge): Promise<string> {
    const id = randomBytes(24).toString('base64url');
    const key = authKeys.mfaChallenge(id);
    await this.deps.redis
      .multi()
      .hset(key, 'payload', JSON.stringify(challenge), 'attempts', '0')
      .expire(key, MFA_CHALLENGE_TTL_SECONDS)
      .exec();
    return id;
  }

  async readChallenge(id: string): Promise<MfaChallenge | null> {
    const payload = await this.deps.redis.hget(authKeys.mfaChallenge(id), 'payload');
    return payload === null ? null : (JSON.parse(payload) as MfaChallenge);
  }

  /** Counts a failed attempt; the challenge is deleted at the limit. */
  async failChallenge(id: string): Promise<void> {
    await this.deps.redis.eval(FAIL_SCRIPT, 1, authKeys.mfaChallenge(id), MFA_MAX_ATTEMPTS);
  }

  /** Single use: true only for the one caller that deletes it (concurrent verifies lose). */
  async consumeChallenge(id: string): Promise<boolean> {
    return (await this.deps.redis.del(authKeys.mfaChallenge(id))) === 1;
  }
}
