import { randomUUID } from 'node:crypto';

import type { Cradle } from '@fastify/awilix';

import {
  type AccessClaims,
  type JwtKeys,
  parseAccessClaims,
  signJwt,
  verifyJwt,
} from '@farmx/common/auth';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  type AccessTokenInput,
  ENROLMENT_TOKEN_TTL_SECONDS,
  type IssuedAccessToken,
  type Jwks,
} from './tokens.types.js';

/** Public API of the tokens feature: issues and verifies EdDSA access tokens, serves the JWKS. */
export class TokensService {
  private readonly keys: JwtKeys;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwks: Jwks;

  constructor({ jwtKeys, config }: Pick<Cradle, 'jwtKeys' | 'config'>) {
    this.keys = jwtKeys;
    this.issuer = config.JWT_ISSUER;
    this.audience = config.JWT_AUDIENCE;
    const jwk = jwtKeys.publicKey.export({ format: 'jwk' });
    this.jwks = { keys: [{ ...jwk, kid: jwtKeys.kid, alg: 'EdDSA', use: 'sig' }] };
  }

  issueAccessToken(input: AccessTokenInput): IssuedAccessToken {
    const ttl = input.scope === 'full' ? ACCESS_TOKEN_TTL_SECONDS : ENROLMENT_TOKEN_TTL_SECONDS;
    const now = Math.floor(Date.now() / 1000);
    const jti = randomUUID();
    const accessToken = signJwt(
      {
        iss: this.issuer,
        aud: this.audience,
        sub: input.userId,
        sid: input.sessionId,
        jti,
        typ: input.userType,
        roles: [...input.roles],
        scope: input.scope,
        iat: now,
        exp: now + ttl,
      },
      this.keys,
    );
    return { accessToken, jti, expiresAt: now + ttl, expiresIn: ttl };
  }

  /** Signature + standard claims + shape. Throws JwtError. Revocation is checked by the verifier. */
  verifyAccessToken(token: string): AccessClaims {
    return parseAccessClaims(
      verifyJwt(token, this.keys, { issuer: this.issuer, audience: this.audience }),
    );
  }

  getJwks(): Jwks {
    return this.jwks;
  }
}
