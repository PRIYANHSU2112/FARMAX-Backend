import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * PII protection (proposed D-24): AES-256-GCM for values we must read back (PAN), keyed HMAC for
 * equality lookups (dedupe) and for signing Farm-pass QR payloads. Keys never leave this object.
 */
export class PiiCrypto {
  private readonly encKey: Buffer;
  private readonly hmacKey: Buffer;
  /** Stored next to every ciphertext so keys can be rotated later. */
  readonly keyId = 1;

  constructor(encKeyBase64: string, hmacKey: string) {
    this.encKey = Buffer.from(encKeyBase64, 'base64');
    if (this.encKey.length !== 32) throw new Error('FARM_PII_ENC_KEY must be 32 bytes (base64)');
    this.hmacKey = Buffer.from(hmacKey, 'utf8');
  }

  /** Ephemeral keys for local/test runs only (data encrypted with them dies with the process). */
  static ephemeral(): PiiCrypto {
    return new PiiCrypto(randomBytes(32).toString('base64'), randomBytes(32).toString('hex'));
  }

  /** iv(12) | tag(16) | ciphertext */
  encrypt(plain: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  decrypt(blob: Uint8Array): string {
    const buf = Buffer.from(blob);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, buf.subarray(0, IV_BYTES));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Hex HMAC-SHA256 with a purpose prefix, e.g. hash('pan', 'AKLPK7741Q'). */
  hash(purpose: string, value: string): string {
    return createHmac('sha256', this.hmacKey).update(`${purpose}:${value}`).digest('hex');
  }

  /** Constant-time check of a signature produced by `hash`. */
  verify(purpose: string, value: string, signature: string): boolean {
    const expected = Buffer.from(this.hash(purpose, value), 'hex');
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
