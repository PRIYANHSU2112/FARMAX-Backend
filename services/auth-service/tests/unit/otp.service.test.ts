import { describe, expect, it, vi } from 'vitest';

import { OtpService } from '../../src/features/auth/otp.service.js';
import { FakeRedis } from '../helpers/fake-redis.js';

const setup = (config: { OTP_DEV_CODE?: string; SMS_PROVIDER?: string } = {}) => {
  const redis = new FakeRedis();
  const otp = new OtpService({
    redis,
    authSecrets: { otpPepper: 'p'.repeat(32), mfaKey: Buffer.alloc(32) },
    config: { SMS_PROVIDER: 'console', ...config },
  } as unknown as ConstructorParameters<typeof OtpService>[0]);
  let lastCode = '';
  const deliver = vi.fn((code: string) => {
    lastCode = code;
    return Promise.resolve();
  });
  return { redis, otp, deliver, code: () => lastCode };
};

const PHONE = '+919876543210';

describe('OtpService', () => {
  it('issues a random 6-digit code and stores only an HMAC (no raw code, no raw phone in keys)', async () => {
    const t = setup();
    await expect(t.otp.issue('login', PHONE, t.deliver)).resolves.toEqual({
      expiresIn: 300,
      resendAfter: 30,
    });
    expect(t.code()).toMatch(/^\d{6}$/);
    const stored = t.redis.keys().join(' ');
    expect(stored).not.toContain('9876543210');
    for (const key of t.redis.keys()) {
      expect(await t.redis.hget(key, 'code')).not.toBe(t.code());
    }
  });

  it('OTP_DEV_CODE is used only with the console SMS provider, and stays single-use', async () => {
    const dev = setup({ OTP_DEV_CODE: '123456' });
    await dev.otp.issue('login', PHONE, dev.deliver);
    expect(dev.code()).toBe('123456');
    await expect(dev.otp.verify('login', PHONE, '123456')).resolves.toBe('ok');
    await expect(dev.otp.verify('login', PHONE, '123456')).resolves.toBe('expired');

    // With a real SMS provider the dev code is ignored: codes stay random.
    const seen = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const t = setup({ OTP_DEV_CODE: '123456', SMS_PROVIDER: 'msg91' });
      await t.otp.issue('login', PHONE, t.deliver);
      seen.add(t.code());
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('codes are not static', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const t = setup();
      await t.otp.issue('login', PHONE, t.deliver);
      codes.add(t.code());
    }
    expect(codes.size).toBeGreaterThan(1);
  });

  it('verifies once (single use)', async () => {
    const t = setup();
    await t.otp.issue('login', PHONE, t.deliver);
    expect(await t.otp.verify('login', PHONE, t.code())).toBe('ok');
    expect(await t.otp.verify('login', PHONE, t.code())).toBe('expired');
  });

  it('allows 5 attempts, then the code is destroyed', async () => {
    const t = setup();
    await t.otp.issue('login', PHONE, t.deliver);
    const wrong = t.code() === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i += 1)
      expect(await t.otp.verify('login', PHONE, wrong)).toBe('invalid');
    expect(await t.otp.verify('login', PHONE, wrong)).toBe('too_many_attempts');
    expect(await t.otp.verify('login', PHONE, t.code())).toBe('expired');
  });

  it('expires after 5 minutes', async () => {
    const t = setup();
    await t.otp.issue('login', PHONE, t.deliver);
    const start = Date.now();
    t.redis.now = () => start + 301_000;
    expect(await t.otp.verify('login', PHONE, t.code())).toBe('expired');
  });

  it('enforces the 30 s resend cooldown with 429', async () => {
    const t = setup();
    await t.otp.issue('login', PHONE, t.deliver);
    await expect(t.otp.issue('login', PHONE, t.deliver)).rejects.toMatchObject({ statusCode: 429 });
  });

  it('codes are bound to purpose and destination', async () => {
    const t = setup();
    await t.otp.issue('login', PHONE, t.deliver);
    expect(await t.otp.verify('pwd_reset', PHONE, t.code())).toBe('expired');
    expect(await t.otp.verify('login', '+919999999999', t.code())).toBe('expired');
  });

  it('removes the code and cooldown when delivery fails (retry allowed)', async () => {
    const t = setup();
    await expect(
      t.otp.issue('login', PHONE, () => Promise.reject(new Error('sms down'))),
    ).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(t.redis.keys()).toHaveLength(0);
    await expect(t.otp.issue('login', PHONE, t.deliver)).resolves.toBeDefined();
  });
});
