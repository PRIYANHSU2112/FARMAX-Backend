import { generateKeyPairSync } from 'node:crypto';

import { createLogger } from '@farmx/common/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FcmPushProvider } from '../../src/adapters/providers/fcm.js';
import { SmtpEmailProvider } from '../../src/adapters/providers/smtp.js';
import { maskEmail, maskPhone, withTimeout } from '../../src/adapters/providers/types.js';
import { loadConfig } from '../../src/config/index.js';
import { retryDelayMs } from '../../src/features/notifications/notifications.delivery.service.js';

const logger = createLogger({ service: 'test', level: 'silent', appEnv: 'local', version: '0' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('retry backoff', () => {
  it('doubles from 30 s with ±20 % jitter, capped at 1 h', () => {
    expect(retryDelayMs(1, () => 0)).toBe(30_000);
    expect(retryDelayMs(3, () => 0)).toBe(120_000);
    expect(retryDelayMs(20, () => 0)).toBe(3_600_000);
    expect(retryDelayMs(1, () => 0.2)).toBe(36_000);
    expect(retryDelayMs(1, () => -0.2)).toBe(24_000);
    for (let i = 0; i < 50; i += 1) {
      const d = retryDelayMs(2);
      expect(d).toBeGreaterThanOrEqual(48_000);
      expect(d).toBeLessThanOrEqual(72_000);
    }
  });
});

describe('FCM HTTP v1 provider', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = Buffer.from(
    JSON.stringify({
      project_id: 'farmx-test',
      client_email: 'push@farmx-test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
  ).toString('base64');
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fcmError = (status: number, code: string) =>
    json(status, {
      error: {
        status: code,
        message: `${code} token`,
        details: [
          { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code },
        ],
      },
    });

  it('signs an OAuth JWT once, sends per token and classifies results', async () => {
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      if (url.startsWith('https://oauth2.googleapis.com'))
        return Promise.resolve(json(200, { access_token: 'ya29.test', expires_in: 3600 }));
      const token = (JSON.parse(init.body as string) as { message: { token: string } }).message
        .token;
      if (token === 'dead') return Promise.resolve(fcmError(404, 'UNREGISTERED'));
      if (token === 'busy') return Promise.resolve(fcmError(503, 'UNAVAILABLE'));
      return Promise.resolve(json(200, { name: 'projects/farmx-test/messages/1' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const fcm = new FcmPushProvider(account, 5000, logger);
    const message = { title: 'T', body: 'B', data: { notificationId: 'n1' } };

    const r1 = await fcm.send({
      ...message,
      tokens: [
        { id: 'a', token: 'ok' },
        { id: 'b', token: 'dead' },
        { id: 'c', token: 'busy' },
      ],
    });
    expect(r1).toMatchObject({
      sent: 1,
      providerMessageId: 'projects/farmx-test/messages/1',
      invalidTokenIds: ['b'],
      retryable: true,
    });
    const [oauthUrl, oauthInit] = fetchMock.mock.calls[0] ?? [];
    expect(oauthUrl).toBe('https://oauth2.googleapis.com/token');
    expect((oauthInit?.body as URLSearchParams).toString()).toContain(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer',
    );
    const send = fetchMock.mock.calls[1];
    expect(send?.[0]).toBe('https://fcm.googleapis.com/v1/projects/farmx-test/messages:send');
    expect((send?.[1].headers as Record<string, string>).authorization).toBe('Bearer ya29.test');

    const r2 = await fcm.send({ ...message, tokens: [{ id: 'd', token: 'busy' }] });
    expect(r2).toMatchObject({ sent: 0, retryable: true, error: { code: 'UNAVAILABLE' } });
    // OAuth token cached: one token request in total.
    expect(fetchMock.mock.calls.filter(([u]) => u.startsWith('https://oauth2')).length).toBe(1);
  });

  it('a non-retryable rejection is permanent; network errors are retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.startsWith('https://oauth2')
          ? Promise.resolve(json(200, { access_token: 'x', expires_in: 3600 }))
          : Promise.resolve(fcmError(403, 'PERMISSION_DENIED')),
      ),
    );
    const fcm = new FcmPushProvider(account, 5000, logger);
    const tokens = [{ id: 'a', token: 'ok' }];
    expect(await fcm.send({ title: 'T', body: 'B', data: {}, tokens })).toMatchObject({
      sent: 0,
      retryable: false,
      invalidTokenIds: [],
      error: { code: 'PERMISSION_DENIED' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.startsWith('https://oauth2')
          ? Promise.resolve(json(200, { access_token: 'x', expires_in: 3600 }))
          : Promise.reject(new TypeError('fetch failed')),
      ),
    );
    expect(await fcm.send({ title: 'T', body: 'B', data: {}, tokens })).toMatchObject({
      sent: 0,
      retryable: true,
      error: { code: 'NETWORK' },
    });
  });

  it('rejects a key that is not a service account', () => {
    expect(() => new FcmPushProvider(Buffer.from('{}').toString('base64'), 1000, logger)).toThrow(
      /service-account/,
    );
  });
});

describe('SMTP provider', () => {
  const smtp = (sendMail: () => Promise<unknown>) => {
    const provider = new SmtpEmailProvider(
      'smtp://u:p@localhost:2525',
      'FarmX <x@farmx.in>',
      1000,
      logger,
    );
    (provider as unknown as { transport: { sendMail: typeof sendMail } }).transport.sendMail =
      sendMail;
    return provider;
  };
  const mail = { to: 'a@b.in', subject: 's', text: 't', html: '<p>t</p>' };

  it('maps 4xx / network errors to retryable and 5xx to permanent', async () => {
    expect(await smtp(() => Promise.resolve({ messageId: '<m1>' })).send(mail)).toEqual({
      ok: true,
      providerMessageId: '<m1>',
    });
    const reject = (e: object) => () => Promise.reject(Object.assign(new Error('x'), e));
    expect(await smtp(reject({ responseCode: 421 })).send(mail)).toMatchObject({
      ok: false,
      retryable: true,
      code: 'SMTP_421',
    });
    expect(await smtp(reject({ responseCode: 550 })).send(mail)).toMatchObject({
      ok: false,
      retryable: false,
      code: 'SMTP_550',
    });
    expect(await smtp(reject({ code: 'ETIMEDOUT' })).send(mail)).toMatchObject({
      retryable: true,
      code: 'ETIMEDOUT',
    });
    expect(await smtp(reject({ code: 'EAUTH' })).send(mail)).toMatchObject({
      retryable: false,
      code: 'EAUTH',
    });
  });
});

describe('provider helpers + config', () => {
  it('times out as a value and masks addresses', async () => {
    const slow = new Promise<string>((r) =>
      setTimeout(() => {
        r('late');
      }, 200),
    );
    expect(await withTimeout(slow, 10, () => 'timeout')).toBe('timeout');
    expect(maskEmail('ravi@farm.in')).toBe('r***@farm.in');
    expect(maskPhone('+919876543210')).toBe('******3210');
  });

  it('refuses console providers in prod and needs credentials for real ones', () => {
    const prod = {
      APP_ENV: 'prod',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://t:t@localhost:5432/t',
      JWT_PUBLIC_KEY: Buffer.from('k').toString('base64'),
      INTERNAL_SERVICE_TOKEN: 'x'.repeat(40),
      FCM_SERVICE_ACCOUNT_JSON: Buffer.from('{}').toString('base64'),
      SMTP_URL: 'smtp://u:p@smtp.example.com:587',
    };
    expect(loadConfig(prod)).toMatchObject({
      PUSH_PROVIDER: 'fcm',
      EMAIL_PROVIDER: 'smtp',
      SMS_PROVIDER: 'none',
    });
    expect(() => loadConfig({ ...prod, SMS_PROVIDER: 'console' })).toThrow(
      /not allowed when APP_ENV=prod/,
    );
    expect(() => loadConfig({ ...prod, SMTP_URL: undefined })).toThrow(/SMTP_URL/);
    expect(
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://t:t@localhost:5432/t' }),
    ).toMatchObject({
      PUSH_PROVIDER: 'console',
      EMAIL_PROVIDER: 'console',
      SMS_PROVIDER: 'console',
    });
  });
});
