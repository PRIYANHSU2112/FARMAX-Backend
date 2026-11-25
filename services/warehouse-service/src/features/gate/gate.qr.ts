import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** What a gate pass QR carries (no PII). */
export interface PassClaims {
  v: 1;
  kid: string;
  passId: string;
  passNo: string;
  entryId: string;
  wh: string;
  type: 'INWARD' | 'OUTWARD';
  /** Expiry, epoch seconds. */
  exp: number;
}

export interface QrKeys {
  activeKid: string;
  keys: ReadonlyMap<string, Buffer>;
}

/**
 * Gate pass QR keys (D-62 §5): a dedicated key set `GATE_PASS_QR_KEYS` ({kid: secret}) so passes
 * survive a rotation of the service token; several kids may verify, one (active) signs. Dev
 * without keys: one key derived from INTERNAL_SERVICE_TOKEN with HKDF (kid "dev").
 */
export const loadQrKeys = (cfg: {
  GATE_PASS_QR_KEYS?: string;
  GATE_PASS_QR_ACTIVE_KID?: string;
  INTERNAL_SERVICE_TOKEN?: string;
}): QrKeys | null => {
  if (cfg.GATE_PASS_QR_KEYS !== undefined && cfg.GATE_PASS_QR_KEYS !== '') {
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(cfg.GATE_PASS_QR_KEYS) as Record<string, string>;
    } catch {
      throw new Error('GATE_PASS_QR_KEYS must be JSON {"kid":"secret"}');
    }
    const keys = new Map<string, Buffer>();
    for (const [kid, secret] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9_-]{1,20}$/.test(kid) || typeof secret !== 'string' || secret.length < 32)
        throw new Error(`GATE_PASS_QR_KEYS: kid "${kid}" needs a secret of ≥ 32 chars`);
      keys.set(kid, Buffer.from(secret, 'utf8'));
    }
    const activeKid = cfg.GATE_PASS_QR_ACTIVE_KID ?? [...keys.keys()][0];
    if (activeKid === undefined || !keys.has(activeKid))
      throw new Error('GATE_PASS_QR_ACTIVE_KID must name a key of GATE_PASS_QR_KEYS');
    return { activeKid, keys };
  }
  if (cfg.INTERNAL_SERVICE_TOKEN === undefined) return null;
  const derived = Buffer.from(
    hkdfSync('sha256', cfg.INTERNAL_SERVICE_TOKEN, 'farmx-gate', 'gate-pass-qr', 32),
  );
  return { activeKid: 'dev', keys: new Map([['dev', derived]]) };
};

const sign = (body: string, key: Buffer) => createHmac('sha256', key).update(body).digest();

/** `GP1.<base64url(json)>.<base64url(hmac)>` */
export const signPass = (claims: PassClaims, keys: QrKeys): string => {
  const key = keys.keys.get(claims.kid);
  if (key === undefined) throw new Error(`unknown QR kid ${claims.kid}`);
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `GP1.${body}.${sign(body, key).toString('base64url')}`;
};

export type VerifyResult =
  | { ok: true; claims: PassClaims }
  | { ok: false; reason: 'MALFORMED' | 'UNKNOWN_KEY' | 'BAD_SIGNATURE' | 'EXPIRED' };

/** Verifies signature (any configured kid) and expiry. Replay is stopped by the pass state. */
export const verifyPass = (token: string, keys: QrKeys, nowSec: number): VerifyResult => {
  if (token.length > 1024) return { ok: false, reason: 'MALFORMED' };
  const [tag, body, sig] = token.split('.');
  if (tag !== 'GP1' || body === undefined || sig === undefined)
    return { ok: false, reason: 'MALFORMED' };
  let raw: { v?: unknown; kid?: unknown };
  try {
    raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      v?: unknown;
      kid?: unknown;
    };
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (raw.v !== 1 || typeof raw.kid !== 'string') return { ok: false, reason: 'MALFORMED' };
  const claims = raw as unknown as PassClaims;
  const key = keys.keys.get(claims.kid);
  if (key === undefined) return { ok: false, reason: 'UNKNOWN_KEY' };
  const given = Buffer.from(sig, 'base64url');
  const expected = sign(body, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: 'BAD_SIGNATURE' };
  if (claims.exp < nowSec) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, claims };
};
