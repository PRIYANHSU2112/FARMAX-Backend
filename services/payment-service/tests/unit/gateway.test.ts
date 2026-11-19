import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hmacHex, maskVpa, safeEqualHex } from '../../src/adapters/gateway.js';
import { RazorpayGateway } from '../../src/adapters/razorpay.js';
import { loadConfig } from '../../src/config/index.js';
import { backoffAfter } from '../../src/features/refunds/refunds.types.js';
import { rupees } from '../../src/features/payments/payments.types.js';

const silent = { warn: () => undefined } as never;
const rzp = new RazorpayGateway(
  {
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'key_secret_123',
    RAZORPAY_WEBHOOK_SECRET: 'webhook_secret_123',
    RAZORPAY_API_URL: 'https://api.razorpay.com/v1',
  },
  silent,
);

describe('Razorpay signatures', () => {
  it('checkout: HMAC_SHA256(order_id|payment_id, key secret), constant-time compare', () => {
    const sig = createHmac('sha256', 'key_secret_123').update('order_A|pay_B').digest('hex');
    expect(rzp.verifyCheckoutSignature('order_A', 'pay_B', sig)).toBe(true);
    expect(rzp.verifyCheckoutSignature('order_A', 'pay_C', sig)).toBe(false);
    expect(rzp.verifyCheckoutSignature('order_A', 'pay_B', sig.slice(1))).toBe(false);
  });

  it('webhook: HMAC_SHA256(raw body, webhook secret) — one changed byte fails', () => {
    const raw = Buffer.from('{"event":"payment.captured","payload":{}}');
    const sig = hmacHex('webhook_secret_123', raw);
    expect(rzp.verifyWebhookSignature(raw, sig)).toBe(true);
    expect(rzp.verifyWebhookSignature(Buffer.from(`${raw.toString()} `), sig)).toBe(false);
    expect(rzp.verifyWebhookSignature(raw, hmacHex('key_secret_123', raw))).toBe(false);
  });

  it('safeEqualHex rejects different lengths without throwing', () => {
    expect(safeEqualHex('abcd', 'abc')).toBe(false);
    expect(safeEqualHex('abcd', 'abcd')).toBe(true);
  });
});

describe('helpers', () => {
  it('masks a VPA', () => {
    expect(maskVpa('venkatesh.r@okhdfc')).toBe('ve***@okhdfc');
    expect(maskVpa('a@ybl')).toBe('a***@ybl');
    expect(maskVpa(null)).toBeNull();
  });

  it('formats paise as rupees exactly', () => {
    expect(rupees(2_782_100n)).toBe('27821.00');
    expect(rupees(5)).toBe('0.05');
  });

  it('refund backoff: 1 m, 5 m, 30 m, 2 h, 6 h, then 24 h', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(backoffAfter)).toEqual([
      60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000, 86_400_000,
    ]);
  });
});

describe('config', () => {
  const base = { DATABASE_URL: 'postgresql://x:y@localhost:5432/db', NODE_ENV: 'test' };
  it('refuses the mock gateway in production', () => {
    expect(() =>
      loadConfig({ ...base, APP_ENV: 'prod', PAYMENT_PROVIDER: 'mock', JWT_PUBLIC_KEY: 'YQ==' }),
    ).toThrow();
  });
  it('requires Razorpay keys when the provider is razorpay', () => {
    expect(() => loadConfig({ ...base, PAYMENT_PROVIDER: 'razorpay' })).toThrow();
    expect(
      loadConfig({
        ...base,
        PAYMENT_PROVIDER: 'razorpay',
        RAZORPAY_KEY_ID: 'rzp_test_key',
        RAZORPAY_KEY_SECRET: 'key_secret_123',
        RAZORPAY_WEBHOOK_SECRET: 'webhook_secret_123',
      }).PAYMENT_PROVIDER,
    ).toBe('razorpay');
  });
  it('defaults to the mock gateway outside production', () => {
    expect(loadConfig(base).PAYMENT_PROVIDER).toBe('mock');
  });
});
