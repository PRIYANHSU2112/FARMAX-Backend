/**
 * Prints fresh secrets for auth-service to paste into `.env` (never commit them).
 *
 *   pnpm --filter @farmx/auth-service keys:generate
 *
 * - JWT_PRIVATE_KEY / JWT_PUBLIC_KEY: Ed25519 (EdDSA) keypair, base64-encoded PEM.
 * - JWT_KEY_ID: rotate by issuing a new id with a new keypair.
 * - OTP_PEPPER: HMAC secret for OTP codes and identifier hashes.
 * - MFA_ENCRYPTION_KEY: AES-256-GCM key (32 bytes) for TOTP secrets. Changing it makes existing
 *   authenticator enrolments unreadable — keep it stable per environment.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pem = (key: typeof privateKey, type: 'pkcs8' | 'spki') =>
  Buffer.from(key.export({ format: 'pem', type }).toString()).toString('base64');

const lines = [
  `JWT_KEY_ID=${new Date().toISOString().slice(0, 7)}-${randomBytes(3).toString('hex')}`,
  `JWT_PRIVATE_KEY=${pem(privateKey, 'pkcs8')}`,
  `JWT_PUBLIC_KEY=${pem(publicKey, 'spki')}`,
  `OTP_PEPPER=${randomBytes(32).toString('hex')}`,
  `MFA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
];
process.stdout.write(`${lines.join('\n')}\n`);
