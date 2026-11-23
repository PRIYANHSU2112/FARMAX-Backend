import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

/**
 * Who is on the other end of a socket. Built by the service when it issues a connect token (from
 * a verified access token), never from client frames.
 */
export interface RealtimePrincipal {
  userId: string;
  userType: string;
  /** Access-token session id: the server re-checks its revocation while the socket is open. */
  sessionId: string;
  /** Client app (CUSTOMER, VENDOR, LOGISTICS, WAREHOUSE, ADMIN). */
  app: string;
  /** Capabilities decided at issue time, e.g. `agent`. Used as delivery audiences. */
  tags: string[];
}

interface StoredToken extends RealtimePrincipal {
  aud: string;
  iat: number;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Single-use, short-lived connect tokens. Browsers cannot send an `Authorization` header on a
 * WebSocket upgrade, so the client first calls an authenticated REST route that issues one of
 * these, then connects with `?token=`. The token is consumed atomically (GETDEL): a replayed or
 * leaked token is useless after the first connect, and it expires on its own after `ttlSeconds`.
 */
export class ConnectTokens {
  constructor(
    private readonly deps: {
      redis: () => Redis;
      /** Redis key of a token. */
      key: (token: string) => string;
      /** Audience stamped on issue and required on consume (one per socket endpoint). */
      audience: string;
      ttlSeconds?: number;
    },
  ) {}

  get ttlSeconds(): number {
    return this.deps.ttlSeconds ?? 60;
  }

  async issue(principal: RealtimePrincipal): Promise<{ token: string; expiresIn: number }> {
    const token = randomBytes(32).toString('base64url');
    const stored: StoredToken = {
      ...principal,
      aud: this.deps.audience,
      iat: Math.floor(Date.now() / 1000),
    };
    await this.deps
      .redis()
      .set(this.deps.key(token), JSON.stringify(stored), 'EX', this.ttlSeconds);
    return { token, expiresIn: this.ttlSeconds };
  }

  /** Returns the principal once; null when unknown, used, expired or for another audience. */
  async consume(token: string): Promise<RealtimePrincipal | null> {
    if (!TOKEN.test(token)) return null;
    const raw = await this.deps.redis().getdel(this.deps.key(token));
    if (raw === null) return null;
    const stored = JSON.parse(raw) as StoredToken;
    if (stored.aud !== this.deps.audience) return null;
    return {
      userId: stored.userId,
      userType: stored.userType,
      sessionId: stored.sessionId,
      app: stored.app,
      tags: stored.tags,
    };
  }
}
