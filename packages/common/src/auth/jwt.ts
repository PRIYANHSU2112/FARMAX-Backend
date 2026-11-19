import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

/**
 * Minimal, strict JWT (JWS compact) with EdDSA / Ed25519 on node:crypto.
 * - Only `alg: EdDSA` is accepted (no `none`, no HMAC or RSA downgrade); `kid` must match.
 * - Verifies signature, then `exp` / `nbf` / `iat` / `iss` / `aud`.
 */
export interface JwtKeys {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export class JwtError extends Error {
  constructor(readonly reason: string) {
    super(`invalid token: ${reason}`);
    this.name = 'JwtError';
  }
}

export interface JwtVerifyOptions {
  issuer: string;
  audience: string;
  /** Epoch seconds; defaults to now. */
  now?: number;
  /** Allowed clock skew in seconds. */
  clockToleranceSec?: number;
}

const MAX_TOKEN_LENGTH = 4096;
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const decodeJson = (part: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new JwtError('malformed');
  }
};

/** Loads keys from base64-encoded PEM (env). */
export function loadJwtKeys(kid: string, privatePemB64: string, publicPemB64: string): JwtKeys {
  const privateKey = createPrivateKey(Buffer.from(privatePemB64, 'base64').toString('utf8'));
  const publicKey = createPublicKey(Buffer.from(publicPemB64, 'base64').toString('utf8'));
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('JWT keys must be Ed25519');
  }
  return { kid, privateKey, publicKey };
}

/** Ephemeral keys for local development and tests only (tokens die with the process). */
export function generateJwtKeys(kid = 'ephemeral'): JwtKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { kid, privateKey, publicKey };
}

export function signJwt(payload: Record<string, unknown>, keys: JwtKeys): string {
  const signingInput = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: keys.kid })}.${encode(payload)}`;
  const signature = sign(null, Buffer.from(signingInput), keys.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

export function verifyJwt(
  token: string,
  keys: Pick<JwtKeys, 'kid' | 'publicKey'>,
  options: JwtVerifyOptions,
): Record<string, unknown> {
  if (token.length > MAX_TOKEN_LENGTH) throw new JwtError('too long');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed');
  const [headerPart = '', payloadPart = '', signaturePart = ''] = parts;

  const header = decodeJson(headerPart);
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT') throw new JwtError('unsupported algorithm');
  if (header.kid !== keys.kid) throw new JwtError('unknown key');

  const valid = verify(
    null,
    Buffer.from(`${headerPart}.${payloadPart}`),
    keys.publicKey,
    Buffer.from(signaturePart, 'base64url'),
  );
  if (!valid) throw new JwtError('bad signature');

  const claims = decodeJson(payloadPart);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.clockToleranceSec ?? 5;
  if (typeof claims.exp !== 'number' || claims.exp <= now - skew) throw new JwtError('expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + skew)
    throw new JwtError('not yet valid');
  if (typeof claims.iat === 'number' && claims.iat > now + 60)
    throw new JwtError('issued in the future');
  if (claims.iss !== options.issuer) throw new JwtError('wrong issuer');
  if (claims.aud !== options.audience) throw new JwtError('wrong audience');
  return claims;
}

/** Verify-only key (services that check tokens but never issue them). */
export function loadJwtPublicKey(
  kid: string,
  publicPemB64: string,
): Pick<JwtKeys, 'kid' | 'publicKey'> {
  const publicKey = createPublicKey(Buffer.from(publicPemB64, 'base64').toString('utf8'));
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('JWT public key must be Ed25519');
  return { kid, publicKey };
}
