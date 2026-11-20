import { createSign } from 'node:crypto';

import type { Logger } from '@farmx/common/logger';

import type { PushMessage, PushProvider, PushResult, PushToken } from './types.js';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

type TokenOutcome =
  | { kind: 'sent'; id: string }
  | { kind: 'invalid'; code: string }
  | { kind: 'retry'; code: string; message: string }
  | { kind: 'failed'; code: string; message: string };

const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** FCM error codes that mean "this token will never work again" → revoke it. */
const DEAD_TOKEN = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH']);
const RETRYABLE = new Set(['UNAVAILABLE', 'INTERNAL', 'QUOTA_EXCEEDED']);

/**
 * Firebase Cloud Messaging over the HTTP v1 API (what firebase-admin calls internally), with a
 * service-account OAuth2 token (RS256 JWT → access token, cached until a minute before expiry).
 * One request per device token, in parallel (a user has ≤ 10 devices). The service-account key
 * never leaves this class and is never logged.
 */
export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  private readonly account: ServiceAccount;
  private accessToken: { value: string; expiresAt: number } | undefined;

  constructor(
    serviceAccountBase64: string,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {
    const parsed = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8')) as
      Partial<ServiceAccount> | undefined;
    if (
      typeof parsed?.project_id !== 'string' ||
      typeof parsed.client_email !== 'string' ||
      typeof parsed.private_key !== 'string'
    )
      throw new Error('FCM_SERVICE_ACCOUNT_JSON is not a Firebase service-account key');
    this.account = parsed as ServiceAccount;
  }

  async send(message: PushMessage): Promise<PushResult> {
    let token: string;
    try {
      token = await this.oauthToken();
    } catch (err) {
      this.logger.warn({ err }, 'FCM OAuth token request failed');
      return failure(message.tokens, true, 'AUTH_UNAVAILABLE', 'FCM OAuth token request failed');
    }
    const outcomes = await Promise.all(message.tokens.map((t) => this.sendOne(token, t, message)));
    const sent = outcomes.filter((o) => o.kind === 'sent');
    const firstError = outcomes.find((o) => o.kind === 'retry' || o.kind === 'failed');
    return {
      sent: sent.length,
      providerMessageId: sent[0]?.id ?? null,
      invalidTokenIds: message.tokens
        .filter((_, i) => outcomes[i]?.kind === 'invalid')
        .map((t) => t.id),
      retryable: outcomes.some((o) => o.kind === 'retry'),
      error:
        firstError === undefined ? null : { code: firstError.code, message: firstError.message },
    };
  }

  private async sendOne(
    accessToken: string,
    device: PushToken,
    message: PushMessage,
  ): Promise<TokenOutcome> {
    let res: Response;
    try {
      res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: device.token,
              notification: { title: message.title, body: message.body },
              data: message.data,
              android: { priority: 'HIGH' },
              apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
            },
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (err) {
      return { kind: 'retry', code: 'NETWORK', message: (err as Error).name };
    }
    if (res.ok) return { kind: 'sent', id: ((await res.json()) as { name: string }).name };
    const body = (await res.json().catch(() => ({}))) as {
      error?: { status?: string; message?: string; details?: { errorCode?: string }[] };
    };
    const code =
      body.error?.details?.find((d) => d.errorCode !== undefined)?.errorCode ??
      body.error?.status ??
      `HTTP_${String(res.status)}`;
    const text = (body.error?.message ?? '').slice(0, 200);
    if (res.status === 401) this.accessToken = undefined;
    if (DEAD_TOKEN.has(code) || (code === 'INVALID_ARGUMENT' && /token/i.test(text)))
      return { kind: 'invalid', code };
    if (RETRYABLE.has(code) || res.status === 401 || res.status === 429 || res.status >= 500)
      return { kind: 'retry', code, message: text };
    return { kind: 'failed', code, message: text };
  }

  private async oauthToken(): Promise<string> {
    if (this.accessToken !== undefined && this.accessToken.expiresAt > Date.now() + 60_000)
      return this.accessToken.value;
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: this.account.client_email,
      scope: SCOPE,
      aud: OAUTH_URL,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(this.account.private_key, 'base64url');
    const res = await fetch(OAUTH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`oauth token HTTP ${String(res.status)}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}

const failure = (
  tokens: readonly PushToken[],
  retryable: boolean,
  code: string,
  message: string,
): PushResult => ({
  sent: 0,
  providerMessageId: null,
  invalidTokenIds: [],
  retryable: retryable && tokens.length > 0,
  error: { code, message },
});
