import { createHmac, randomInt } from 'node:crypto';

import { ExternalServiceError, RateLimitError } from '@farmx/common/errors';
import { authKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import {
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
  type OtpPurpose,
} from './auth.types.js';

export type OtpVerifyResult = 'ok' | 'invalid' | 'expired' | 'too_many_attempts';

/**
 * Atomic verify: missing → -1 · match → delete, 1 · mismatch → attempts+1 (delete at max) → 0 / -2.
 * The stored value is an HMAC, so even a Redis reader never sees a usable code.
 */
const VERIFY_SCRIPT = [
  'local stored = redis.call("HGET", KEYS[1], "code")',
  'if not stored then return -1 end',
  'if stored == ARGV[1] then redis.call("DEL", KEYS[1]); return 1 end',
  'local attempts = redis.call("HINCRBY", KEYS[1], "attempts", 1)',
  'if attempts >= tonumber(ARGV[2]) then redis.call("DEL", KEYS[1]); return -2 end',
  'return 0',
].join('\n');

/**
 * One-time codes in redis-cache: `crypto.randomInt` (never static), HMAC-SHA256 with a server
 * pepper, 5 min TTL, 5 attempts, single use, 30 s resend cooldown. Destinations are hashed.
 */
export class OtpService {
  private readonly deps: Pick<Cradle, 'redis' | 'authSecrets' | 'config'>;

  constructor(deps: Pick<Cradle, 'redis' | 'authSecrets' | 'config'>) {
    this.deps = deps;
  }

  /** DEV ONLY fixed code: needs OTP_DEV_CODE AND the console SMS provider (never real SMS). */
  private newCode(): string {
    const { OTP_DEV_CODE, SMS_PROVIDER } = this.deps.config;
    if (OTP_DEV_CODE !== undefined && SMS_PROVIDER === 'console') return OTP_DEV_CODE;
    return randomInt(0, 10 ** OTP_LENGTH)
      .toString()
      .padStart(OTP_LENGTH, '0');
  }

  private hmac(value: string): string {
    return createHmac('sha256', this.deps.authSecrets.otpPepper).update(value).digest('hex');
  }

  /** Keyed hash of a phone / email / user id (no raw identifiers in Redis keys or logs). */
  destinationHash(destination: string): string {
    return this.hmac(`dest:${destination.trim().toLowerCase()}`).slice(0, 40);
  }

  private codeHash(purpose: OtpPurpose, destHash: string, code: string): string {
    return this.hmac(`otp:${purpose}:${destHash}:${code}`);
  }

  /**
   * Creates a code and hands it to `deliver` (SMS / email). 429 inside the resend cooldown.
   * If delivery fails, the code and the cooldown are removed so the user can retry at once.
   */
  async issue(
    purpose: OtpPurpose,
    destination: string,
    deliver: (code: string) => Promise<void>,
  ): Promise<{ expiresIn: number; resendAfter: number }> {
    const { redis } = this.deps;
    const destHash = this.destinationHash(destination);
    const cooldownKey = authKeys.otpCooldown(purpose, destHash);
    const otpKey = authKeys.otp(purpose, destHash);

    const acquired = await redis.set(cooldownKey, '1', 'EX', OTP_RESEND_COOLDOWN_SECONDS, 'NX');
    if (acquired === null) throw new RateLimitError(Math.max(await redis.ttl(cooldownKey), 1));

    const code = this.newCode();
    await redis
      .multi()
      .del(otpKey)
      .hset(otpKey, 'code', this.codeHash(purpose, destHash, code), 'attempts', '0')
      .expire(otpKey, OTP_TTL_SECONDS)
      .exec();

    try {
      await deliver(code);
    } catch (error) {
      await redis.del(otpKey, cooldownKey);
      throw new ExternalServiceError('otp-delivery', { cause: error });
    }
    return { expiresIn: OTP_TTL_SECONDS, resendAfter: OTP_RESEND_COOLDOWN_SECONDS };
  }

  async verify(purpose: OtpPurpose, destination: string, code: string): Promise<OtpVerifyResult> {
    const destHash = this.destinationHash(destination);
    const result = (await this.deps.redis.eval(
      VERIFY_SCRIPT,
      1,
      authKeys.otp(purpose, destHash),
      this.codeHash(purpose, destHash, code),
      OTP_MAX_ATTEMPTS,
    )) as number;
    if (result === 1) return 'ok';
    if (result === -1) return 'expired';
    if (result === -2) return 'too_many_attempts';
    return 'invalid';
  }
}
